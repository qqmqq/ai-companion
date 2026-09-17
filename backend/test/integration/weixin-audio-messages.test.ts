import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWeixinMediaStack, type WeixinMediaStack } from "../helpers/weixin-media-stack.ts";
import { inboundVoiceMessage } from "../helpers/mock-weixin-server.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyToProtocolBase64 } from "../../src/channels/weixin/media/aes-media.ts";
import { createVoiceCodec, isSilkBytes, isWavBytes, pcmToWav, readWavFormat, VOICE_SAMPLE_RATE } from "../../src/channels/weixin/media/voice-codec.ts";
import { CDN_ENCRYPT_TYPE_PACKED } from "../../src/channels/weixin/protocol/media-types.ts";
import { ITEM_TYPE_VOICE } from "../../src/channels/weixin/protocol/types.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { partsToText } from "../../src/core/model/message.ts";
import type { AudioPart, InternalMessage, InternalResponse, OutboundPart } from "../../src/core/model/message.ts";
import type { MediaReference } from "../../src/core/model/media.ts";

const codec = createVoiceCodec();

/** 1 秒 24 kHz 单声道 16bit 正弦波 */
function pcm(samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(12000 * Math.sin((2 * Math.PI * 440 * index) / VOICE_SAMPLE_RATE));
    view.setInt16(index * 2, value, true);
  }
  return out;
}

function wav(seconds: number): Uint8Array {
  return pcmToWav(pcm(Math.floor(seconds * VOICE_SAMPLE_RATE)));
}

/** 含 0x00 / 0x01 / 0x7F / 0x80 / 0xFE / 0xFF 的任意二进制 */
function binaryBytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(randomBytes(size));
  bytes[0] = 0x00;
  bytes[1] = 0x01;
  bytes[2] = 0x7f;
  bytes[3] = 0x80;
  bytes[4] = 0xfe;
  bytes[5] = 0xff;
  bytes[size - 1] = 0x00;
  return bytes;
}

function mediaRef(overrides: Partial<MediaReference> = {}): MediaReference {
  return {
    mediaId: null,
    mimeType: null,
    filename: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    origin: "generated",
    status: "available",
    url: null,
    ...overrides,
  };
}

function outbound(accountId: string, parts: OutboundPart[], idempotencyKey = "idem-audio-1"): InternalResponse {
  return {
    channel: "weixin",
    accountId,
    conversationId: "user-audio",
    parts,
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey,
  };
}

async function stash(stack: WeixinMediaStack, bytes: Uint8Array, mimeType: string | null): Promise<MediaReference> {
  const asset = await stack.mediaStorage.put({ bytes, mimeType, filename: null, origin: "generated" });
  return mediaRef({ mediaId: asset.mediaId, mimeType, sizeBytes: asset.sizeBytes, url: { kind: "internal", value: "media:" + asset.mediaId } });
}

function noSecretsInLogs(stack: WeixinMediaStack, secrets: string[]): void {
  const joined = stack.logLines.join("\n");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    assert.equal(joined.includes(secret), false, "日志中不允许出现敏感值：" + secret.slice(0, 12) + "…");
  }
}

test("inbound voice: CDN → decrypt → SILK decode → WAV in MediaStorage → AudioPart available with real duration", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const silk = (await codec.toSilk(wav(1))).bytes;
    const cipher = encryptMedia(silk, key);
    stack.cdn.stored.set("voice-param-1", Buffer.from(cipher));

    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({
            messageId: "voice-1001",
            fromUserId: "user-audio",
            encryptQueryParam: "voice-param-1",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            contextToken: "ctx-audio-1",
          }),
        ],
        buffer: "buf-audio-1",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 1);
    assert.equal(outcome.committed, true);

    const message = seen[0]!;
    assert.equal(message.type, "audio");
    const part = message.parts[0]!;
    assert.equal(part.kind, "audio");
    const media = (part as AudioPart).media;
    assert.equal(media.status, "available");
    assert.match(String(media.mediaId), /^[0-9a-f]{32}$/);
    assert.equal(media.mimeType, "audio/wav", "入库的是可用音频（WAV），不是密文、也不是 SILK 明文");
    assert.equal(media.width, null);
    assert.equal(media.height, null);
    assert.ok(media.durationMs !== null && media.durationMs >= 1000, "时长来自编解码器，不是猜的：" + String(media.durationMs));
    assert.equal((part as AudioPart).transcript, undefined, "本阶段不生成转写（没有 ASR）");

    // 入库字节是"确定性解码"的结果，且绝不是 CDN 上的密文
    const stored = await stack.mediaStorage.get(String(media.mediaId));
    assert.ok(stored !== null);
    const expected = await codec.silkToWav(silk);
    assert.equal(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(expected.bytes)), 0, "落库 WAV 必须等于确定性解码结果");
    assert.equal(isWavBytes(stored.bytes), true);
    assert.equal(isSilkBytes(stored.bytes), false);
    assert.notEqual(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(silk)), 0, "落库的不能是 SILK 原文");
    const format = readWavFormat(stored.bytes);
    assert.equal(format?.sampleRate, VOICE_SAMPLE_RATE);
    assert.equal(format?.channels, 1);
    assert.equal(format?.bitsPerSample, 16);

    assert.equal(partsToText(message.parts).includes("语音") || partsToText(message.parts).length > 0, true);
    assert.equal(JSON.stringify(message).includes("voice-param-1"), false, "协议参数不能进入消息");
    assert.equal(JSON.stringify(message).includes("[object Object]"), false);
  } finally {
    await stack.close();
  }
});

test("inbound voice without a codec keeps the raw bytes losslessly (R6 degradation)", async () => {
  const unavailable = createVoiceCodec({
    load: async () => {
      throw new Error("silk-wasm missing");
    },
  });
  const stack = await createWeixinMediaStack({ voiceCodec: unavailable });
  try {
    const key = generateMediaKey();
    // 任意二进制 + 合法 SILK 头：编解码不可用时必须**原样**保存
    const raw = binaryBytes(2048);
    raw.set([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33], 0);
    stack.cdn.stored.set("voice-raw-1", Buffer.from(encryptMedia(raw, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({
            messageId: "voice-raw-1",
            fromUserId: "user-audio",
            encryptQueryParam: "voice-raw-1",
            mediaAesKey: mediaKeyToProtocolBase64(key),
          }),
        ],
        buffer: "buf-audio-2",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });
    await stack.channel.pollOnce(stack.accountId);

    const media = (seen[0]!.parts[0] as AudioPart).media;
    assert.equal(media.status, "available", "缺编解码不能丢数据");
    assert.equal(media.mimeType, "audio/silk");
    assert.equal(media.durationMs, null, "没有解码就没有时长，绝不编造");
    const stored = await stack.mediaStorage.get(String(media.mediaId));
    assert.equal(Buffer.compare(Buffer.from(stored!.bytes), Buffer.from(raw)), 0, "原始字节必须逐字节保留");
  } finally {
    await stack.close();
  }
});

test("inbound voice failures are isolated: message still arrives, only that audio is failed", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    stack.cdn.stored.set("voice-ok", Buffer.from(encryptMedia((await codec.toSilk(wav(1))).bytes, key)));
    // 下载解密都成功、但内容根本不是 SILK（语音消息里塞了别的字节）→ 必须失败，而不是入库一堆垃圾
    const notSilk = new TextEncoder().encode("this is definitely not a silk payload at all, just text bytes");
    stack.cdn.stored.set("voice-corrupt", Buffer.from(encryptMedia(notSilk, key)));

    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({ messageId: "bad-a1", fromUserId: "user-audio", encryptQueryParam: "voice-ok" }),
          inboundVoiceMessage({ messageId: "bad-a2", fromUserId: "user-audio", encryptQueryParam: "nope", mediaAesKey: mediaKeyToProtocolBase64(key) }),
          inboundVoiceMessage({ messageId: "bad-a3", fromUserId: "user-audio", encryptQueryParam: "voice-ok", mediaAesKey: mediaKeyToProtocolBase64(generateMediaKey()) }),
          inboundVoiceMessage({ messageId: "bad-a4", fromUserId: "user-audio", encryptQueryParam: "voice-corrupt", mediaAesKey: mediaKeyToProtocolBase64(key) }),
          inboundVoiceMessage({ messageId: "ok-a1", fromUserId: "user-audio", encryptQueryParam: "voice-ok", mediaAesKey: mediaKeyToProtocolBase64(key) }),
        ],
        buffer: "buf-audio-3",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 5, "损坏的语音不能让整批消息消失");
    for (const index of [0, 1, 2, 3]) {
      const media = (seen[index]!.parts[0] as AudioPart).media;
      assert.equal(media.status, "failed", "第 " + (index + 1) + " 条应当是 failed");
      assert.equal(media.mediaId, null);
    }
    const okMedia = (seen[4]!.parts[0] as AudioPart).media;
    assert.equal(okMedia.status, "available");
    assert.equal((await stack.mediaStorage.get(String(okMedia.mediaId))) !== null, true);
  } finally {
    await stack.close();
  }
});

test("outbound WAV: storage → SILK encode → upload → voice_item, and the ciphertext decodes back to valid audio", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const sourceWav = wav(1);
    const reference = await stash(stack, sourceWav, "audio/wav");

    const receipt = await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));

    const uploadCall = stack.server.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
    assert.ok(uploadCall !== undefined);
    const body = uploadCall.body as Record<string, unknown>;
    assert.equal(body.media_type, 4, "语音是 media_type 4");
    assert.ok(Number(body.rawsize) > 0);

    const sent = stack.server.sentMessages.at(-1)!;
    assert.equal(sent.client_id, "idem-audio-1:voice:0", "语音的幂等键使用协议名 voice");
    const item = sent.items[0]!;
    assert.equal(item.type, ITEM_TYPE_VOICE);
    const voiceItem = item.voice_item as { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }; voice_size?: unknown };
    assert.equal(voiceItem.media.encrypt_type, CDN_ENCRYPT_TYPE_PACKED);
    assert.equal(voiceItem.voice_size, undefined, "协议没有语音大小字段：不发明");

    // CDN 上必须是 SILK（微信要的格式），而且是可解码的
    const cipher = stack.cdn.stored.get(voiceItem.media.encrypt_query_param);
    assert.ok(cipher !== undefined);
    const uploaded = decryptMedia(new Uint8Array(cipher), mediaKeyFromWire(voiceItem.media.aes_key));
    assert.equal(isSilkBytes(uploaded), true, "上传的必须是 SILK");
    assert.notEqual(Buffer.compare(Buffer.from(uploaded), Buffer.from(sourceWav)), 0, "绝不能把 WAV 原样当语音上传");
    const decodedBack = await codec.silkToWav(uploaded);
    assert.ok(decodedBack.durationMs >= 1000 && decodedBack.durationMs <= 1000 + 40, "解码回 1 秒音频（帧量化容差内）");
    assert.ok(readWavFormat(decodedBack.bytes) !== null);

    assert.equal(receipt.providerMessageId, "srv-1");
    noSecretsInLogs(stack, [
      "token-media-A",
      voiceItem.media.encrypt_query_param,
      voiceItem.media.aes_key,
      Buffer.from(sourceWav).toString("base64"),
      Buffer.from(sourceWav).toString("hex"),
      Buffer.from(uploaded).toString("base64"),
    ]);
  } finally {
    await stack.close();
  }
});

test("outbound SILK is uploaded byte-for-byte (raw transport is lossless, no re-encoding)", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const silk = (await codec.toSilk(wav(0.5))).bytes;
    const reference = await stash(stack, silk, "audio/silk");

    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));

    const voiceItem = stack.server.sentMessages.at(-1)!.items[0]!.voice_item as { media: { encrypt_query_param: string; aes_key: string } };
    const cipher = stack.cdn.stored.get(voiceItem.media.encrypt_query_param)!;
    const uploaded = decryptMedia(new Uint8Array(cipher), mediaKeyFromWire(voiceItem.media.aes_key));
    assert.equal(Buffer.compare(Buffer.from(uploaded), Buffer.from(silk)), 0, "已经是 SILK 时必须逐字节一致");
  } finally {
    await stack.close();
  }
});

test("outbound audio rejects unusable or unconvertible media before any network call", async () => {
  const stack = await createWeixinMediaStack();
  try {
    // 外部 URL：绝不自动抓取（SSRF 防护）
    await assert.rejects(
      () =>
        stack.channel.send(
          outbound(stack.accountId, [
            { kind: "audio", media: mediaRef({ origin: "external", url: { kind: "external", value: "http://example.com/a.mp3" } }) },
          ]),
        ),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );
    // 没有 mediaId
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: mediaRef() }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );
    // 存储未命中 / 非法 id
    for (const mediaId of ["c".repeat(32), "../../etc/passwd"]) {
      await assert.rejects(
        () => stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: mediaRef({ mediaId }) }])),
        (error: unknown) => error instanceof DomainError && error.code === "not_found",
      );
    }
    // MP3（本阶段没有通用解码器）→ 明确拒绝，而不是把 MP3 当 PCM 乱编
    const mp3ish = new Uint8Array(binaryBytes(512));
    mp3ish[0] = 0x49;
    mp3ish[1] = 0x44;
    mp3ish[2] = 0x33; // "ID3"
    const mp3 = await stack.mediaStorage.put({ bytes: mp3ish, mimeType: "audio/mpeg", filename: null, origin: "generated" });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: mediaRef({ mediaId: mp3.mediaId }) }])),
      (error: unknown) => {
        assert.ok(error instanceof DomainError && error.code === "invalid_input");
        assert.match((error as Error).message, /只支持 SILK 与 WAV/);
        return true;
      },
    );
    // 空音频
    const empty = await stack.mediaStorage.put({ bytes: new Uint8Array(0), mimeType: "audio/wav", filename: null, origin: "generated" });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: mediaRef({ mediaId: empty.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /empty/.test(error.message),
    );
    // 声明与实际容器矛盾（声明 wav、内容是 SILK）
    const silkDeclaredWav = await stack.mediaStorage.put({
      bytes: (await codec.toSilk(wav(0.2))).bytes,
      mimeType: "audio/wav",
      filename: null,
      origin: "generated",
    });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: mediaRef({ mediaId: silkDeclaredWav.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /mime_mismatch/.test(error.message),
    );

    assert.equal(stack.server.calls.filter((call) => call.path.includes("getuploadurl") || call.path.includes("sendmessage")).length, 0);
    assert.equal(stack.cdn.uploads.length, 0);
  } finally {
    await stack.close();
  }
});

test("outbound audio without a codec fails loudly instead of sending something wrong", async () => {
  const unavailable = createVoiceCodec({
    load: async () => {
      throw new Error("silk-wasm missing");
    },
  });
  const stack = await createWeixinMediaStack({ voiceCodec: unavailable });
  try {
    const reference = await stash(stack, wav(0.2), "audio/wav");
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }])),
      (error: unknown) => {
        assert.ok(error instanceof DomainError && error.code === "channel_unavailable");
        assert.match((error as Error).message, /SILK 编解码不可用/);
        return true;
      },
    );
    assert.equal(stack.cdn.uploads.length, 0, "不能上传半成品");

    // 但"已经是 SILK"的媒体在无编解码器时依然可以原样发送（不需要转码）
    const silkRef = await stash(stack, (await codec.toSilk(wav(0.2))).bytes, "audio/silk");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: silkRef }]));
    assert.equal(stack.cdn.uploads.length, 1);
  } finally {
    await stack.close();
  }
});

test("mixed parts keep their order, and each kind counts its own idempotency key", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const voiceA = await stash(stack, wav(0.2), "audio/wav");
    const voiceB = await stash(stack, (await codec.toSilk(wav(0.2))).bytes, "audio/silk");
    const file = await stash(stack, binaryBytes(64), "application/zip");

    await stack.channel.send(
      outbound(
        stack.accountId,
        [
          { kind: "text", text: "两段语音和一个文件" },
          { kind: "audio", media: voiceA },
          { kind: "file", media: file },
          { kind: "audio", media: voiceB },
        ],
        "idem-mix",
      ),
    );

    assert.deepEqual(stack.server.sentMessages.map((entry) => entry.client_id), [
      "idem-mix",
      "idem-mix:voice:0",
      "idem-mix:file:0",
      "idem-mix:voice:1",
    ]);
    assert.deepEqual(stack.server.sentMessages.slice(1).map((entry) => entry.items[0]?.type), [ITEM_TYPE_VOICE, 4, ITEM_TYPE_VOICE]);
  } finally {
    await stack.close();
  }
});

test("audio send retries transient failures, and errcode -14 marks the credential invalid", async () => {
  const transient = await createWeixinMediaStack();
  try {
    const reference = await stash(transient, wav(0.2), "audio/wav");
    transient.server.config.sendFailures = 1;
    await transient.channel.send(outbound(transient.accountId, [{ kind: "audio", media: reference }]));
    const attempts = transient.server.calls.filter((call) => call.path.endsWith("/ilink/bot/sendmessage")).length;
    assert.equal(attempts, 2, "第一次失败后必须重试");
    assert.equal(transient.server.sentMessages[0]?.client_id, "idem-audio-1:voice:0", "重试复用同一个幂等键");
  } finally {
    await transient.close();
  }

  const stale = await createWeixinMediaStack();
  try {
    const reference = await stash(stale, wav(0.2), "audio/wav");
    stale.server.config.sendOverride = { ret: 0, errcode: -14, errmsg: "session timeout" };
    await assert.rejects(
      () => stale.channel.send(outbound(stale.accountId, [{ kind: "audio", media: reference }])),
      (error: unknown) => error instanceof DomainError && error.code === "channel_unavailable",
    );
    assert.equal(stale.server.sentMessages.length, 1, "-14 不重试");
    assert.equal((await stale.channel.health()).state, "degraded");
  } finally {
    await stale.close();
  }
});

test("audio pipeline never logs credentials, keys, params or audio bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const silk = (await codec.toSilk(wav(0.5))).bytes;
    stack.cdn.stored.set("voice-log", Buffer.from(encryptMedia(silk, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({
            messageId: "voice-log-1",
            fromUserId: "user-audio",
            encryptQueryParam: "voice-log",
            mediaAesKey: mediaKeyToProtocolBase64(key),
          }),
        ],
        buffer: "buf-audio-log",
      },
    ]);
    stack.channel.onInbound(async () => {});
    await stack.channel.pollOnce(stack.accountId);

    const reference = await stash(stack, wav(0.5), "audio/wav");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));

    const voiceItem = stack.server.sentMessages.at(-1)!.items[0]!.voice_item as { media: { aes_key: string; encrypt_query_param: string } };
    noSecretsInLogs(stack, [
      "token-media-A",
      "voice-log",
      voiceItem.media.aes_key,
      voiceItem.media.encrypt_query_param,
      mediaKeyToProtocolBase64(key),
      Buffer.from(silk).toString("base64"),
      Buffer.from(silk).toString("hex"),
      Buffer.from(wav(0.5)).toString("base64"),
    ]);
  } finally {
    await stack.close();
  }
});

/** 把协议里的 aes_key 还原成 16 字节密钥（仅测试用，与实现共用同一份解码约定）。 */
function mediaKeyFromWire(value: string): Uint8Array {
  const hex = Buffer.from(value, "base64").toString("utf8");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

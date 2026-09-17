import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeixinMediaStack, type WeixinMediaStack } from "../helpers/weixin-media-stack.ts";
import { inboundTextMessage, inboundVoiceMessage } from "../helpers/mock-weixin-server.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyToProtocolBase64 } from "../../src/channels/weixin/media/aes-media.ts";
import { UPLOAD_MEDIA_TYPE_VOICE } from "../../src/channels/weixin/protocol/media-types.ts";
import { createVoiceCodec, isSilkBytes, isWavBytes, pcmToWav, VOICE_SAMPLE_RATE } from "../../src/channels/weixin/media/voice-codec.ts";
import { CDN_ENCRYPT_TYPE_PACKED } from "../../src/channels/weixin/protocol/media-types.ts";
import { ITEM_TYPE_FILE, ITEM_TYPE_VOICE } from "../../src/channels/weixin/protocol/types.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { MEDIA_LIMITS } from "../../src/core/model/media.ts";
import type { AudioPart, InternalMessage, InternalResponse, OutboundPart } from "../../src/core/model/message.ts";
import type { MediaReference } from "../../src/core/model/media.ts";

const codec = createVoiceCodec();

function pcm(samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(12000 * Math.sin((2 * Math.PI * 440 * index) / VOICE_SAMPLE_RATE)), true);
  }
  return out;
}

const wav = (seconds: number): Uint8Array => pcmToWav(pcm(Math.floor(seconds * VOICE_SAMPLE_RATE)));

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

function outbound(accountId: string, parts: OutboundPart[], idempotencyKey = "idem-d2"): InternalResponse {
  return {
    channel: "weixin",
    accountId,
    conversationId: "user-voice",
    parts,
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey,
  };
}

async function stash(stack: WeixinMediaStack, bytes: Uint8Array, mimeType: string | null, filename: string | null = null): Promise<MediaReference> {
  const asset = await stack.mediaStorage.put({ bytes, mimeType, filename, origin: "generated" });
  return mediaRef({ mediaId: asset.mediaId, mimeType, filename, sizeBytes: asset.sizeBytes, url: { kind: "internal", value: "media:" + asset.mediaId } });
}

/** 线上语音 item 允许出现的字段（多一个都算发明） */
const ALLOWED_VOICE_ITEM_KEYS = ["type", "voice_item"];
const ALLOWED_VOICE_MEDIA_KEYS = ["encrypt_query_param", "aes_key", "encrypt_type"];

test("outbound voice payload uses exactly media_type=4 / item type=3 / media{3 fields} and invents nothing", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const sourceWav = wav(1);
    const reference = await stash(stack, sourceWav, "audio/wav");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));

    const uploadCall = stack.server.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
    assert.ok(uploadCall !== undefined);
    const body = uploadCall.body as Record<string, unknown>;
    assert.equal(body.media_type, UPLOAD_MEDIA_TYPE_VOICE, "语音必须是 media_type 4");
    assert.equal(UPLOAD_MEDIA_TYPE_VOICE, 4);
    assert.equal(body.no_need_thumb, true);

    const item = stack.server.sentMessages.at(-1)!.items[0]!;
    assert.equal(item.type, ITEM_TYPE_VOICE);
    assert.equal(ITEM_TYPE_VOICE, 3);
    assert.deepEqual(Object.keys(item).sort(), [...ALLOWED_VOICE_ITEM_KEYS].sort(), "线上 item 只允许 type + voice_item");
    const voiceItem = item.voice_item as Record<string, unknown>;
    assert.deepEqual(Object.keys(voiceItem), ["media"], "voice_item 只允许 media");
    const media = voiceItem.media as Record<string, unknown>;
    assert.deepEqual(Object.keys(media).sort(), [...ALLOWED_VOICE_MEDIA_KEYS].sort());
    assert.equal(media.encrypt_type, CDN_ENCRYPT_TYPE_PACKED);

    // 协议未确认的字段一律不得出现
    for (const forbidden of ["voice_size", "size", "duration", "duration_ms", "sample_rate", "samplerate", "codec", "md5", "file_name", "len", "thumb_media"]) {
      assert.equal(forbidden in voiceItem, false, "不得发明字段：" + forbidden);
      assert.equal(forbidden in media, false, "media 里不得发明字段：" + forbidden);
    }
  } finally {
    await stack.close();
  }
});

test("voice upload carries the SILK bytes and they decrypt back into decodable audio", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const sourceWav = wav(1);
    const reference = await stash(stack, sourceWav, "audio/wav");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));

    const media = (stack.server.sentMessages.at(-1)!.items[0]!.voice_item as { media: { encrypt_query_param: string; aes_key: string } }).media;
    const cipher = stack.cdn.stored.get(media.encrypt_query_param);
    assert.ok(cipher !== undefined);
    const uploaded = decryptMedia(new Uint8Array(cipher), keyFromWire(media.aes_key));
    assert.equal(isSilkBytes(uploaded), true, "上传的必须是 SILK（不是 WAV、不是密文）");
    assert.notEqual(Buffer.compare(Buffer.from(uploaded), Buffer.from(sourceWav)), 0);

    const decoded = await codec.silkToWav(uploaded);
    assert.equal(isWavBytes(decoded.bytes), true);
    assert.ok(decoded.durationMs >= 1000 && decoded.durationMs <= 1040, "解码回 1 秒音频（SILK 20ms 帧量化容差）");
  } finally {
    await stack.close();
  }
});

test("already-SILK media is uploaded byte-for-byte (no unnecessary transcode)", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const silk = (await codec.toSilk(wav(0.5))).bytes;
    const reference = await stash(stack, silk, "audio/silk");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));

    const media = (stack.server.sentMessages.at(-1)!.items[0]!.voice_item as { media: { encrypt_query_param: string; aes_key: string } }).media;
    const uploaded = decryptMedia(new Uint8Array(stack.cdn.stored.get(media.encrypt_query_param)!), keyFromWire(media.aes_key));
    assert.equal(Buffer.compare(Buffer.from(uploaded), Buffer.from(silk)), 0, "必须是原字节，不能重编码");
  } finally {
    await stack.close();
  }
});

test("voice idempotency keys are deterministic: <key>:voice:0, <key>:voice:1", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const first = await stash(stack, wav(0.2), "audio/wav");
    const second = await stash(stack, (await codec.toSilk(wav(0.2))).bytes, "audio/silk");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: first }, { kind: "audio", media: second }], "idem-d2-multi"));
    assert.deepEqual(
      stack.server.sentMessages.map((entry) => entry.client_id),
      ["idem-d2-multi:voice:0", "idem-d2-multi:voice:1"],
    );

    // 同一响应重复发送必须复用同一组键（服务端才能去重）
    stack.server.sentMessages.length = 0;
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: first }, { kind: "audio", media: second }], "idem-d2-multi"));
    assert.deepEqual(
      stack.server.sentMessages.map((entry) => entry.client_id),
      ["idem-d2-multi:voice:0", "idem-d2-multi:voice:1"],
    );
  } finally {
    await stack.close();
  }
});

test("inbound voice maps voice_item → AudioPart(available) and stores usable WAV", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const silk = (await codec.toSilk(wav(1))).bytes;
    stack.cdn.stored.set("d2-in-1", Buffer.from(encryptMedia(silk, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({
            messageId: "d2-voice-1",
            fromUserId: "user-voice",
            encryptQueryParam: "d2-in-1",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            contextToken: "ctx-d2-1",
          }),
        ],
        buffer: "buf-d2-1",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });
    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 1);

    const message = seen[0]!;
    assert.equal(message.type, "audio");
    assert.equal(message.parts[0]!.kind, "audio");
    const media = (message.parts[0] as AudioPart).media;
    assert.equal(media.status, "available");
    assert.equal(media.mimeType, "audio/wav");
    assert.equal(media.origin, "channel");
    assert.ok(media.durationMs !== null && media.durationMs >= 1000, "时长来自真实解码");
    assert.equal((message.parts[0] as AudioPart).transcript, undefined, "没有 ASR：不生成转写");

    const stored = await stack.mediaStorage.get(String(media.mediaId));
    assert.equal(isWavBytes(stored!.bytes), true, "落库的是可用 WAV");
    assert.equal(isSilkBytes(stored!.bytes), false);

    // 消息里不能出现音频字节或协议参数
    const serialized = JSON.stringify(message);
    assert.equal(serialized.includes(Buffer.from(silk).toString("base64")), false);
    assert.equal(serialized.includes("d2-in-1"), false);
    assert.equal(serialized.includes("[object Object]"), false);
  } finally {
    await stack.close();
  }
});

test("unconfirmed voice metadata in the payload is ignored, never preserved as fact", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const silk = (await codec.toSilk(wav(1))).bytes;
    const cipher = encryptMedia(silk, key);
    stack.cdn.stored.set("d2-in-2", Buffer.from(cipher));

    // 故意塞入"看起来合理但协议未确认"的字段：必须被忽略
    stack.server.setBatches([
      {
        msgs: [
          {
            message_id: "d2-voice-2",
            from_user_id: "user-voice",
            to_user_id: "bot",
            create_time_ms: Date.now(),
            message_type: 1,
            message_state: 2,
            item_list: [
              {
                type: 3,
                voice_item: {
                  media: {
                    encrypt_query_param: "d2-in-2",
                    aes_key: mediaKeyToProtocolBase64(key),
                  },
                  voice_size: 999,
                  duration: 5000,
                  duration_ms: 5000,
                  sample_rate: 8000,
                  codec: "amr",
                },
              },
            ],
          },
        ],
        buffer: "buf-d2-2",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });
    await stack.channel.pollOnce(stack.accountId);

    const media = (seen[0]!.parts[0] as AudioPart).media;
    assert.equal(media.status, "available");
    assert.notEqual(media.sizeBytes, 999, "不得采用未确认的 voice_size");
    assert.notEqual(media.durationMs, 5000, "不得采用未确认的 duration");
    assert.ok(media.durationMs !== null && media.durationMs < 5000, "时长必须来自真实解码");
    assert.equal(isWavBytes((await stack.mediaStorage.get(String(media.mediaId)))!.bytes), true, "采样率按项目约定解码，不采用 payload 里的 sample_rate");
  } finally {
    await stack.close();
  }
});

test("truncated voice neither crashes nor corrupts the batch, and never inflates the audio", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const full = (await codec.toSilk(wav(1))).bytes;
    const truncated = full.slice(0, Math.floor(full.byteLength / 4));
    stack.cdn.stored.set("d2-trunc", Buffer.from(encryptMedia(truncated, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({
            messageId: "d2-voice-3",
            fromUserId: "user-voice",
            encryptQueryParam: "d2-trunc",
            mediaAesKey: mediaKeyToProtocolBase64(key),
          }),
          inboundTextMessage({ messageId: "d2-text-3", fromUserId: "user-voice", text: "语音之后的一条文字" }),
        ],
        buffer: "buf-d2-3",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });
    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 2, "截断的语音不能影响同批次的其它消息");
    assert.equal(outcome.committed, true);

    const voiceMedia = (seen[0]!.parts[0] as AudioPart).media;
    const fullDecoded = await codec.silkToWav(full);
    if (voiceMedia.status === "available") {
      // silk-wasm 对截断输入是"按帧尽力解码"：不能比完整解码更大
      const stored = await stack.mediaStorage.get(String(voiceMedia.mediaId));
      assert.ok(stored!.bytes.byteLength <= fullDecoded.bytes.byteLength + 44, "截断输入不允许解出更多音频");
    } else {
      assert.equal(voiceMedia.status, "failed");
      assert.equal(voiceMedia.mediaId, null);
    }
    assert.equal(seen[1]!.parts[0]!.kind, "text", "同一批次里的文字消息照常投递");
  } finally {
    await stack.close();
  }
});

test("one failed voice does not break another message in the same batch", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    stack.cdn.stored.set("d2-ok", Buffer.from(encryptMedia((await codec.toSilk(wav(0.5))).bytes, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({ messageId: "d2-bad", fromUserId: "user-voice", encryptQueryParam: "d2-ok" }), // 缺密钥
          inboundTextMessage({ messageId: "d2-text", fromUserId: "user-voice", text: "下一条消息" }),
          inboundVoiceMessage({ messageId: "d2-good", fromUserId: "user-voice", encryptQueryParam: "d2-ok", mediaAesKey: mediaKeyToProtocolBase64(key) }),
        ],
        buffer: "buf-d2-4",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });
    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 3);
    assert.equal((seen[0]!.parts[0] as AudioPart).media.status, "failed");
    assert.equal(seen[1]!.parts[0]!.kind, "text");
    assert.equal((seen[2]!.parts[0] as AudioPart).media.status, "available");
  } finally {
    await stack.close();
  }
});

test("size limits: oversized audio is rejected at the storage gate with zero network activity", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const callsBefore = stack.server.calls.length + stack.cdn.uploads.length + stack.cdn.downloads.length;

    // 第一道闸门：存储层复用 4.5-B 的 MEDIA_LIMITS，超限直接拒收（连落盘都不做）
    await assert.rejects(
      () => stack.mediaStorage.put({ bytes: new Uint8Array(MEDIA_LIMITS.maxMediaBytes + 1), mimeType: "audio/wav", filename: null, origin: "generated" }),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );
    assert.equal(stack.server.calls.length + stack.cdn.uploads.length + stack.cdn.downloads.length, callsBefore, "被拒绝的超大音频不产生任何网络调用");

    // 第二道闸门在出站校验里（validateAudio）：边界行为由 test/unit/audio-validation.test.ts 覆盖
    //（0 字节拒绝、正好等于上限放行、上限 + 1 拒绝）；这里确认正常大小的语音仍然照常发送（对照组）
    const ok = await stash(stack, wav(0.2), "audio/wav");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: ok }]));
    assert.equal(stack.server.sentMessages.length, 1);
    assert.equal(stack.server.sentMessages[0]?.client_id, "idem-d2:voice:0");
  } finally {
    await stack.close();
  }
});

test("file-audio fallback: the same audio can be sent through the file path (manual, not automatic)", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const sourceWav = wav(0.5);
    const reference = await stash(stack, sourceWav, "audio/wav", "voice.wav");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: reference }], "idem-d2-fallback"));

    const sent = stack.server.sentMessages.at(-1)!;
    assert.equal(sent.client_id, "idem-d2-fallback:file:0");
    const item = sent.items[0]!;
    assert.equal(item.type, ITEM_TYPE_FILE, "fallback 走既有文件路径（音频仍可用通用媒体架构发送）");
    const fileItem = item.file_item as { file_name: string; media: { encrypt_query_param: string; aes_key: string } };
    assert.equal(fileItem.file_name, "voice.wav");
    const uploaded = decryptMedia(new Uint8Array(stack.cdn.stored.get(fileItem.media.encrypt_query_param)!), keyFromWire(fileItem.media.aes_key));
    assert.equal(Buffer.compare(Buffer.from(uploaded), Buffer.from(sourceWav)), 0, "fallback 不做 SILK 转码，字节原样");
    const uploadCall = stack.server.calls.filter((call) => call.path.endsWith("/ilink/bot/getuploadurl")).at(-1);
    assert.equal((uploadCall?.body as { media_type?: number }).media_type, 3, "文件是 media_type 3");
  } finally {
    await stack.close();
  }
});

test("voice logs never contain credentials, keys, params or audio bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const silk = (await codec.toSilk(wav(0.5))).bytes;
    stack.cdn.stored.set("d2-log", Buffer.from(encryptMedia(silk, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVoiceMessage({ messageId: "d2-log-1", fromUserId: "user-voice", encryptQueryParam: "d2-log", mediaAesKey: mediaKeyToProtocolBase64(key) }),
        ],
        buffer: "buf-d2-log",
      },
    ]);
    stack.channel.onInbound(async () => {});
    await stack.channel.pollOnce(stack.accountId);

    const reference = await stash(stack, wav(0.5), "audio/wav");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "audio", media: reference }]));
    const media = (stack.server.sentMessages.at(-1)!.items[0]!.voice_item as { media: { aes_key: string; encrypt_query_param: string } }).media;

    const joined = stack.logLines.join("\n");
    for (const secret of [
      "token-media-A",
      "d2-log",
      media.aes_key,
      media.encrypt_query_param,
      mediaKeyToProtocolBase64(key),
      Buffer.from(silk).toString("base64"),
      Buffer.from(silk).toString("hex"),
      Buffer.from(wav(0.5)).toString("base64"),
    ]) {
      assert.equal(joined.includes(secret), false, "日志中不允许出现敏感值：" + secret.slice(0, 12) + "…");
    }
  } finally {
    await stack.close();
  }
});

/** 把协议里的 aes_key 还原成 16 字节密钥（仅测试用）。 */
function keyFromWire(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(Buffer.from(value, "base64").toString("utf8"), "hex"));
}

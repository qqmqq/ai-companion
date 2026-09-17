import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWeixinMediaStack, type WeixinMediaStack } from "../helpers/weixin-media-stack.ts";
import { inboundVideoMessage } from "../helpers/mock-weixin-server.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyToProtocolBase64 } from "../../src/channels/weixin/media/aes-media.ts";
import { CDN_ENCRYPT_TYPE_PACKED } from "../../src/channels/weixin/protocol/media-types.ts";
import { ITEM_TYPE_VIDEO } from "../../src/channels/weixin/protocol/types.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { partsToText } from "../../src/core/model/message.ts";
import type { InternalMessage, InternalResponse, OutboundPart, VideoPart } from "../../src/core/model/message.ts";
import { MEDIA_LIMITS, type MediaReference } from "../../src/core/model/media.ts";

/** 含 0x00 / 0xFF / 0x01 / 0x80 的二进制：视频绝不能被当成文本处理 */
function binaryBytes(size = 65536): Uint8Array {
  const bytes = binaryBytesRaw(size);
  bytes[0] = 0x00;
  bytes[1] = 0xff;
  bytes[2] = 0x01;
  bytes[3] = 0x80;
  bytes[size - 1] = 0x00;
  return bytes;
}

function binaryBytesRaw(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

/** 最小 MP4 头：ISO BMFF（偏移 4 起 "ftyp"），后面跟任意字节 */
function mp4Bytes(size = 4096): Uint8Array {
  const bytes = binaryBytes(size);
  bytes[4] = 0x66;
  bytes[5] = 0x74;
  bytes[6] = 0x79;
  bytes[7] = 0x70;
  return bytes;
}

/** 最小 WebM 头：EBML（0x1A45DFA3） */
function webmBytes(size = 4096): Uint8Array {
  const bytes = binaryBytes(size);
  bytes[0] = 0x1a;
  bytes[1] = 0x45;
  bytes[2] = 0xdf;
  bytes[3] = 0xa3;
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

function outbound(accountId: string, parts: OutboundPart[], idempotencyKey = "idem-video-1"): InternalResponse {
  return {
    channel: "weixin",
    accountId,
    conversationId: "user-video",
    parts,
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey,
  };
}

async function stash(
  stack: WeixinMediaStack,
  bytes: Uint8Array,
  mimeType: string | null,
  filename: string | null = null,
): Promise<MediaReference> {
  const asset = await stack.mediaStorage.put({ bytes, mimeType, filename, origin: "generated" });
  return mediaRef({ mediaId: asset.mediaId, mimeType, filename, sizeBytes: asset.sizeBytes, url: { kind: "internal", value: "media:" + asset.mediaId } });
}

function noSecretsInLogs(stack: WeixinMediaStack, secrets: string[]): void {
  const joined = stack.logLines.join("\n");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    assert.equal(joined.includes(secret), false, "日志中不允许出现敏感值：" + secret.slice(0, 12) + "…");
  }
}

test("inbound video: download → decrypt → validate → MediaStorage → VideoPart available, binary identical", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const bytes = mp4Bytes(32768);
    const cipher = encryptMedia(bytes, key);
    stack.cdn.stored.set("video-param-1", Buffer.from(cipher));

    stack.server.setBatches([
      {
        msgs: [
          inboundVideoMessage({
            messageId: "video-1001",
            fromUserId: "user-video",
            encryptQueryParam: "video-param-1",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            videoSize: cipher.byteLength,
            // 缩略图引用存在也必须被忽略（本阶段不下载、不生成缩略图）
            thumbMedia: { encrypt_query_param: "thumb-param-1", aes_key: mediaKeyToProtocolBase64(key) },
            contextToken: "ctx-video-1",
          }),
        ],
        buffer: "buf-video-1",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 1);
    assert.equal(outcome.committed, true);
    assert.equal(seen.length, 1);

    const message = seen[0]!;
    assert.equal(message.type, "video");
    const part = message.parts[0]!;
    assert.equal(part.kind, "video");
    const media = (part as VideoPart).media;
    assert.equal(media.status, "available");
    assert.match(String(media.mediaId), /^[0-9a-f]{32}$/);
    assert.equal(media.mimeType, "application/octet-stream", "协议没有视频 MIME，走安全兜底");
    assert.equal(media.sizeBytes, bytes.byteLength);
    assert.equal(media.width, null, "协议没有宽高：绝不为了拿到它去解码视频");
    assert.equal(media.height, null);
    assert.equal(media.durationMs, null);
    assert.equal(media.origin, "channel");
    assert.equal(media.url?.kind, "internal");

    const stored = await stack.mediaStorage.get(String(media.mediaId));
    assert.ok(stored !== null);
    assert.equal(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(bytes)), 0, "落库字节必须与原文完全一致");

    // 上下文：只有占位符，不含对象字符串、不含协议参数
    assert.equal(partsToText(message.parts), "[视频]");
    assert.equal(JSON.stringify(message).includes("[object Object]"), false);
    assert.equal(JSON.stringify(message).includes("video-param-1"), false);
    // 缩略图引用绝不能被下载
    assert.equal(stack.cdn.downloads.some((entry) => entry.param === "thumb-param-1"), false);
  } finally {
    await stack.close();
  }
});

test("outbound video: storage → upload → video_item(video_size), and the ciphertext decrypts back to the original bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const bytes = mp4Bytes(16384);
    const reference = await stash(stack, bytes, "video/mp4", "clip.mp4");

    const receipt = await stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: reference }]));

    const uploadCall = stack.server.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
    assert.ok(uploadCall !== undefined);
    const body = uploadCall.body as Record<string, unknown>;
    assert.equal(body.media_type, 2, "视频的 media_type 是 2");
    assert.equal(body.rawsize, bytes.byteLength);
    assert.equal(body.no_need_thumb, true);

    const sent = stack.server.sentMessages.at(-1)!;
    assert.equal(sent.client_id, "idem-video-1:video:0");
    const item = sent.items[0]!;
    assert.equal(item.type, ITEM_TYPE_VIDEO);
    const videoItem = item.video_item as {
      media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
      video_size: number;
    };
    assert.equal(videoItem.media.encrypt_type, CDN_ENCRYPT_TYPE_PACKED);
    assert.equal(videoItem.video_size, body.filesize, "video_size 是密文长度（与图片 mid_size 同类）");
    assert.equal(videoItem.media.aes_key.length > 0, true);

    const cipher = stack.cdn.stored.get(videoItem.media.encrypt_query_param);
    assert.ok(cipher !== undefined);
    assert.equal(Buffer.compare(Buffer.from(cipher), Buffer.from(bytes)) === 0, false, "CDN 上不能是明文");
    const decrypted = decryptMedia(new Uint8Array(cipher), mediaKeyFromWire(videoItem.media.aes_key));
    assert.equal(Buffer.compare(Buffer.from(decrypted), Buffer.from(bytes)), 0, "解密后必须与原视频完全一致");
    assert.equal(receipt.providerMessageId, "srv-1");

    noSecretsInLogs(stack, [
      "token-media-A",
      videoItem.media.encrypt_query_param,
      videoItem.media.aes_key,
      Buffer.from(bytes).toString("base64"),
      Buffer.from(bytes).toString("hex"),
    ]);
  } finally {
    await stack.close();
  }
});

test("mixed parts keep their order, and each kind counts its own idempotency key", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const videoA = await stash(stack, mp4Bytes(1024), "video/mp4", null);
    const videoB = await stash(stack, webmBytes(1024), "video/webm", null);
    const file = await stash(stack, binaryBytesRaw(64), "application/zip", "a.zip");

    await stack.channel.send(
      outbound(
        stack.accountId,
        [
          { kind: "text", text: "两段视频和一个文件" },
          { kind: "video", media: videoA },
          { kind: "file", media: file },
          { kind: "video", media: videoB },
        ],
        "idem-mix",
      ),
    );

    assert.deepEqual(stack.server.sentMessages.map((entry) => entry.client_id), [
      "idem-mix",
      "idem-mix:video:0",
      "idem-mix:file:0",
      "idem-mix:video:1",
    ]);
    assert.deepEqual(stack.server.sentMessages.slice(1).map((entry) => entry.items[0]?.type), [ITEM_TYPE_VIDEO, 4, ITEM_TYPE_VIDEO]);
    assert.equal(stack.cdn.uploads.length, 3);
  } finally {
    await stack.close();
  }
});

test("inbound video failures are isolated: message still arrives, only that video is failed", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const bytes = mp4Bytes(8192);
    stack.cdn.stored.set("video-ok", Buffer.from(encryptMedia(bytes, key)));

    stack.server.setBatches([
      {
        msgs: [
          // 1. 缺密钥
          inboundVideoMessage({ messageId: "badv-1", fromUserId: "user-video", encryptQueryParam: "video-ok" }),
          // 2. CDN 404
          inboundVideoMessage({ messageId: "badv-2", fromUserId: "user-video", encryptQueryParam: "nope", mediaAesKey: mediaKeyToProtocolBase64(key) }),
          // 3. 密钥错误（解密/填充失败）
          inboundVideoMessage({
            messageId: "badv-3",
            fromUserId: "user-video",
            encryptQueryParam: "video-ok",
            mediaAesKey: mediaKeyToProtocolBase64(generateMediaKey()),
          }),
          // 4. 声明密文大小已经超上限：必须在下载之前拒绝（CDN 上确实有这个参数，用来证明没有下载）
          inboundVideoMessage({
            messageId: "badv-4",
            fromUserId: "user-video",
            encryptQueryParam: "video-oversize",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            videoSize: MEDIA_LIMITS.maxMediaBytes + 16 + 1,
          }),
          // 5. 正常视频
          inboundVideoMessage({ messageId: "okv-1", fromUserId: "user-video", encryptQueryParam: "video-ok", mediaAesKey: mediaKeyToProtocolBase64(key) }),
        ],
        buffer: "buf-video-2",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 5, "失败的视频不能让整批消息消失");
    for (const index of [0, 1, 2, 3]) {
      const media = (seen[index]!.parts[0] as VideoPart).media;
      assert.equal(media.status, "failed", "第 " + (index + 1) + " 条应当是 failed");
      assert.equal(media.mediaId, null);
    }
    assert.equal(
      stack.cdn.downloads.some((entry) => entry.param === "video-oversize"),
      false,
      "声明超限的视频不能被下载",
    );
    const okMedia = (seen[4]!.parts[0] as VideoPart).media;
    assert.equal(okMedia.status, "available");
    assert.equal(Buffer.compare(Buffer.from((await stack.mediaStorage.get(String(okMedia.mediaId)))!.bytes), Buffer.from(bytes)), 0);
  } finally {
    await stack.close();
  }
});

test("outbound video rejects unusable references before any network call", async () => {
  const stack = await createWeixinMediaStack();
  try {
    // 只有外部 URL：绝不自动抓取（SSRF 防护）
    await assert.rejects(
      () =>
        stack.channel.send(
          outbound(stack.accountId, [
            { kind: "video", media: mediaRef({ origin: "external", url: { kind: "external", value: "http://example.com/a.mp4" } }) },
          ]),
        ),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );

    // 没有 mediaId 也没有地址
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: mediaRef() }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );

    // 存储未命中 / 非法 mediaId 形状
    for (const mediaId of ["b".repeat(32), "not-a-valid-id", "../../etc/passwd"]) {
      await assert.rejects(
        () => stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: mediaRef({ mediaId }) }])),
        (error: unknown) => error instanceof DomainError && error.code === "not_found",
      );
    }

    // 空视频
    const empty = await stack.mediaStorage.put({ bytes: new Uint8Array(0), mimeType: "video/mp4", filename: null, origin: "generated" });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: mediaRef({ mediaId: empty.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /empty/.test(error.message),
    );

    // MIME 语法非法
    const badMime = await stack.mediaStorage.put({ bytes: mp4Bytes(64), mimeType: "definitely not a mime", filename: null, origin: "generated" });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: mediaRef({ mediaId: badMime.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /invalid_mime/.test(error.message),
    );

    // 声明 MIME 与容器内容矛盾（说 mp4，实际是 AVI）
    const avi = binaryBytes(256);
    avi[0] = 0x52;
    avi[1] = 0x49;
    avi[2] = 0x46;
    avi[3] = 0x46;
    avi[8] = 0x41;
    avi[9] = 0x56;
    avi[10] = 0x49;
    avi[11] = 0x20;
    const wrongType = await stack.mediaStorage.put({ bytes: avi, mimeType: "video/mp4", filename: null, origin: "generated" });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: mediaRef({ mediaId: wrongType.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /mime_mismatch/.test(error.message),
    );

    assert.equal(stack.server.calls.filter((call) => call.path.includes("getuploadurl") || call.path.includes("sendmessage")).length, 0);
    assert.equal(stack.cdn.uploads.length, 0);
  } finally {
    await stack.close();
  }
});

test("video send retries transient sendmessage failures, and errcode -14 marks the credential invalid", async () => {
  const transient = await createWeixinMediaStack();
  try {
    const reference = await stash(transient, mp4Bytes(1024), "video/mp4", null);
    transient.server.config.sendFailures = 1;
    await transient.channel.send(outbound(transient.accountId, [{ kind: "video", media: reference }]));
    const attempts = transient.server.calls.filter((call) => call.path.endsWith("/ilink/bot/sendmessage")).length;
    assert.equal(attempts, 2, "第一次失败后必须重试");
    assert.equal(transient.server.sentMessages[0]?.client_id, "idem-video-1:video:0", "重试复用同一个幂等键");
  } finally {
    await transient.close();
  }

  const stale = await createWeixinMediaStack();
  try {
    const reference = await stash(stale, mp4Bytes(1024), "video/mp4", null);
    stale.server.config.sendOverride = { ret: 0, errcode: -14, errmsg: "session timeout" };
    await assert.rejects(
      () => stale.channel.send(outbound(stale.accountId, [{ kind: "video", media: reference }])),
      (error: unknown) => error instanceof DomainError && error.code === "channel_unavailable",
    );
    assert.equal(stale.server.sentMessages.length, 1, "-14 不重试");
    assert.equal((await stale.channel.health()).state, "degraded");
  } finally {
    await stale.close();
  }
});

test("video pipeline never logs credentials, keys, download params or payload bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const bytes = mp4Bytes(2048);
    stack.cdn.stored.set("video-log", Buffer.from(encryptMedia(bytes, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundVideoMessage({
            messageId: "video-log-1",
            fromUserId: "user-video",
            encryptQueryParam: "video-log",
            mediaAesKey: mediaKeyToProtocolBase64(key),
          }),
        ],
        buffer: "buf-video-log",
      },
    ]);
    stack.channel.onInbound(async () => {});
    await stack.channel.pollOnce(stack.accountId);

    const reference = await stash(stack, bytes, "video/mp4", null);
    await stack.channel.send(outbound(stack.accountId, [{ kind: "video", media: reference }]));

    const videoItem = stack.server.sentMessages.at(-1)!.items[0]!.video_item as { media: { aes_key: string; encrypt_query_param: string } };
    noSecretsInLogs(stack, [
      "token-media-A",
      "video-log",
      videoItem.media.aes_key,
      videoItem.media.encrypt_query_param,
      mediaKeyToProtocolBase64(key),
      Buffer.from(bytes).toString("base64"),
      Buffer.from(bytes).toString("hex"),
    ]);
  } finally {
    await stack.close();
  }
});

/** 把协议里的 aes_key 还原成 16 字节密钥（仅测试用，与实现共用同一份解码逻辑）。 */
function mediaKeyFromWire(value: string): Uint8Array {
  const hex = Buffer.from(value, "base64").toString("utf8");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

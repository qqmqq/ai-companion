import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWeixinMediaStack, type WeixinMediaStack } from "../helpers/weixin-media-stack.ts";
import { inboundImageMessage } from "../helpers/mock-weixin-server.ts";
import {
  decryptMedia,
  encryptMedia,
  generateMediaKey,
  mediaKeyToHex,
  mediaKeyToProtocolBase64,
} from "../../src/channels/weixin/media/aes-media.ts";
import { CDN_ENCRYPT_TYPE_PACKED } from "../../src/channels/weixin/protocol/media-types.ts";
import { ITEM_TYPE_IMAGE } from "../../src/channels/weixin/protocol/types.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { partsToText } from "../../src/core/model/message.ts";
import type { InternalMessage, InternalResponse, OutboundPart, ImagePart } from "../../src/core/model/message.ts";
import type { MediaReference } from "../../src/core/model/media.ts";

/** 最小可用 PNG：签名 + IHDR（宽高可读），足以通过魔数与尺寸校验。 */
function pngBytes(width = 2, height = 3): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  ihdr.writeUInt32BE(0, 21);
  return new Uint8Array(Buffer.concat([signature, ihdr]));
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

function outbound(accountId: string, parts: OutboundPart[], idempotencyKey = "idem-img-1"): InternalResponse {
  return {
    channel: "weixin",
    accountId,
    conversationId: "user-media",
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

test("outbound image: storage → CDN upload → image_item, and the ciphertext decrypts back to the original bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const png = pngBytes(6, 4);
    const reference = await stash(stack, png, "image/png");

    const receipt = await stack.channel.send(outbound(stack.accountId, [{ kind: "image", media: reference }]));

    // 1. 上传请求符合协议
    const uploadCall = stack.server.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
    assert.ok(uploadCall !== undefined, "必须先调用 getuploadurl");
    const body = uploadCall.body as Record<string, unknown>;
    assert.equal(body.media_type, 1, "图片的 media_type 是 1");
    assert.equal(body.rawsize, png.byteLength);
    assert.equal(body.no_need_thumb, true);
    assert.match(String(body.aeskey), /^[0-9a-f]{32}$/);

    // 2. CDN 只拿到密文
    assert.equal(stack.cdn.uploads.length, 1);
    assert.equal(stack.cdn.uploads[0]?.bytes, body.filesize);
    const plaintextBuf = Buffer.from(png);

    // 3. 线上 item 是图片结构
    const sent = stack.server.sentMessages.at(-1);
    assert.ok(sent !== undefined, "必须发出 sendmessage");
    assert.equal(sent.to_user_id, "user-media");
    assert.equal(sent.items.length, 1);
    const item = sent.items[0]!;
    assert.equal(item.type, ITEM_TYPE_IMAGE);
    const imageItem = item.image_item as {
      media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
      mid_size: number;
      aeskey?: unknown;
    };
    assert.equal(imageItem.media.encrypt_type, CDN_ENCRYPT_TYPE_PACKED);
    assert.ok(imageItem.media.encrypt_query_param.length > 0);
    assert.equal(imageItem.mid_size, body.filesize, "mid_size 就是密文长度");
    assert.equal(imageItem.aeskey, undefined, "出站不使用 hex 形态的 aeskey 字段");

    // 4. 收到的密钥真的能解开 CDN 上的密文（端到端可验证，而不是只看参数存在）
    const cipher = stack.cdn.stored.get(imageItem.media.encrypt_query_param);
    assert.ok(cipher !== undefined, "CDN 上必须有对应密文");
    const decrypted = decryptMedia(new Uint8Array(cipher), mediaKeyFromWire(imageItem.media.aes_key));
    assert.equal(Buffer.compare(Buffer.from(decrypted), plaintextBuf), 0, "解密后必须与原图完全一致");
    assert.equal(Buffer.compare(cipher, plaintextBuf) === 0, false, "CDN 上不能是明文");

    assert.equal(receipt.providerMessageId, "srv-1");
    assert.equal(receipt.idempotencyKey, "idem-img-1");

    noSecretsInLogs(stack, [
      "token-media-A",
      imageItem.media.encrypt_query_param,
      imageItem.media.aes_key,
      plaintextBuf.toString("base64"),
      plaintextBuf.toString("hex"),
    ]);
  } finally {
    await stack.close();
  }
});

test("text and image coexist: text first, each part gets its own idempotency key", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const png = pngBytes();
    const first = await stash(stack, png, "image/png");
    const second = await stash(stack, pngBytes(3, 3), "image/png");

    await stack.channel.send(
      outbound(stack.accountId, [
        { kind: "text", text: "看这张图" },
        { kind: "image", media: first },
        { kind: "image", media: second },
      ], "idem-mix"),
    );

    assert.equal(stack.server.sentMessages.length, 3, "一句话 + 两张图 = 三条 sendmessage");
    assert.equal(stack.server.sentMessages[0]?.text, "看这张图");
    assert.equal(stack.server.sentMessages[0]?.client_id, "idem-mix");
    assert.equal(stack.server.sentMessages[1]?.client_id, "idem-mix:image:0");
    assert.equal(stack.server.sentMessages[2]?.client_id, "idem-mix:image:1");
    assert.equal(stack.server.sentMessages[1]?.items[0]?.type, ITEM_TYPE_IMAGE);
    assert.equal(stack.server.sentMessages[2]?.items[0]?.type, ITEM_TYPE_IMAGE);
    assert.equal(stack.cdn.uploads.length, 2, "每张图各自上传一次");
  } finally {
    await stack.close();
  }
});

test("inbound image: download → decrypt → validate → MediaStorage, and the reference is available with real metadata", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const png = pngBytes(5, 7);
    const cipher = encryptMedia(png, key);
    stack.cdn.stored.set("in-param-1", Buffer.from(cipher));

    stack.server.setBatches([
      {
        msgs: [
          inboundImageMessage({
            messageId: "img-1001",
            fromUserId: "user-media",
            encryptQueryParam: "in-param-1",
            aesKeyHex: mediaKeyToHex(key),
            midSize: cipher.byteLength,
            contextToken: "ctx-img",
          }),
        ],
        buffer: "buf-img-1",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 1, "消息必须被投递");
    assert.equal(seen.length, 1);

    const message = seen[0]!;
    assert.equal(message.parts.length, 1);
    const part = message.parts[0]!;
    assert.equal(part.kind, "image");
    const media = (part as ImagePart).media;
    assert.equal(media.status, "available");
    assert.ok(media.mediaId !== null && /^[0-9a-f]{32}$/.test(media.mediaId), "必须是本地 mediaId");
    assert.equal(media.mimeType, "image/png");
    assert.equal(media.width, 5);
    assert.equal(media.height, 7);
    assert.equal(media.origin, "channel");
    assert.equal(media.url?.kind, "internal");
    assert.equal(media.url?.value, "media:" + media.mediaId);

    // 二进制必须原样落库（不是元数据、不是 base64）
    const stored = await stack.mediaStorage.get(media.mediaId!);
    assert.ok(stored !== null);
    assert.equal(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(png)), 0, "落库字节必须与原图完全一致");
    assert.equal(stored.mimeType, "image/png");
    assert.equal(stored.sizeBytes, png.byteLength);

    // 上下文里只有占位符，不是对象字符串
    const rendered = partsToText(message.parts);
    assert.equal(rendered.includes("图片"), true);
    assert.equal(rendered.includes("[object Object]"), false);
    assert.equal(JSON.stringify(message).includes("[object Object]"), false);
    // 记录里不能出现密文、密钥或明文
    const serialized = JSON.stringify(message);
    assert.equal(serialized.includes("in-param-1"), false, "协议参数不能进入消息");
    assert.equal(serialized.includes(Buffer.from(png).toString("base64")), false);

    // 轮询即使处理失败也不能丢游标
    assert.equal(outcome.committed, true);
  } finally {
    await stack.close();
  }
});

test("inbound image with media.aes_key (base64) is accepted as well", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const png = pngBytes(2, 2);
    stack.cdn.stored.set("in-param-2", Buffer.from(encryptMedia(png, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundImageMessage({
            messageId: "img-1002",
            fromUserId: "user-media",
            encryptQueryParam: "in-param-2",
            mediaAesKey: mediaKeyToProtocolBase64(key),
          }),
        ],
        buffer: "buf-img-2",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });
    await stack.channel.pollOnce(stack.accountId);

    const media = (seen[0]!.parts[0] as ImagePart).media;
    assert.equal(media.status, "available");
    const stored = await stack.mediaStorage.get(media.mediaId!);
    assert.equal(Buffer.compare(Buffer.from(stored!.bytes), Buffer.from(png)), 0);
  } finally {
    await stack.close();
  }
});

test("inbound media failures are isolated: the message still arrives, only the image is marked failed", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const goodKey = generateMediaKey();
    const png = pngBytes(3, 3);
    stack.cdn.stored.set("in-ok", Buffer.from(encryptMedia(png, goodKey)));
    stack.cdn.stored.set("in-not-image", Buffer.from(encryptMedia(new Uint8Array(randomBytes(64)), goodKey)));

    const otherKey = generateMediaKey(); // 与加密时用的密钥不同 → 解密失败
    stack.server.setBatches([
      {
        msgs: [
          // 1. 缺密钥（描述不完整）
          inboundImageMessage({ messageId: "bad-1", fromUserId: "user-media", encryptQueryParam: "in-ok" }),
          // 2. CDN 上没有这个参数 → 404
          inboundImageMessage({ messageId: "bad-2", fromUserId: "user-media", encryptQueryParam: "nope", aesKeyHex: mediaKeyToHex(goodKey) }),
          // 3. 解密成功但内容不是图片
          inboundImageMessage({
            messageId: "bad-3",
            fromUserId: "user-media",
            encryptQueryParam: "in-not-image",
            aesKeyHex: mediaKeyToHex(goodKey),
          }),
          // 4. 密钥不对 → 解密/填充失败
          inboundImageMessage({
            messageId: "bad-4",
            fromUserId: "user-media",
            encryptQueryParam: "in-ok",
            aesKeyHex: mediaKeyToHex(otherKey),
          }),
          // 5. 正常图片，用于对照
          inboundImageMessage({
            messageId: "ok-1",
            fromUserId: "user-media",
            encryptQueryParam: "in-ok",
            aesKeyHex: mediaKeyToHex(goodKey),
          }),
        ],
        buffer: "buf-img-3",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 5, "失败的图片不能让整批消息消失");
    assert.equal(seen.length, 5);

    for (const index of [0, 1, 2, 3]) {
      const media = (seen[index]!.parts[0] as ImagePart).media;
      assert.equal(media.status, "failed", "第 " + (index + 1) + " 条应当是 failed");
      assert.equal(media.mediaId, null, "失败时不允许留下假的 mediaId");
    }
    const okMedia = (seen[4]!.parts[0] as ImagePart).media;
    assert.equal(okMedia.status, "available");
    assert.equal((await stack.mediaStorage.get(okMedia.mediaId!)) !== null, true);

    const joined = stack.logLines.join("\n");
    assert.equal(joined.includes("token-media-A"), false);
    assert.equal(joined.includes(mediaKeyToHex(goodKey)), false, "hex 密钥不能落日志");
  } finally {
    await stack.close();
  }
});

test("outbound rejects unusable references before any network call", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const callsBefore = stack.server.calls.length;

    // 只有外部 URL：绝不自动抓取（SSRF 防护）
    await assert.rejects(
      () =>
        stack.channel.send(
          outbound(stack.accountId, [
            { kind: "image", media: mediaRef({ origin: "external", url: { kind: "external", value: "http://example.com/a.png" } }) },
          ]),
        ),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );

    // 既没有 mediaId 也没有地址
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "image", media: mediaRef() }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );

    // mediaId 存在但存储里没有
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "image", media: mediaRef({ mediaId: "a".repeat(32) }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "not_found",
    );

    // 存储里是文本，不是图片
    const notImage = await stack.mediaStorage.put({
      bytes: new TextEncoder().encode("this is not an image at all"),
      mimeType: "text/plain",
      filename: null,
      origin: "generated",
    });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "image", media: mediaRef({ mediaId: notImage.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /not_an_image|unsupported_mime/.test(error.message),
    );

    assert.equal(
      stack.server.calls.filter((call) => call.path.includes("getuploadurl") || call.path.includes("sendmessage")).length,
      0,
      "被拒绝的图片不应产生任何上传/发送请求",
    );
    assert.ok(stack.server.calls.length >= callsBefore - 1);
    assert.equal(stack.cdn.uploads.length, 0);
  } finally {
    await stack.close();
  }
});

test("image send retries transient sendmessage failures, and errcode -14 marks the credential invalid", async () => {
  const transient = await createWeixinMediaStack();
  try {
    const reference = await stash(transient, pngBytes(), "image/png");
    transient.server.config.sendFailures = 1;
    const receipt = await transient.channel.send(outbound(transient.accountId, [{ kind: "image", media: reference }]));
    const sendAttempts = transient.server.calls.filter((call) => call.path.endsWith("/ilink/bot/sendmessage")).length;
    assert.equal(sendAttempts, 2, "第一次失败后必须重试");
    assert.equal(receipt.providerMessageId, "srv-1", "重试成功后拿到服务端消息号");
    // 重试的两次发送必须复用同一个幂等键（服务端才能去重）
    assert.equal(transient.server.sentMessages.length, 1);
    assert.equal(transient.server.sentMessages[0]?.client_id, "idem-img-1:image:0");
  } finally {
    await transient.close();
  }

  const stale = await createWeixinMediaStack();
  try {
    const reference = await stash(stale, pngBytes(), "image/png");
    stale.server.config.sendOverride = { ret: 0, errcode: -14, errmsg: "session timeout" };
    await assert.rejects(
      () => stale.channel.send(outbound(stale.accountId, [{ kind: "image", media: reference }])),
      (error: unknown) => error instanceof DomainError && error.code === "channel_unavailable",
    );
    assert.equal(stale.server.sentMessages.length, 1, "-14 不重试");
    const health = await stale.channel.health();
    assert.equal(health.state, "degraded", "凭证失效必须体现在健康状态上");
  } finally {
    await stale.close();
  }
});

test("image pipeline never logs keys, parameters, credentials or payload bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const png = pngBytes(4, 4);
    stack.cdn.stored.set("in-log", Buffer.from(encryptMedia(png, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundImageMessage({
            messageId: "img-log",
            fromUserId: "user-media",
            encryptQueryParam: "in-log",
            aesKeyHex: mediaKeyToHex(key),
          }),
        ],
        buffer: "buf-log",
      },
    ]);
    stack.channel.onInbound(async () => {});
    await stack.channel.pollOnce(stack.accountId);

    const reference = await stash(stack, png, "image/png");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "image", media: reference }]));

    const sentItem = stack.server.sentMessages.at(-1)!.items[0]!.image_item as { media: { aes_key: string; encrypt_query_param: string } };
    noSecretsInLogs(stack, [
      "token-media-A",
      "in-log",
      sentItem.media.aes_key,
      sentItem.media.encrypt_query_param,
      mediaKeyToHex(key),
      mediaKeyToProtocolBase64(key),
      Buffer.from(png).toString("base64"),
      Buffer.from(png).toString("hex"),
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

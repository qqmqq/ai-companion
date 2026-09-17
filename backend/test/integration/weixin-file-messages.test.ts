import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { createWeixinMediaStack, type WeixinMediaStack } from "../helpers/weixin-media-stack.ts";
import { inboundFileMessage } from "../helpers/mock-weixin-server.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyToProtocolBase64 } from "../../src/channels/weixin/media/aes-media.ts";
import { CDN_ENCRYPT_TYPE_PACKED } from "../../src/channels/weixin/protocol/media-types.ts";
import { ITEM_TYPE_FILE } from "../../src/channels/weixin/protocol/types.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { partsToText } from "../../src/core/model/message.ts";
import type { FilePart, InternalMessage, InternalResponse, OutboundPart } from "../../src/core/model/message.ts";
import type { MediaReference } from "../../src/core/model/media.ts";

/** 含 0x00 / 0xFF / 0x01 / 0x80 的二进制：文件绝不能被当成 UTF-8 文本处理 */
function binaryBytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(randomBytes(size));
  bytes[0] = 0x00;
  bytes[1] = 0xff;
  bytes[2] = 0x01;
  bytes[3] = 0x80;
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

function outbound(accountId: string, parts: OutboundPart[], idempotencyKey = "idem-file-1"): InternalResponse {
  return {
    channel: "weixin",
    accountId,
    conversationId: "user-file",
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

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function noSecretsInLogs(stack: WeixinMediaStack, secrets: string[]): void {
  const joined = stack.logLines.join("\n");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    assert.equal(joined.includes(secret), false, "日志中不允许出现敏感值：" + secret.slice(0, 12) + "…");
  }
}

test("inbound file: download → decrypt → validate → MediaStorage → FilePart available, binary identical", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const bytes = binaryBytes();
    const cipher = encryptMedia(bytes, key);
    stack.cdn.stored.set("file-param-1", Buffer.from(cipher));

    stack.server.setBatches([
      {
        msgs: [
          inboundFileMessage({
            messageId: "file-1001",
            fromUserId: "user-file",
            // 路径穿越尝试：文件名必须被净化成纯文件名
            fileName: "../../secrets/../secret.txt",
            len: String(bytes.byteLength),
            encryptQueryParam: "file-param-1",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            contextToken: "ctx-file-1",
          }),
        ],
        buffer: "buf-file-1",
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
    assert.equal(message.type, "file");
    const part = message.parts[0]!;
    assert.equal(part.kind, "file");
    const media = (part as FilePart).media;
    assert.equal(media.status, "available");
    assert.match(String(media.mediaId), /^[0-9a-f]{32}$/);
    assert.equal(media.filename, "secret.txt", "文件名只保留最后一段");
    assert.equal(media.mimeType, "application/octet-stream", "协议没给类型时用 octet-stream");
    assert.equal(media.sizeBytes, bytes.byteLength);
    assert.equal(media.width, null, "文件没有尺寸概念");
    assert.equal(media.height, null);
    assert.equal(media.origin, "channel");
    assert.equal(media.url?.kind, "internal");

    const stored = await stack.mediaStorage.get(String(media.mediaId));
    assert.ok(stored !== null);
    assert.equal(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(bytes)), 0, "落库字节必须与原文完全一致");
    assert.equal(stored.filename, "secret.txt");
    assert.equal(stored.sizeBytes, bytes.byteLength);

    // 上下文里只有占位符（含文件名），既不是对象字符串也不含内容
    const rendered = partsToText(message.parts);
    assert.match(rendered, /\[文件: secret\.txt\]/);
    assert.equal(rendered.includes("[object Object]"), false);
    assert.equal(JSON.stringify(message).includes("file-param-1"), false, "协议参数不能进入消息");

    // 所有落盘文件都必须待在 <dataDir>/media 之内
    const files = walk(stack.dataDir);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.ok(file.startsWith(join(stack.dataDir, "media") + sep), "落盘路径越界：" + file);
    }
    assert.equal(files.some((file) => file.includes("secret")), false, "文件名不能变成任何真实路径");
  } finally {
    await stack.close();
  }
});

test("outbound file: storage → upload → file_item, and the ciphertext decrypts back to the original bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const bytes = binaryBytes(2048);
    const reference = await stash(stack, bytes, "application/pdf", "report.pdf");

    const receipt = await stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: reference }]));

    const uploadCall = stack.server.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
    assert.ok(uploadCall !== undefined);
    const body = uploadCall.body as Record<string, unknown>;
    assert.equal(body.media_type, 3, "文件的 media_type 是 3");
    assert.equal(body.rawsize, bytes.byteLength);
    assert.equal(body.no_need_thumb, true);

    const sent = stack.server.sentMessages.at(-1)!;
    assert.equal(sent.client_id, "idem-file-1:file:0");
    const item = sent.items[0]!;
    assert.equal(item.type, ITEM_TYPE_FILE);
    const fileItem = item.file_item as {
      media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
      file_name: string;
      len: string;
    };
    assert.equal(fileItem.media.encrypt_type, CDN_ENCRYPT_TYPE_PACKED);
    assert.equal(fileItem.file_name, "report.pdf");
    assert.equal(fileItem.len, String(bytes.byteLength), "len 是明文字节数的十进制字符串");
    assert.equal(typeof fileItem.len, "string", "绝不用 JS Number 表示协议里的长度");

    const cipher = stack.cdn.stored.get(fileItem.media.encrypt_query_param);
    assert.ok(cipher !== undefined);
    assert.equal(Buffer.compare(Buffer.from(cipher), Buffer.from(bytes)) === 0, false, "CDN 上不能是明文");
    const decrypted = decryptMedia(new Uint8Array(cipher), mediaKeyFromWire(fileItem.media.aes_key));
    assert.equal(Buffer.compare(Buffer.from(decrypted), Buffer.from(bytes)), 0, "解密后必须与原文件完全一致");
    assert.equal(receipt.providerMessageId, "srv-1");

    noSecretsInLogs(stack, [
      "token-media-A",
      fileItem.media.encrypt_query_param,
      fileItem.media.aes_key,
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
    const png = await stack.mediaStorage.put({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      mimeType: "image/png",
      filename: null,
      origin: "generated",
    });
    const fileA = await stash(stack, binaryBytes(64), "application/zip", "a.zip");
    const fileB = await stash(stack, binaryBytes(64), "text/plain", "b.txt");

    await stack.channel.send(
      outbound(
        stack.accountId,
        [
          { kind: "text", text: "两个文件" },
          { kind: "file", media: fileA },
          { kind: "image", media: mediaRef({ mediaId: png.mediaId, mimeType: "image/png", url: { kind: "internal", value: "media:" + png.mediaId } }) },
          { kind: "file", media: fileB },
        ],
        "idem-mix",
      ),
    );

    const clientIds = stack.server.sentMessages.map((entry) => entry.client_id);
    assert.deepEqual(clientIds, ["idem-mix", "idem-mix:file:0", "idem-mix:image:0", "idem-mix:file:1"]);
    const kinds = stack.server.sentMessages.slice(1).map((entry) => entry.items[0]?.type);
    assert.deepEqual(kinds, [ITEM_TYPE_FILE, 2, ITEM_TYPE_FILE], "顺序按 parts 出现顺序，ID 按类型各自计数");
  } finally {
    await stack.close();
  }
});

test("inbound file failures are isolated: message still arrives, only that file is failed", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const bytes = binaryBytes(256);
    stack.cdn.stored.set("file-ok", Buffer.from(encryptMedia(bytes, key)));

    stack.server.setBatches([
      {
        msgs: [
          // 1. 缺密钥（协议不完整）
          inboundFileMessage({ messageId: "badf-1", fromUserId: "user-file", encryptQueryParam: "file-ok", fileName: "a.txt", len: 1 }),
          // 2. CDN 上没有这个参数 → 404
          inboundFileMessage({ messageId: "badf-2", fromUserId: "user-file", encryptQueryParam: "nope", mediaAesKey: mediaKeyToProtocolBase64(key), fileName: "b.txt", len: 1 }),
          // 3. 声明大小超过上限：必须在下载之前就拒绝（CDN 上确实有这个参数，用来证明没有下载）
          inboundFileMessage({
            messageId: "badf-3",
            fromUserId: "user-file",
            encryptQueryParam: "file-oversize",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            fileName: "huge.bin",
            len: "26214401",
          }),
          // 4. 声明大小是垃圾值（忽略声明，按实际字节处理 → 正常）
          inboundFileMessage({
            messageId: "okf-1",
            fromUserId: "user-file",
            encryptQueryParam: "file-ok",
            mediaAesKey: mediaKeyToProtocolBase64(key),
            fileName: "ok.bin",
            len: "not-a-number",
          }),
        ],
        buffer: "buf-file-2",
      },
    ]);

    const seen: InternalMessage[] = [];
    stack.channel.onInbound(async (message) => {
      seen.push(message);
    });

    const outcome = await stack.channel.pollOnce(stack.accountId);
    assert.equal(outcome.processed, 4, "失败的文件不能导致整批消息丢失");
    assert.equal(seen.length, 4);

    for (const index of [0, 1, 2]) {
      const media = (seen[index]!.parts[0] as FilePart).media;
      assert.equal(media.status, "failed", "第 " + (index + 1) + " 条应当是 failed");
      assert.equal(media.mediaId, null, "失败时不允许留下假的 mediaId");
    }
    // 失败的第三条：声明大小超限 → 连下载都不应该发生
    assert.equal(
      stack.cdn.downloads.some((entry) => entry.param === "file-oversize"),
      false,
      "声明超限的文件不能被下载",
    );
    const okMedia = (seen[3]!.parts[0] as FilePart).media;
    assert.equal(okMedia.status, "available");
    const stored = await stack.mediaStorage.get(String(okMedia.mediaId));
    assert.equal(Buffer.compare(Buffer.from(stored!.bytes), Buffer.from(bytes)), 0);
    assert.equal(okMedia.filename, "ok.bin", "声明大小非法时不影响文件名");
  } finally {
    await stack.close();
  }
});

test("outbound file rejects unusable references before any network call", async () => {
  const stack = await createWeixinMediaStack();
  try {
    // 只有外部 URL：绝不自动抓取（SSRF 防护）
    await assert.rejects(
      () =>
        stack.channel.send(
          outbound(stack.accountId, [
            { kind: "file", media: mediaRef({ origin: "external", url: { kind: "external", value: "http://example.com/a.pdf" } }) },
          ]),
        ),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );

    // 没有 mediaId 也没有地址
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: mediaRef() }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );

    // mediaId 存在但存储里没有（含非法 mediaId 形状）
    for (const mediaId of ["a".repeat(32), "not-a-valid-id", "../../etc/passwd"]) {
      await assert.rejects(
        () => stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: mediaRef({ mediaId }) }])),
        (error: unknown) => error instanceof DomainError && error.code === "not_found",
      );
    }

    // 存储里的 MIME 语法非法 → 明确拒绝，而不是发出一个不合法载荷
    const badMime = await stack.mediaStorage.put({
      bytes: binaryBytes(32),
      mimeType: "definitely not a mime",
      filename: "x.bin",
      origin: "generated",
    });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: mediaRef({ mediaId: badMime.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /invalid_mime/.test(error.message),
    );

    assert.equal(stack.server.calls.filter((call) => call.path.includes("getuploadurl") || call.path.includes("sendmessage")).length, 0);
    assert.equal(stack.cdn.uploads.length, 0);
  } finally {
    await stack.close();
  }
});

test("outbound file sanitizes a hostile stored filename and never sends a path", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const hostile = await stack.mediaStorage.put({
      bytes: binaryBytes(128),
      mimeType: "text/plain",
      // 存储层只是保存元数据；真正的净化发生在出站构造协议载荷时
      filename: "..\\..\\..\\Windows\\System32\\evil.txt",
      origin: "generated",
    });
    await stack.channel.send(
      outbound(stack.accountId, [{ kind: "file", media: mediaRef({ mediaId: hostile.mediaId, mimeType: "text/plain", filename: hostile.filename }) }]),
    );
    const fileItem = stack.server.sentMessages.at(-1)!.items[0]!.file_item as { file_name: string };
    assert.equal(fileItem.file_name, "evil.txt");
    assert.equal(/[\\/]/.test(fileItem.file_name), false, "线上文件名不允许包含任何路径分隔符");
  } finally {
    await stack.close();
  }
});

test("file send retries transient sendmessage failures, and errcode -14 marks the credential invalid", async () => {
  const transient = await createWeixinMediaStack();
  try {
    const reference = await stash(transient, binaryBytes(64), "application/octet-stream", "a.bin");
    transient.server.config.sendFailures = 1;
    await transient.channel.send(outbound(transient.accountId, [{ kind: "file", media: reference }]));
    const attempts = transient.server.calls.filter((call) => call.path.endsWith("/ilink/bot/sendmessage")).length;
    assert.equal(attempts, 2, "第一次失败后必须重试");
    assert.equal(transient.server.sentMessages[0]?.client_id, "idem-file-1:file:0", "重试复用同一个幂等键");
  } finally {
    await transient.close();
  }

  const stale = await createWeixinMediaStack();
  try {
    const reference = await stash(stale, binaryBytes(64), "application/octet-stream", "a.bin");
    stale.server.config.sendOverride = { ret: 0, errcode: -14, errmsg: "session timeout" };
    await assert.rejects(
      () => stale.channel.send(outbound(stale.accountId, [{ kind: "file", media: reference }])),
      (error: unknown) => error instanceof DomainError && error.code === "channel_unavailable",
    );
    assert.equal(stale.server.sentMessages.length, 1, "-14 不重试");
    assert.equal((await stale.channel.health()).state, "degraded");
  } finally {
    await stale.close();
  }
});

test("a file whose stored bytes are empty is rejected instead of being sent", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const empty = await stack.mediaStorage.put({ bytes: new Uint8Array(0), mimeType: "text/plain", filename: "empty.txt", origin: "generated" });
    await assert.rejects(
      () => stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: mediaRef({ mediaId: empty.mediaId }) }])),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input" && /empty/.test(error.message),
    );
    assert.equal(stack.server.calls.filter((call) => call.path.includes("getuploadurl")).length, 0, "空文件不应触发上传");
  } finally {
    await stack.close();
  }
});

test("file pipeline never logs credentials, keys, download params or payload bytes", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const key = generateMediaKey();
    const bytes = binaryBytes(512);
    stack.cdn.stored.set("file-log", Buffer.from(encryptMedia(bytes, key)));
    stack.server.setBatches([
      {
        msgs: [
          inboundFileMessage({
            messageId: "file-log-1",
            fromUserId: "user-file",
            fileName: "log.txt",
            len: String(bytes.byteLength),
            encryptQueryParam: "file-log",
            mediaAesKey: mediaKeyToProtocolBase64(key),
          }),
        ],
        buffer: "buf-file-log",
      },
    ]);
    stack.channel.onInbound(async () => {});
    await stack.channel.pollOnce(stack.accountId);

    const reference = await stash(stack, bytes, "text/plain", "out.txt");
    await stack.channel.send(outbound(stack.accountId, [{ kind: "file", media: reference }]));

    const fileItem = stack.server.sentMessages.at(-1)!.items[0]!.file_item as { media: { aes_key: string; encrypt_query_param: string } };
    noSecretsInLogs(stack, [
      "token-media-A",
      "file-log",
      fileItem.media.aes_key,
      fileItem.media.encrypt_query_param,
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

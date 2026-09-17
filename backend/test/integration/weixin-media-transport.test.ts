import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createWeixinMediaStack } from "../helpers/weixin-media-stack.ts";
import { WeixinTransportError } from "../../src/channels/weixin/protocol/errors.ts";
import { MEDIA_SECRET_KEYS } from "../../src/channels/weixin/media/media-transport.ts";
import { encryptedSize, mediaKeyFromProtocolBase64, mediaKeyToProtocolBase64 } from "../../src/channels/weixin/media/aes-media.ts";
import { MEDIA_LIMITS } from "../../src/core/model/media.ts";

function kindOf(error: unknown): string {
  assert.ok(error instanceof WeixinTransportError, `expected WeixinTransportError, got ${String(error)}`);
  return (error as WeixinTransportError).kind;
}

function assertNoSecretsInLogs(lines: string[], secrets: string[]): void {
  const joined = lines.join("\n");
  for (const secret of secrets) {
    assert.equal(joined.includes(secret), false, `日志中不允许出现敏感值：${secret.slice(0, 12)}…`);
  }
}

test("bytes → encrypt → upload → download → decrypt round-trips exactly", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const transport = await stack.channel.createMediaTransport(stack.accountId);
    const plaintext = new Uint8Array(randomBytes(4096));

    const uploaded = await transport.upload({
      accountId: stack.accountId,
      conversationRef: "user-media-1",
      kind: "image",
      bytes: plaintext,
      mimeType: "image/png",
      filename: "photo.png",
    });

    // 上传请求必须符合协议
    const uploadCall = stack.server.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
    assert.ok(uploadCall !== undefined, "必须调用 getuploadurl");
    const body = uploadCall.body as Record<string, unknown>;
    assert.equal(body.media_type, 1, "图片是 1");
    assert.equal(body.rawsize, plaintext.byteLength);
    assert.equal(body.filesize, encryptedSize(plaintext.byteLength));
    assert.equal(body.no_need_thumb, true);
    assert.match(String(body.aeskey), /^[0-9a-f]{32}$/);
    assert.equal(body.rawfilemd5, createHash("md5").update(Buffer.from(plaintext)).digest("hex"), "rawfilemd5 必须是明文 md5");

    // CDN 只应收到密文
    assert.equal(stack.cdn.uploads.length, 1);
    assert.equal(stack.cdn.uploads[0]?.bytes, encryptedSize(plaintext.byteLength));
    assert.equal(stack.cdn.uploads[0]?.contentType, "application/octet-stream");
    const stored = [...stack.cdn.stored.values()][0]!;
    assert.equal(Buffer.from(stored).equals(Buffer.from(plaintext)), false, "CDN 上不应该是明文");

    // 引用与敏感材料分离
    // 引用（handle）里不能出现任何敏感材料，密钥只存在于 secretMaterial
    const handleJson = JSON.stringify(uploaded.handle);
    const protocolKey = uploaded.secretMaterial[MEDIA_SECRET_KEYS.mediaKey]!;
    assert.equal(handleJson.includes(protocolKey), false);
    assert.equal(handleJson.includes("mediaKey"), false);
    assert.match(Buffer.from(protocolKey, "base64").toString("utf8"), /^[0-9a-f]{32}$/, "媒体密钥必须按协议编码");
    assert.ok((uploaded.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam] ?? "").length > 0);

    // 下载 + 解密：必须二进制一致
    const downloaded = await transport.download({
      accountId: stack.accountId,
      handle: uploaded.handle,
      secretMaterial: uploaded.secretMaterial,
      expectedMimeType: null,
    });
    assert.equal(Buffer.compare(Buffer.from(downloaded.bytes), Buffer.from(plaintext)), 0, "往返后二进制必须完全一致");
    assert.equal(downloaded.sizeBytes, plaintext.byteLength);
    assert.equal(stack.cdn.downloads.length, 1);

    // 日志里不能出现密钥或下载参数
    assertNoSecretsInLogs(stack.logLines, [
      uploaded.secretMaterial[MEDIA_SECRET_KEYS.mediaKey]!,
      uploaded.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam]!,
      Buffer.from(plaintext).toString("base64"),
    ]);
  } finally {
    await stack.close();
  }
});

test("media type mapping follows the protocol for every kind", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const transport = await stack.channel.createMediaTransport(stack.accountId);
    const kinds: Array<["image" | "video" | "file" | "audio", number]> = [
      ["image", 1],
      ["video", 2],
      ["file", 3],
      ["audio", 4],
    ];
    for (const [kind, expected] of kinds) {
      stack.server.calls.length = 0;
      await transport.upload({
        accountId: stack.accountId,
        conversationRef: "user-media-1",
        kind,
        bytes: new Uint8Array(randomBytes(32)),
        mimeType: kind === "image" ? "image/png" : null,
        filename: null,
      });
      const call = stack.server.calls.find((entry) => entry.path.endsWith("/ilink/bot/getuploadurl"));
      assert.equal((call?.body as { media_type?: number }).media_type, expected, `kind ${kind}`);
    }
  } finally {
    await stack.close();
  }
});

test("oversized and empty media are rejected before any network call", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const transport = await stack.channel.createMediaTransport(stack.accountId);
    const callsBefore = stack.server.calls.length + stack.cdn.uploads.length;

    await assert.rejects(
      () =>
        transport.upload({
          accountId: stack.accountId,
          conversationRef: "u",
          kind: "file",
          bytes: new Uint8Array(MEDIA_LIMITS.maxMediaBytes + 1),
          mimeType: null,
          filename: null,
        }),
      (error: unknown) => kindOf(error) === "size_limit",
    );
    await assert.rejects(
      () => transport.upload({ accountId: stack.accountId, conversationRef: "u", kind: "file", bytes: new Uint8Array(0), mimeType: null, filename: null }),
      (error: unknown) => kindOf(error) === "protocol_error",
    );

    assert.equal(stack.server.calls.length + stack.cdn.uploads.length, callsBefore, "被拒绝的请求不应产生任何网络调用");
  } finally {
    await stack.close();
  }
});

test("upload retries transport failures but never retries 4xx", async () => {
  const transient = await createWeixinMediaStack({ failUploadTimes: 2 });
  try {
    const transport = await transient.channel.createMediaTransport(transient.accountId);
    const uploaded = await transport.upload({
      accountId: transient.accountId,
      conversationRef: "u",
      kind: "file",
      bytes: new Uint8Array(randomBytes(64)),
      mimeType: "application/pdf",
      filename: "a.pdf",
    });
    assert.ok(uploaded.handle.transferredSizeBytes > 0);
    assert.equal(transient.cdn.uploads.length, 3, "两次失败 + 一次成功");
  } finally {
    await transient.close();
  }

  const clientError = await createWeixinMediaStack({ failUploadTimes: 99, uploadFailStatus: 400 });
  try {
    const transport = await clientError.channel.createMediaTransport(clientError.accountId);
    await assert.rejects(
      () =>
        transport.upload({ accountId: clientError.accountId, conversationRef: "u", kind: "file", bytes: new Uint8Array(randomBytes(64)), mimeType: null, filename: null }),
      (error: unknown) => {
        assert.equal(kindOf(error), "http");
        assert.equal((error as WeixinTransportError).retryable, false, "4xx 不可重试");
        return true;
      },
    );
    assert.equal(clientError.cdn.uploads.length, 1, "4xx 只尝试一次");
  } finally {
    await clientError.close();
  }
});

test("missing upload parameter header is a retryable protocol error, then gives up", async () => {
  const stack = await createWeixinMediaStack({ omitUploadParamHeader: true });
  try {
    const transport = await stack.channel.createMediaTransport(stack.accountId);
    await assert.rejects(
      () => transport.upload({ accountId: stack.accountId, conversationRef: "u", kind: "file", bytes: new Uint8Array(randomBytes(32)), mimeType: null, filename: null }),
      (error: unknown) => kindOf(error) === "protocol_error",
    );
    assert.equal(stack.cdn.uploads.length, 3, "有上限地重试后失败");
  } finally {
    await stack.close();
  }
});

test("getuploadurl failures are classified and not retried when fatal", async () => {
  const stale = await createWeixinMediaStack();
  try {
    stale.server.config.uploadUrlResponse = { ret: 0, errcode: -14, errmsg: "session timeout" };
    const transport = await stale.channel.createMediaTransport(stale.accountId);
    await assert.rejects(
      () => transport.upload({ accountId: stale.accountId, conversationRef: "u", kind: "file", bytes: new Uint8Array(randomBytes(32)), mimeType: null, filename: null }),
      (error: unknown) => {
        assert.equal(kindOf(error), "stale_token");
        assert.equal((error as WeixinTransportError).retryable, false);
        return true;
      },
    );
  } finally {
    await stale.close();
  }

  const noUrl = await createWeixinMediaStack();
  try {
    noUrl.server.config.uploadUrlResponse = { ret: 0 };
    const transport = await noUrl.channel.createMediaTransport(noUrl.accountId);
    await assert.rejects(
      () => transport.upload({ accountId: noUrl.accountId, conversationRef: "u", kind: "file", bytes: new Uint8Array(randomBytes(32)), mimeType: null, filename: null }),
      (error: unknown) => kindOf(error) === "protocol_error",
    );
  } finally {
    await noUrl.close();
  }

  const transient = await createWeixinMediaStack();
  try {
    transient.server.config.uploadUrlFailures = 1;
    const transport = await transient.channel.createMediaTransport(transient.accountId);
    const uploaded = await transport.upload({
      accountId: transient.accountId,
      conversationRef: "u",
      kind: "file",
      bytes: new Uint8Array(randomBytes(32)),
      mimeType: null,
      filename: null,
    });
    assert.ok(uploaded.handle.sizeBytes === 32);
  } finally {
    await transient.close();
  }
});

test("download failures: 404, 500-retry, timeout, and MIME mismatch", async () => {
  const notFound = await createWeixinMediaStack();
  try {
    const transport = await notFound.channel.createMediaTransport(notFound.accountId);
    await assert.rejects(
      () =>
        transport.download({
          accountId: notFound.accountId,
          handle: { provider: "weixin-cdn", mediaId: null, sizeBytes: 10, transferredSizeBytes: 16, mimeType: null, filename: null, uploadedAt: notFound.clock.nowIso() },
          secretMaterial: {
            [MEDIA_SECRET_KEYS.mediaKey]: mediaKeyToProtocolBase64(new Uint8Array(randomBytes(16))),
            [MEDIA_SECRET_KEYS.encryptQueryParam]: "does-not-exist",
          },
        }),
      (error: unknown) => {
        assert.equal(kindOf(error), "http");
        assert.equal((error as WeixinTransportError).httpStatus, 404);
        assert.equal((error as WeixinTransportError).retryable, false, "404 不重试");
        return true;
      },
    );
  } finally {
    await notFound.close();
  }

  const retried = await createWeixinMediaStack({ failDownloadTimes: 2 });
  try {
    const transport = await retried.channel.createMediaTransport(retried.accountId);
    const plaintext = new Uint8Array(randomBytes(128));
    const uploaded = await transport.upload({ accountId: retried.accountId, conversationRef: "u", kind: "file", bytes: plaintext, mimeType: null, filename: null });
    const downloaded = await transport.download({ accountId: retried.accountId, handle: uploaded.handle, secretMaterial: uploaded.secretMaterial });
    assert.equal(Buffer.compare(Buffer.from(downloaded.bytes), Buffer.from(plaintext)), 0);
    assert.equal(retried.cdn.downloads.length, 3);
  } finally {
    await retried.close();
  }

  const slow = await createWeixinMediaStack({ downloadDelayMs: 200, mediaOptions: { sleepImpl: async () => {}, maxAttempts: 1 } });
  try {
    const transport = await slow.channel.createMediaTransport(slow.accountId);
    const uploaded = await transport.upload({
      accountId: slow.accountId,
      conversationRef: "u",
      kind: "file",
      bytes: new Uint8Array(randomBytes(64)),
      mimeType: null,
      filename: null,
    });
    // 用极短超时触发 timeout 分类
    await assert.rejects(
      () =>
        transport.download({
          accountId: slow.accountId,
          handle: uploaded.handle,
          secretMaterial: uploaded.secretMaterial,
          signal: AbortSignal.timeout(50),
        }),
      (error: unknown) => {
        assert.equal(kindOf(error), "aborted");
        return true;
      },
    );
  } finally {
    await slow.close();
  }

  // CDN 返回另一种真实媒体类型 → 与期望不符
  const mime = await createWeixinMediaStack({ downloadContentType: "image/jpeg" });
  try {
    const transport = await mime.channel.createMediaTransport(mime.accountId);
    const uploaded = await transport.upload({
      accountId: mime.accountId,
      conversationRef: "u",
      kind: "image",
      bytes: new Uint8Array(randomBytes(64)),
      mimeType: "image/png",
      filename: "a.png",
    });
    await assert.rejects(
      () =>
        transport.download({
          accountId: mime.accountId,
          handle: uploaded.handle,
          secretMaterial: uploaded.secretMaterial,
          expectedMimeType: "image/png",
        }),
      (error: unknown) => {
        assert.equal(kindOf(error), "protocol_error");
        assert.match((error as Error).message, /Media-Type/);
        return true;
      },
    );
  } finally {
    await mime.close();
  }

  // 文本类响应说明拿到的是错误页，即使没给期望类型也必须拒绝
  const errorPage = await createWeixinMediaStack({ downloadContentType: "text/html" });
  try {
    const transport = await errorPage.channel.createMediaTransport(errorPage.accountId);
    const uploaded = await transport.upload({
      accountId: errorPage.accountId,
      conversationRef: "u",
      kind: "file",
      bytes: new Uint8Array(randomBytes(64)),
      mimeType: "application/pdf",
      filename: "a.pdf",
    });
    await assert.rejects(
      () => transport.download({ accountId: errorPage.accountId, handle: uploaded.handle, secretMaterial: uploaded.secretMaterial }),
      (error: unknown) => {
        assert.equal(kindOf(error), "protocol_error");
        assert.match((error as Error).message, /错误页/);
        return true;
      },
    );
  } finally {
    await errorPage.close();
  }

  // octet-stream 是密文的正常回答，必须被接受
  const octet = await createWeixinMediaStack({ downloadContentType: "application/octet-stream" });
  try {
    const transport = await octet.channel.createMediaTransport(octet.accountId);
    const plaintext = new Uint8Array(randomBytes(96));
    const uploaded = await transport.upload({ accountId: octet.accountId, conversationRef: "u", kind: "image", bytes: plaintext, mimeType: "image/png", filename: "a.png" });
    const downloaded = await transport.download({
      accountId: octet.accountId,
      handle: uploaded.handle,
      secretMaterial: uploaded.secretMaterial,
      expectedMimeType: "image/png",
    });
    assert.equal(Buffer.compare(Buffer.from(downloaded.bytes), Buffer.from(plaintext)), 0);
    assert.equal(downloaded.mimeType, "image/png", "没有明确媒体类型时用期望类型");
  } finally {
    await octet.close();
  }
});

test("tampered ciphertext and missing key fail as decryption errors without leaking material", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const transport = await stack.channel.createMediaTransport(stack.accountId);
    const plaintext = new Uint8Array(randomBytes(256));
    const uploaded = await transport.upload({ accountId: stack.accountId, conversationRef: "u", kind: "file", bytes: plaintext, mimeType: null, filename: null });
    const param = uploaded.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam]!;

    // 篡改 CDN 上保存的密文
    const stored = stack.cdn.stored.get(param)!;
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    stack.cdn.stored.set(param, tampered);

    await assert.rejects(
      () => transport.download({ accountId: stack.accountId, handle: uploaded.handle, secretMaterial: uploaded.secretMaterial }),
      (error: unknown) => {
        assert.equal(kindOf(error), "decryption_error");
        assert.equal((error as WeixinTransportError).retryable, false, "解密错误不能重试");
        return true;
      },
    );

    await assert.rejects(
      () => transport.download({ accountId: stack.accountId, handle: uploaded.handle, secretMaterial: {} }),
      (error: unknown) => kindOf(error) === "decryption_error",
    );

    // 从错误密钥解出的内容绝不能被当成成功结果
    const wrongKey = mediaKeyToProtocolBase64(new Uint8Array(randomBytes(16)));
    await assert.rejects(
      () =>
        transport.download({
          accountId: stack.accountId,
          handle: uploaded.handle,
          secretMaterial: { [MEDIA_SECRET_KEYS.mediaKey]: wrongKey, [MEDIA_SECRET_KEYS.encryptQueryParam]: param },
        }),
      (error: unknown) => kindOf(error) === "decryption_error",
    );

    assertNoSecretsInLogs(stack.logLines, [uploaded.secretMaterial[MEDIA_SECRET_KEYS.mediaKey]!, param, wrongKey]);
  } finally {
    await stack.close();
  }
});

test("media transport logs carry sizes but never payloads or credentials", async () => {
  const stack = await createWeixinMediaStack();
  try {
    const transport = await stack.channel.createMediaTransport(stack.accountId);
    const plaintext = new Uint8Array(randomBytes(512));
    const uploaded = await transport.upload({
      accountId: stack.accountId,
      conversationRef: "u",
      kind: "file",
      bytes: plaintext,
      mimeType: "application/pdf",
      filename: "report.pdf",
    });
    await transport.download({ accountId: stack.accountId, handle: uploaded.handle, secretMaterial: uploaded.secretMaterial });

    const joined = stack.logLines.join("\n");
    assert.match(joined, /cdn upload ok|media stored/, "应当有正向日志（尺寸/状态）");
    assertNoSecretsInLogs(stack.logLines, [
      // token / 密钥 / 参数 / 明文的各种常见编码形式都不允许出现
      "token-media-A",
      uploaded.secretMaterial[MEDIA_SECRET_KEYS.mediaKey]!,
      uploaded.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam]!,
      Buffer.from(plaintext).toString("base64"),
      Buffer.from(plaintext).toString("hex"),
    ]);
  } finally {
    await stack.close();
  }
});
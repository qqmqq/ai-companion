/**
 * Phase 4.5-C1 冒烟：真实进程 + 真实 HTTP + 真实 SQLite + 真实文件系统 + mock 微信后端/CDN/模型。
 *
 * 覆盖链路：
 *   入站：图片消息 → CDN 下载 → AES 解密 → 图片校验 → MediaStorage → Core 消息（占位符 [图片]）
 *   出站：Core 的 ImagePart → MediaStorage → CDN 上传 → image_item → sendmessage
 *
 * 用法：node scripts/phase45c1-smoke.ts [dataDir]
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { inboundImageMessage, startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyFromProtocolBase64, mediaKeyToHex } from "../src/channels/weixin/media/aes-media.ts";
import { ITEM_TYPE_IMAGE } from "../src/channels/weixin/protocol/types.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45c1-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};

/** 最小可用 PNG（签名 + IHDR + 若干字节），魔数与尺寸都合法，但内容不是真实图像。 */
function pngBytes(width: number, height: number): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return new Uint8Array(Buffer.concat([signature, ihdr, Buffer.from(randomBytes(96))]));
}

const cdn = await startMockCdnServer();
const weixin = await startMockWeixinServer({
  qrStatuses: ["confirmed"],
  botToken: "token-phase45c1",
  accountId: "wx-img-account",
  ilinkUserId: "self-img",
  cdnBaseUrl: cdn.baseUrl,
});
const llm = await startMockOpenAIServer({ chatReply: "（角色）图片我看到了，拍得不错。" });

const config = loadConfig({ COMPANION_DATA_DIR: dataDir, COMPANION_LOG_LEVEL: "warn", COMPANION_SCHEDULER_ENABLED: "false" });
const container = await createContainer({
  config,
  fetchImpl: fetch,
  settingsSeed: { "weixin.baseUrl": weixin.baseUrl, "weixin.cdnBaseUrl": cdn.baseUrl },
});
const app = createHttpServer(container);
await app.listen({ host: "127.0.0.1", port: 0 });
const bound = app.server.address();
if (bound === null || typeof bound === "string") throw new Error("no address");
const base = "http://127.0.0.1:" + String(bound.port);

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(path + " -> " + response.status + ": " + text.slice(0, 200));
  return (text.length === 0 ? null : JSON.parse(text)) as T;
};

try {
  await startChannels(container);
  log("DATA DIR: " + dataDir);
  log("MOCK WEIXIN: " + weixin.baseUrl + " / MOCK CDN: " + cdn.baseUrl);

  // 模型与角色：与 Phase 4 冒烟相同的准备步骤
  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: "smoke", kind: "openai-compatible", displayName: "本地 mock 模型", baseUrl: llm.baseUrl, defaultModel: "mock-chat", requiresCredential: false }),
  });
  for (const taskType of ["chat", "memory_extraction", "summarization", "proactive"]) {
    await json("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId: "smoke", model: "mock-chat" }) });
  }
  // 角色：原生定义内联构建（角色卡导入接口已删除）
  await json("/api/characters", { method: "POST", body: JSON.stringify({
      name: "Aria",
      description: "一个会记住你的角色",
      personality: "温柔、好奇",
      scenario: "小镇的咖啡馆",
      systemPrompt: "保持简洁，不要长篇大论。",
      firstMessage: "欢迎回来，今天想喝点什么？",
    }) });
  const characters = await json<{ items: Array<{ id: string; name: string }> }>("/api/characters");
  const character = characters.items[0]!;
  container.repos.settings.put("defaultCharacterId", character.id, container.clock.nowIso());

  const channel = container.channels.get("weixin") as WeixinChannel;
  const session = await channel.startLogin();
  await channel.pollLogin(session.sessionId);
  const { accountId } = await channel.completeLogin(session.sessionId);
  log("LOGIN: account=" + accountId);

  // ---------- 入站：微信发来一张图片 ----------
  const inboundKey = generateMediaKey();
  const inboundPng = pngBytes(64, 48);
  const inboundCipher = encryptMedia(inboundPng, inboundKey);
  cdn.stored.set("smoke-in-1", Buffer.from(inboundCipher));
  weixin.queueBatch({
    msgs: [
      inboundImageMessage({
        messageId: "9007199254740995",
        fromUserId: "wx-user-img",
        encryptQueryParam: "smoke-in-1",
        aesKeyHex: mediaKeyToHex(inboundKey),
        midSize: inboundCipher.byteLength,
        contextToken: "ctx-img-1",
      }),
    ],
    buffer: "cursor-img-1",
  });
  log("INBOUND: mock CDN 上是 " + inboundCipher.byteLength + " 字节密文（明文 " + inboundPng.byteLength + " 字节）");

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && weixin.sentMessages.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log("REPLY -> WEIXIN: \"" + (weixin.sentMessages[0]?.text ?? "(无)") + "\"");

  const conversations = await json<{ items: Array<{ id: string; channel: string }> }>("/api/conversations");
  const conversation = conversations.items.find((entry) => entry.channel === "weixin");
  if (conversation === undefined) throw new Error("微信会话没有创建");
  const messages = await json<{ items: Array<{ role: string; text: string; parts: Array<Record<string, unknown>> }> }>(
    "/api/conversations/" + conversation.id + "/messages",
  );
  const userMessage = messages.items.find((entry) => entry.role === "user");
  const imagePart = userMessage?.parts.find((part) => part.kind === "image") as
    | { media: { mediaId: string | null; status: string; mimeType: string | null; sizeBytes: number | null; width: number | null; height: number | null } }
    | undefined;
  if (imagePart === undefined) throw new Error("Core 里没有图片部件");
  log(
    "CORE IMAGE PART: status=" + imagePart.media.status +
      " mediaId=" + String(imagePart.media.mediaId).slice(0, 8) + "... mime=" + imagePart.media.mimeType +
      " size=" + imagePart.media.sizeBytes + " 尺寸=" + imagePart.media.width + "x" + imagePart.media.height,
  );
  log("CONTEXT RENDER: \"" + String(userMessage?.text) + "\"（占位符，无 [object Object]：" + !String(userMessage?.text).includes("[object Object]") + "）");

  const storedAsset = await container.mediaStorage.get(String(imagePart.media.mediaId));
  const bytesEqual = storedAsset !== null && Buffer.compare(Buffer.from(storedAsset.bytes), Buffer.from(inboundPng)) === 0;
  log("MEDIA STORAGE: 落库字节与原始图片完全一致=" + bytesEqual + " / checksum=" + (storedAsset?.checksum.slice(0, 12) ?? "-") + "...");

  const raw = container.db.raw as unknown as {
    prepare(sql: string): { get(...params: unknown[]): unknown };
  };
  const storedRow = raw.prepare("SELECT content_json FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1").get("user") as { content_json: string };
  const leaksBinary = storedRow.content_json.includes(Buffer.from(inboundPng).toString("base64")) || storedRow.content_json.includes("smoke-in-1");
  log("DB CHECK: content_json 里没有图片字节、也没有协议参数=" + !leaksBinary);

  // ---------- 出站：Core 的 ImagePart → 微信图片消息 ----------
  const outboundPng = pngBytes(32, 16);
  const asset = await container.mediaStorage.put({ bytes: outboundPng, mimeType: "image/png", filename: null, origin: "generated" });
  const receipt = await channel.send({
    channel: "weixin",
    accountId,
    conversationId: "wx-user-img",
    parts: [
      { kind: "text", text: "这张给你" },
      {
        kind: "image",
        media: {
          mediaId: asset.mediaId,
          mimeType: "image/png",
          filename: null,
          sizeBytes: asset.sizeBytes,
          width: 32,
          height: 16,
          durationMs: null,
          origin: "generated",
          status: "available",
          url: { kind: "internal", value: "media:" + asset.mediaId },
        },
      },
    ],
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey: "smoke-out-1",
  });
  const uploadCall = weixin.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
  const uploadBody = (uploadCall?.body ?? {}) as Record<string, unknown>;
  log("GETUPLOADURL: media_type=" + uploadBody.media_type + " rawsize=" + uploadBody.rawsize + " filesize=" + uploadBody.filesize + " no_need_thumb=" + uploadBody.no_need_thumb);

  const sentImage = weixin.sentMessages.at(-1)!;
  const item = sentImage.items[0]!;
  const imageItem = item.image_item as { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }; mid_size: number };
  log("SENT ITEM: type=" + item.type + "（图片=" + ITEM_TYPE_IMAGE + "）mid_size=" + imageItem.mid_size + " encrypt_type=" + imageItem.media.encrypt_type + " client_id=" + sentImage.client_id);
  const cipherOnCdn = cdn.stored.get(imageItem.media.encrypt_query_param);
  const decrypted = cipherOnCdn === undefined ? null : decryptMedia(new Uint8Array(cipherOnCdn), mediaKeyFromProtocolBase64(imageItem.media.aes_key));
  const roundTrip = decrypted !== null && Buffer.compare(Buffer.from(decrypted), Buffer.from(outboundPng)) === 0;
  log(
    "CDN 密文用消息里的 aes_key 可解回出站图片=" + roundTrip +
      " / 密钥 " + mediaKeyFromProtocolBase64(imageItem.media.aes_key).byteLength + " 字节 / receipt=" + receipt.providerMessageId,
  );

  log("PHASE 4.5-C1 SMOKE OK（入站图片落库，出站图片端到端可解密）");
} finally {
  await app.close();
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  await llm.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

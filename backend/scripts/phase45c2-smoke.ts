/**
 * Phase 4.5-C2 冒烟：真实进程 + 真实 HTTP + 真实 SQLite + 真实文件系统 + mock 微信后端/CDN/模型。
 *
 * 覆盖链路：
 *   入站：文件消息 → CDN 下载 → AES 解密 → 文件校验 → MediaStorage → Core 消息（占位符 [文件: 名字]）
 *   出站：Core 的 FilePart → MediaStorage → CDN 上传 → file_item → sendmessage
 *
 * 用法：node scripts/phase45c2-smoke.ts [dataDir]
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { inboundFileMessage, startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyFromProtocolBase64, mediaKeyToProtocolBase64 } from "../src/channels/weixin/media/aes-media.ts";
import { ITEM_TYPE_FILE } from "../src/channels/weixin/protocol/types.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45c2-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};

/** 含 0x00 / 0xFF / 0x01 / 0x80 的二进制：文件绝不能被当成文本处理 */
function binaryBytes(size: number): Uint8Array {
  const out = new Uint8Array(randomBytes(size));
  out[0] = 0x00;
  out[1] = 0xff;
  out[2] = 0x01;
  out[3] = 0x80;
  out[size - 1] = 0x00;
  return out;
}

const cdn = await startMockCdnServer();
const weixin = await startMockWeixinServer({
  qrStatuses: ["confirmed"],
  botToken: "token-phase45c2",
  accountId: "wx-file-account",
  ilinkUserId: "self-file",
  cdnBaseUrl: cdn.baseUrl,
});
const llm = await startMockOpenAIServer({ chatReply: "（角色）文件收到了，我看看。" });

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
  container.repos.settings.put("defaultCharacterId", characters.items[0]!.id, container.clock.nowIso());

  const channel = container.channels.get("weixin") as WeixinChannel;
  const session = await channel.startLogin();
  await channel.pollLogin(session.sessionId);
  const { accountId } = await channel.completeLogin(session.sessionId);
  log("LOGIN: account=" + accountId);

  // ---------- 入站：微信发来一个文件 ----------
  const inboundKey = generateMediaKey();
  const inboundBytes = binaryBytes(8192);
  const inboundCipher = encryptMedia(inboundBytes, inboundKey);
  cdn.stored.set("smoke-file-in-1", Buffer.from(inboundCipher));
  weixin.queueBatch({
    msgs: [
      inboundFileMessage({
        messageId: "9007199254740997",
        fromUserId: "wx-user-file",
        // 路径穿越尝试：必须被净化成纯文件名
        fileName: "../../etc/passwd", 
        len: String(inboundBytes.byteLength),
        encryptQueryParam: "smoke-file-in-1",
        mediaAesKey: mediaKeyToProtocolBase64(inboundKey),
        contextToken: "ctx-file-1",
      }),
    ],
    buffer: "cursor-file-1",
  });
  log("INBOUND: mock CDN 上是 " + inboundCipher.byteLength + " 字节密文（明文 " + inboundBytes.byteLength + " 字节）");

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
  const filePart = userMessage?.parts.find((part) => part.kind === "file") as
    | { media: { mediaId: string | null; status: string; mimeType: string | null; filename: string | null; sizeBytes: number | null; width: number | null } }
    | undefined;
  if (filePart === undefined) throw new Error("Core 里没有文件部件");
  log(
    "CORE FILE PART: status=" + filePart.media.status +
      " mediaId=" + String(filePart.media.mediaId).slice(0, 8) + "... mime=" + filePart.media.mimeType +
      " filename=" + filePart.media.filename + " size=" + filePart.media.sizeBytes + " width=" + String(filePart.media.width),
  );
  log("CONTEXT RENDER: \"" + String(userMessage?.text) + "\"（占位符，无 [object Object]：" + !String(userMessage?.text).includes("[object Object]") + "）");

  const storedAsset = await container.mediaStorage.get(String(filePart.media.mediaId));
  const bytesEqual = storedAsset !== null && Buffer.compare(Buffer.from(storedAsset.bytes), Buffer.from(inboundBytes)) === 0;
  log("MEDIA STORAGE: 落库字节与原始文件完全一致=" + bytesEqual + " / checksum=" + (storedAsset?.checksum.slice(0, 12) ?? "-") + "...");

  const raw = container.db.raw as unknown as { prepare(sql: string): { get(...params: unknown[]): unknown } };
  const storedRow = raw.prepare("SELECT content_json FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1").get("user") as { content_json: string };
  const leaksBinary = storedRow.content_json.includes(Buffer.from(inboundBytes).toString("base64")) || storedRow.content_json.includes("smoke-file-in-1");
  log("DB CHECK: content_json 里没有文件字节、也没有协议参数=" + !leaksBinary);

  // ---------- 出站：Core 的 FilePart → 微信文件消息 ----------
  const outboundBytes = binaryBytes(4096);
  const asset = await container.mediaStorage.put({ bytes: outboundBytes, mimeType: "application/pdf", filename: "报告.pdf", origin: "generated" });
  const receipt = await channel.send({
    channel: "weixin",
    accountId,
    conversationId: "wx-user-file",
    parts: [
      { kind: "text", text: "这份文件给你" },
      {
        kind: "file",
        media: {
          mediaId: asset.mediaId,
          mimeType: "application/pdf",
          filename: asset.filename,
          sizeBytes: asset.sizeBytes,
          width: null,
          height: null,
          durationMs: null,
          origin: "generated",
          status: "available",
          url: { kind: "internal", value: "media:" + asset.mediaId },
        },
      },
    ],
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey: "smoke-file-out-1",
  });
  const uploadCall = weixin.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
  const uploadBody = (uploadCall?.body ?? {}) as Record<string, unknown>;
  log("GETUPLOADURL: media_type=" + uploadBody.media_type + " rawsize=" + uploadBody.rawsize + " filesize=" + uploadBody.filesize + " no_need_thumb=" + uploadBody.no_need_thumb);

  const sentFile = weixin.sentMessages.at(-1)!;
  const item = sentFile.items[0]!;
  const fileItem = item.file_item as {
    media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
    file_name: string;
    len: string;
  };
  log(
    "SENT ITEM: type=" + item.type + "（文件=" + ITEM_TYPE_FILE + "）file_name=" + fileItem.file_name +
      " len=" + fileItem.len + "（类型 " + typeof fileItem.len + "）encrypt_type=" + fileItem.media.encrypt_type + " client_id=" + sentFile.client_id,
  );
  const cipherOnCdn = cdn.stored.get(fileItem.media.encrypt_query_param);
  const decrypted = cipherOnCdn === undefined ? null : decryptMedia(new Uint8Array(cipherOnCdn), mediaKeyFromProtocolBase64(fileItem.media.aes_key));
  const roundTrip = decrypted !== null && Buffer.compare(Buffer.from(decrypted), Buffer.from(outboundBytes)) === 0;
  log(
    "CDN 密文用消息里的 aes_key 可解回出站文件=" + roundTrip +
      " / 密钥 " + mediaKeyFromProtocolBase64(fileItem.media.aes_key).byteLength + " 字节 / receipt=" + receipt.providerMessageId,
  );

  log("PHASE 4.5-C2 SMOKE OK（入站文件落库，出站文件端到端可解密）");
} finally {
  await app.close();
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  await llm.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

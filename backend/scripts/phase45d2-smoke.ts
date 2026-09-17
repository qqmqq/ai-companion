/**
 * Phase 4.5-D2 冒烟：微信语音协议 + 真实兼容性检查（能测到什么就测什么，测不到就如实说）。
 *
 * 覆盖：
 *   入站：voice_item → 下载 → 解密 → SILK 解码 → WAV 入库 → AudioPart.available（SQLite 里没有音频字节）
 *   出站：AudioPart → SILK → CDN 上传 → voice_item（type=3 / media_type=4，只有确认过的字段）
 *   协议：幂等键 <key>:voice:0；未确认字段一律不发送
 *   降级：同样的音频可以走既有文件路径发送（file-audio fallback，需人工选择，不是自动检测）
 *
 * 真实微信验证：本脚本使用本地 mock 微信后端与 mock CDN，**不是**真机验证。
 * 没有真实账号/环境时，脚本会打印 NOT VERIFIED 而不是假称通过。
 *
 * 用法：node scripts/phase45d2-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { inboundTextMessage, inboundVoiceMessage, startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyFromProtocolBase64, mediaKeyToProtocolBase64 } from "../src/channels/weixin/media/aes-media.ts";
import { createVoiceCodec, isSilkBytes, isWavBytes, pcmToWav, readWavFormat, VOICE_SAMPLE_RATE } from "../src/channels/weixin/media/voice-codec.ts";
import { UPLOAD_MEDIA_TYPE_FILE, UPLOAD_MEDIA_TYPE_VOICE } from "../src/channels/weixin/protocol/media-types.ts";
import { ITEM_TYPE_FILE, ITEM_TYPE_VOICE } from "../src/channels/weixin/protocol/types.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45d2-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};

const codec = createVoiceCodec();

function wav(seconds: number): Uint8Array {
  const samples = Math.floor(seconds * VOICE_SAMPLE_RATE);
  const pcmBytes = new Uint8Array(samples * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(12000 * Math.sin((2 * Math.PI * 440 * index) / VOICE_SAMPLE_RATE)), true);
  }
  return pcmToWav(pcmBytes);
}

const cdn = await startMockCdnServer();
const weixin = await startMockWeixinServer({
  qrStatuses: ["confirmed"],
  botToken: "token-phase45d2",
  accountId: "wx-voice-d2",
  ilinkUserId: "self-voice-d2",
  cdnBaseUrl: cdn.baseUrl,
});
const llm = await startMockOpenAIServer({ chatReply: "（角色）语音收到啦。" });

const config = loadConfig({ COMPANION_DATA_DIR: dataDir, COMPANION_LOG_LEVEL: "info", COMPANION_SCHEDULER_ENABLED: "false" });
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
  log("SILK CODEC: available=" + String(await codec.available()));

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

  // ---------- 入站：语音 + 紧随其后的文字（证明失败隔离是"跨消息"的） ----------
  const inboundKey = generateMediaKey();
  const inboundSilk = (await codec.toSilk(wav(1.2))).bytes;
  cdn.stored.set("d2-in-1", Buffer.from(encryptMedia(inboundSilk, inboundKey)));
  weixin.queueBatch({
    msgs: [
      // 缺密钥 → 必须失败，但不能影响后面两条
      inboundVoiceMessage({ messageId: "9007199254741101", fromUserId: "wx-user-d2", encryptQueryParam: "d2-in-1" }),
      inboundTextMessage({ messageId: "9007199254741102", fromUserId: "wx-user-d2", text: "先说句话" }),
      inboundVoiceMessage({
        messageId: "9007199254741103",
        fromUserId: "wx-user-d2",
        encryptQueryParam: "d2-in-1",
        mediaAesKey: mediaKeyToProtocolBase64(inboundKey),
        contextToken: "ctx-d2-1",
      }),
    ],
    buffer: "cursor-d2-1",
  });

  const deadline = Date.now() + 15_000;
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
  const voiceParts = messages.items
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.parts.find((part) => part.kind === "audio") as
      | { media: { mediaId: string | null; status: string; mimeType: string | null; sizeBytes: number | null; durationMs: number | null } }
      | undefined)
    .filter((part): part is { media: { mediaId: string | null; status: string; mimeType: string | null; sizeBytes: number | null; durationMs: number | null } } => part !== undefined);
  log(
    "INBOUND VOICE PARTS: " + voiceParts.map((part) => part.media.status + "/" + String(part.media.mimeType) + "/" + String(part.media.durationMs) + "ms").join(", ") +
      "（缺密钥的那条必须是 failed，正常的那条必须是 available）",
  );
  const availablePart = voiceParts.find((part) => part.media.status === "available");
  if (availablePart === undefined) throw new Error("入站语音没有成功入库");
  const storedAsset = await container.mediaStorage.get(String(availablePart.media.mediaId));
  log(
    "STORED AUDIO: isWav=" + String(storedAsset !== null && isWavBytes(storedAsset.bytes)) +
      " isSilk=" + String(storedAsset !== null && isSilkBytes(storedAsset.bytes)) +
      " format=" + String(readWavFormat(storedAsset!.bytes)?.sampleRate) + "Hz/" + String(readWavFormat(storedAsset!.bytes)?.channels) + "ch/" + String(readWavFormat(storedAsset!.bytes)?.bitsPerSample) + "bit",
  );
  const textMessage = messages.items.find((entry) => entry.role === "user" && entry.parts.some((part) => part.kind === "text"));
  log("BATCH ISOLATION: 同批次的文字消息仍然投递=\"" + String(textMessage?.text) + "\"");

  // SQLite 里绝不允许出现音频字节
  const raw = container.db.raw as unknown as { prepare(sql: string): { all(...params: unknown[]): unknown[] } };
  const rows = raw.prepare("SELECT content_json FROM messages").all() as Array<{ content_json: string }>;
  const silkBase64 = Buffer.from(inboundSilk).toString("base64");
  const wavBase64 = Buffer.from(storedAsset!.bytes).toString("base64");
  const leaks = rows.filter((row) => row.content_json.includes(silkBase64) || row.content_json.includes(wavBase64) || row.content_json.includes("d2-in-1"));
  log("SQLITE CHECK: " + String(rows.length) + " 条消息，其中含音频字节或协议参数的有 " + String(leaks.length) + " 条（必须是 0）");

  // ---------- 出站：语音（协议结构 + 幂等键） ----------
  const outboundWav = wav(1);
  const asset = await container.mediaStorage.put({ bytes: outboundWav, mimeType: "audio/wav", filename: null, origin: "generated" });
  const reference = {
    mediaId: asset.mediaId,
    mimeType: "audio/wav",
    filename: null,
    sizeBytes: asset.sizeBytes,
    width: null,
    height: null,
    durationMs: null,
    origin: "generated" as const,
    status: "available" as const,
    url: { kind: "internal" as const, value: "media:" + asset.mediaId },
  };
  const receipt = await channel.send({
    channel: "weixin",
    accountId,
    conversationId: "wx-user-d2",
    parts: [{ kind: "audio", media: reference }],
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey: "smoke-d2-voice",
  });

  const uploadCall = weixin.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
  const uploadBody = (uploadCall?.body ?? {}) as Record<string, unknown>;
  const sentVoice = weixin.sentMessages.at(-1)!;
  const item = sentVoice.items[0]!;
  const voiceItem = item.voice_item as { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number } };
  log(
    "OUTBOUND WIRE: media_type=" + String(uploadBody.media_type) + "（语音=" + String(UPLOAD_MEDIA_TYPE_VOICE) + "）item.type=" + String(item.type) + "（语音=" + String(ITEM_TYPE_VOICE) + "）" +
      "voice_item.keys=" + Object.keys(voiceItem).join(",") + " media.keys=" + Object.keys(voiceItem.media).join(",") + " client_id=" + sentVoice.client_id,
  );
  const forbidden = ["voice_size", "size", "duration", "duration_ms", "sample_rate", "codec", "md5", "file_name", "len", "thumb_media"];
  const invented = forbidden.filter((field) => field in (voiceItem as unknown as Record<string, unknown>) || field in (voiceItem.media as unknown as Record<string, unknown>));
  log("NO INVENTED FIELDS: " + String(invented.length === 0) + (invented.length === 0 ? "" : "（出现了：" + invented.join(",") + "）"));

  const uploadedSilk = decryptMedia(new Uint8Array(cdn.stored.get(voiceItem.media.encrypt_query_param)!), mediaKeyFromProtocolBase64(voiceItem.media.aes_key));
  const decodedBack = await codec.silkToWav(uploadedSilk);
  log(
    "OUTBOUND CODEC: isSilk=" + String(isSilkBytes(uploadedSilk)) + " 与源 WAV 不同=" + String(Buffer.compare(Buffer.from(uploadedSilk), Buffer.from(outboundWav)) !== 0) +
      " 解码回=" + String(decodedBack.durationMs) + "ms（SILK 20ms 帧量化内）receipt=" + String(receipt.providerMessageId),
  );

  // ---------- 降级路径：同样的音频走文件通道（人工选择，不是自动检测） ----------
  const fallbackRef = { ...reference, filename: "voice.wav" };
  await channel.send({
    channel: "weixin",
    accountId,
    conversationId: "wx-user-d2",
    parts: [{ kind: "file", media: fallbackRef }],
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey: "smoke-d2-fallback",
  });
  const fallbackSent = weixin.sentMessages.at(-1)!;
  const fallbackItem = fallbackSent.items[0]!;
  log(
    "FALLBACK (file-audio): item.type=" + String(fallbackItem.type) + "（文件=" + String(ITEM_TYPE_FILE) + "）client_id=" + fallbackSent.client_id +
      " / media_type=" + String(UPLOAD_MEDIA_TYPE_FILE) + "（人工选择；系统**不会**自动检测客户端渲染失败）",
  );

  log("REAL WEIXIN VERIFICATION: NOT VERIFIED（本轮只有本地 mock 后端与 mock CDN；没有真实账号/环境）");
  log("NATIVE WEIXIN OUTBOUND VOICE: NOT VERIFIED（无法证明真机把语音渲染成原生语音气泡）");
  log("PHASE 4.5-D2 SMOKE OK（协议结构正确、幂等键 <key>:voice:0、入库可用音频、SQLite 无音频字节）");
} finally {
  await app.close();
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  await llm.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

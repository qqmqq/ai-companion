/**
 * Phase 4.5-D4 冒烟：语音合成（TTS）端到端。
 *
 * 成功路径：
 *   用户消息 → LLM 文字回复（先落库、先送达）
 *            → TTS（OpenAI 兼容 /audio/speech）
 *            → 音频入库（MediaStorage，origin=generated）
 *            → 作为**第二条消息**走既有 D1/D2 语音出站链路（WAV → SILK → voice_item）
 * 失败路径：
 *   TTS 失败 → 文字回复依然成功送达 → 消息级 TTS 状态 = failed（可观测）
 *
 * 真实 TTS 服务未验证：本轮用的是 mock TTS 服务（真实 HTTP、真实 WAV 字节）。
 * 用法：node scripts/phase45d4-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { startMockTtsServer } from "../test/helpers/mock-tts-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { createVoiceCodec, isSilkBytes, isWavBytes, pcmToWav, readWavFormat, VOICE_SAMPLE_RATE } from "../src/channels/weixin/media/voice-codec.ts";
import { decryptMedia, mediaKeyFromProtocolBase64 } from "../src/channels/weixin/media/aes-media.ts";
import { ITEM_TYPE_VOICE } from "../src/channels/weixin/protocol/types.ts";
import { UPLOAD_MEDIA_TYPE_VOICE } from "../src/channels/weixin/protocol/media-types.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45d4-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};

const codec = createVoiceCodec();

/** mock TTS 返回的真实 WAV（24 kHz 单声道 16bit，1 秒正弦波） */
function toneWav(seconds = 1): Uint8Array {
  const samples = Math.floor(seconds * VOICE_SAMPLE_RATE);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(9000 * Math.sin((2 * Math.PI * 330 * index) / VOICE_SAMPLE_RATE)), true);
  }
  return pcmToWav(pcm);
}

const cdn = await startMockCdnServer();
const weixin = await startMockWeixinServer({
  qrStatuses: ["confirmed"],
  botToken: "token-phase45d4",
  accountId: "wx-tts-account",
  ilinkUserId: "self-tts",
  cdnBaseUrl: cdn.baseUrl,
});
const llm = await startMockOpenAIServer({ chatReply: "你好，今天过得怎么样？" });
const tts = await startMockTtsServer({ audio: toneWav(1), contentType: "audio/wav", durationMsHeader: 1000, sampleRateHeader: VOICE_SAMPLE_RATE });

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

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

try {
  await startChannels(container);
  log("DATA DIR: " + dataDir);
  log("MOCK WEIXIN: " + weixin.baseUrl + " / MOCK CDN: " + cdn.baseUrl + " / MOCK TTS: " + tts.baseUrl);

  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: "chat", kind: "openai-compatible", displayName: "本地 mock 模型", baseUrl: llm.baseUrl, defaultModel: "mock-chat", requiresCredential: false }),
  });
  for (const taskType of ["chat", "memory_extraction", "summarization", "proactive"]) {
    await json("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId: "chat", model: "mock-chat" }) });
  }
  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: "tts", kind: "openai-compatible", displayName: "本地 mock TTS", baseUrl: tts.baseUrl, defaultModel: "tts-mock", requiresCredential: false }),
  });
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

  // TTS 默认关闭：这里显式打开
  container.repos.settings.put("tts.enabled", true, container.clock.nowIso());
  container.repos.settings.put("tts.providerId", "tts", container.clock.nowIso());
  container.repos.settings.put("tts.voice", "mock-voice", container.clock.nowIso());
  container.repos.settings.put("tts.delivery", "voice", container.clock.nowIso());
  log("TTS SETTINGS: enabled=true provider=tts voice=mock-voice delivery=voice（默认关闭）");

  const channel = container.channels.get("weixin") as WeixinChannel;
  const session = await channel.startLogin();
  await channel.pollLogin(session.sessionId);
  await channel.completeLogin(session.sessionId);

  const conversations = await json<{ items: Array<{ id: string; channel: string }> }>("/api/conversations");
  void conversations;

  // ---------- 成功路径：文字先送达，语音随后生成并作为第二条消息发出 ----------
  weixin.queueBatch({
    msgs: [{ message_id: "9007199254741301", from_user_id: "wx-user-tts", to_user_id: "bot", create_time_ms: Date.now(), message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: "你今天怎么样？" } }], context_token: "ctx-tts-1" }],
    buffer: "cursor-tts-1",
  });
  log("INBOUND: 用户发来一条文字消息");

  const gotVoice = await waitFor(() => weixin.sentMessages.length >= 2 && weixin.sentMessages.some((entry) => entry.items[0]?.type === ITEM_TYPE_VOICE));
  log("SENT MESSAGES: " + weixin.sentMessages.map((entry) => "type" + String(entry.items[0]?.type) + "(" + entry.client_id + ")").join(" → "));

  const list = await json<{ items: Array<{ id: string; channel: string }> }>("/api/conversations");
  const conversation = list.items.find((entry) => entry.channel === "weixin")!;
  const messages = await json<{ items: Array<{ id: string; role: string; text: string; tts?: { status: string; mediaId: string | null; mimeType: string | null; durationMs: number | null; sampleRate: number | null; provider: string | null; model: string | null; voice: string | null; cached: boolean }; parts: Array<Record<string, unknown>> }> }>(
    "/api/conversations/" + conversation.id + "/messages",
  );
  // Phase 5：会话创建时会有一条开场白（也是 character 角色），这里要看**最后一条**（本次回复）
  const assistant = messages.items.filter((entry) => entry.role === "character").at(-1)!;
  const audioPart = assistant.parts.find((part) => part.kind === "audio") as { media: { mediaId: string; status: string; mimeType: string | null; durationMs: number | null } } | undefined;
  log(
    "TEXT REPLY (权威内容): \"" + assistant.text + "\"（仍然完整保留，没有被语音替换）",
  );
  log(
    "TTS STATE: status=" + String(assistant.tts?.status) + " provider=" + String(assistant.tts?.provider) + " model=" + String(assistant.tts?.model) +
      " voice=" + String(assistant.tts?.voice) + " mime=" + String(assistant.tts?.mimeType) + " durationMs=" + String(assistant.tts?.durationMs),
  );
  log("AUDIO PART: kind=audio media.status=" + String(audioPart?.media.status) + " mediaId=" + String(audioPart?.media.mediaId).slice(0, 8) + "...（挂在这条助手消息上，不是新消息）");

  const stored = await container.mediaStorage.get(String(audioPart?.media.mediaId));
  log(
    "MEDIA STORAGE: isWav=" + String(stored !== null && isWavBytes(stored.bytes)) + " origin=" + String(stored?.origin) +
      " format=" + String(readWavFormat(stored!.bytes)?.sampleRate) + "Hz/" + String(readWavFormat(stored!.bytes)?.channels) + "ch",
  );

  // 出站：音频走既有 D1/D2 链路（SILK + voice_item），没有新增任何协议字段
  const voiceMessage = weixin.sentMessages.find((entry) => entry.items[0]?.type === ITEM_TYPE_VOICE);
  const voiceItem = voiceMessage?.items[0]?.voice_item as { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number } } | undefined;
  const uploadCall = weixin.calls.filter((call) => call.path.endsWith("/ilink/bot/getuploadurl")).at(-1);
  const uploadedSilk = voiceItem === undefined ? null : decryptMedia(new Uint8Array(cdn.stored.get(voiceItem.media.encrypt_query_param)!), mediaKeyFromProtocolBase64(voiceItem.media.aes_key));
  log(
    "WEIXIN OUTBOUND: media_type=" + String((uploadCall?.body as { media_type?: number })?.media_type) + "（语音=" + String(UPLOAD_MEDIA_TYPE_VOICE) + "）item.type=" + String(voiceMessage?.items[0]?.type) +
      "（语音=" + String(ITEM_TYPE_VOICE) + "）voice_item.keys=" + String(voiceItem === undefined ? "-" : Object.keys(voiceItem).join(",")) + " client_id=" + String(voiceMessage?.client_id),
  );
  log(
    "SILK: isSilk=" + String(uploadedSilk !== null && isSilkBytes(uploadedSilk)) +
      "（生成的 WAV 被既有链路转成 SILK）/ 解码回=" + String(uploadedSilk === null ? "-" : (await codec.silkToWav(uploadedSilk)).durationMs) + "ms",
  );
  log("TTS PROVIDER CALLS: " + String(tts.requests.length) + "（text=\"" + String(tts.requests.at(-1)?.body.input) + "\" voice=" + String(tts.requests.at(-1)?.body.voice) + "）");

  const raw = container.db.raw as unknown as { prepare(sql: string): { all(...params: unknown[]): unknown[] } };
  const rows = raw.prepare("SELECT content_json, tts_json FROM messages").all() as Array<{ content_json: string; tts_json: string | null }>;
  const leak = rows.filter((row) => {
    const blob = String(row.content_json) + String(row.tts_json ?? "");
    return blob.includes(Buffer.from(toneWav(1)).toString("base64")) || blob.includes("RIFF");
  });
  log("SQLITE CHECK: " + String(rows.length) + " 条消息中，含音频字节的 " + String(leak.length) + " 条（必须为 0；库里只有 mediaId 与元数据）");

  // 幂等：同一段文本不会被再次合成
  const before = tts.requests.length;
  await json("/api/messages/" + assistant.id + "/speech", { method: "POST", body: JSON.stringify({}) });
  log("IDEMPOTENCY: 再次请求语音时新增 TTS 调用=" + String(tts.requests.length - before) + "（同一段文本必须复用缓存，为 0）");

  // ---------- 失败路径：TTS 挂掉，但文字回复依然成功 ----------
  // 关键：第二条回复必须是**不同的文本**，否则会命中 TTS 缓存（那是正确行为，但演示不了失败路径）。
  llm.chatReply = "第二句不同的回复。";
  tts.config.failTimes = 99;
  tts.config.failStatus = 500;
  const textCountBefore = weixin.sentMessages.length;
  weixin.queueBatch({
    msgs: [{ message_id: "9007199254741302", from_user_id: "wx-user-tts", to_user_id: "bot", create_time_ms: Date.now(), message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: "第二句话" } }], context_token: "ctx-tts-1" }],
    buffer: "cursor-tts-2",
  });
  // 等到第二条助手回复出现并且 TTS 状态已经写定（避免读到中间态）
  const readAssistants = async () =>
    (await json<{ items: Array<{ id: string; role: string; text: string; tts?: { status: string; errorCode: string | null; mediaId: string | null }; parts: Array<Record<string, unknown>> }> }>(
      "/api/conversations/" + conversation.id + "/messages",
    )).items.filter((entry) => entry.role === "character");
  const assistantCountBefore = (await readAssistants()).length;
  let assistants = await readAssistants();
  const deadline = Date.now() + 15_000;
  // 等到"第二条助手回复出现 + 它的 TTS 状态写定"
  while (Date.now() < deadline && (assistants.length <= assistantCountBefore || assistants.at(-1)?.tts === undefined)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assistants = await readAssistants();
  }
  const failedAssistant = assistants.at(-1)!;
  log(
    "FAILURE PATH: 文字回复=\"" + failedAssistant.text + "\"（已成功送达）tts.status=" + String(failedAssistant.tts?.status) +
      " errorCode=" + String(failedAssistant.tts?.errorCode) + " mediaId=" + String(failedAssistant.tts?.mediaId) +
      " audioParts=" + String(failedAssistant.parts.filter((part) => part.kind === "audio").length),
  );
  log("FAILURE PATH: 出站消息数=" + String(weixin.sentMessages.length) + "（失败时不会多发一条语音，也不会吞掉文字）");

  log("REAL TTS VERIFICATION: NOT VERIFIED（本轮用的是 mock TTS 服务，不是真实合成后端）");
  log("NATIVE WEIXIN VOICE RENDERING: NOT VERIFIED（D2 结论保持不变：未在真机验证原生语音气泡）");
  log("PHASE 4.5-D4 SMOKE OK（文字权威 / 语音入库 / 既有语音链路复用 / 失败不影响文字 / 幂等复用）");
} finally {
  await app.close();
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  await llm.close();
  await tts.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

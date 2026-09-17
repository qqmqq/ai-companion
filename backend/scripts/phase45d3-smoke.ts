/**
 * Phase 4.5-D3 冒烟：语音转写（ASR）端到端。
 *
 * 真实进程 + 真实 HTTP + 真实 SQLite + 真实文件系统 + 真实 silk-wasm + mock 微信后端/CDN/模型/ASR 服务。
 *
 * 成功路径：
 *   微信语音 → 下载 → SLK 解码 → WAV 入库 → AudioPart.available
 *            → ASR（OpenAI 兼容 /audio/transcriptions）
 *            → transcription.completed → 进入模型上下文
 * 失败路径：
 *   ASR 失败 → AudioPart 仍然 available → 消息照常处理（转写状态可观测）
 *
 * 注意：mock ASR 服务**不是**真实语音识别；真实 ASR 服务未验证（报告里如实标注）。
 * 用法：node scripts/phase45d3-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { inboundVoiceMessage, startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { startMockAsrServer } from "../test/helpers/mock-asr-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { encryptMedia, generateMediaKey, mediaKeyToProtocolBase64 } from "../src/channels/weixin/media/aes-media.ts";
import { createVoiceCodec, pcmToWav, VOICE_SAMPLE_RATE } from "../src/channels/weixin/media/voice-codec.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45d3-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};

const codec = createVoiceCodec();

function wav(seconds: number): Uint8Array {
  const samples = Math.floor(seconds * VOICE_SAMPLE_RATE);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(12000 * Math.sin((2 * Math.PI * 440 * index) / VOICE_SAMPLE_RATE)), true);
  }
  return pcmToWav(pcm);
}

const cdn = await startMockCdnServer();
const weixin = await startMockWeixinServer({
  qrStatuses: ["confirmed"],
  botToken: "token-phase45d3",
  accountId: "wx-asr-account",
  ilinkUserId: "self-asr",
  cdnBaseUrl: cdn.baseUrl,
});
const llm = await startMockOpenAIServer({ chatReply: "（角色）我听到你说的话了。" });
const asr = await startMockAsrServer({ transcription: "今天天气不错，我们一起出去走走吧", language: "zh", durationSeconds: 1.2, confidence: 0.97, model: "whisper-mock" });

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
  log("MOCK WEIXIN: " + weixin.baseUrl + " / MOCK CDN: " + cdn.baseUrl + " / MOCK ASR: " + asr.baseUrl);

  // 模型（chat）与 ASR（转写）分别配置：ASR 复用同一套 provider 配置体系
  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: "chat", kind: "openai-compatible", displayName: "本地 mock 模型", baseUrl: llm.baseUrl, defaultModel: "mock-chat", requiresCredential: false }),
  });
  for (const taskType of ["chat", "memory_extraction", "summarization", "proactive"]) {
    await json("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId: "chat", model: "mock-chat" }) });
  }
  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: "asr", kind: "openai-compatible", displayName: "本地 mock ASR", baseUrl: asr.baseUrl, defaultModel: "whisper-mock", requiresCredential: false }),
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

  // ASR 配置（走项目既有 settings 约定；默认是关闭的）
  container.repos.settings.put("asr.enabled", true, container.clock.nowIso());
  container.repos.settings.put("asr.providerId", "asr", container.clock.nowIso());
  container.repos.settings.put("asr.language", "zh", container.clock.nowIso());
  log("ASR SETTINGS: enabled=true provider=asr language=zh（默认关闭；这里显式打开）");

  const channel = container.channels.get("weixin") as WeixinChannel;
  const session = await channel.startLogin();
  await channel.pollLogin(session.sessionId);
  const { accountId } = await channel.completeLogin(session.sessionId);
  log("LOGIN: account=" + accountId);

  // ---------- 成功路径 ----------
  const key = generateMediaKey();
  const silk = (await codec.toSilk(wav(1.2))).bytes;
  cdn.stored.set("d3-ok", Buffer.from(encryptMedia(silk, key)));
  weixin.queueBatch({
    msgs: [
      inboundVoiceMessage({
        messageId: "9007199254741201",
        fromUserId: "wx-user-asr",
        encryptQueryParam: "d3-ok",
        mediaAesKey: mediaKeyToProtocolBase64(key),
        contextToken: "ctx-asr-1",
      }),
    ],
    buffer: "cursor-asr-1",
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && weixin.sentMessages.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const conversations = await json<{ items: Array<{ id: string; channel: string }> }>("/api/conversations");
  const conversation = conversations.items.find((entry) => entry.channel === "weixin");
  if (conversation === undefined) throw new Error("微信会话没有创建");
  const messages = await json<{ items: Array<{ id: string; role: string; text: string; parts: Array<Record<string, unknown>> }> }>(
    "/api/conversations/" + conversation.id + "/messages",
  );
  const userMessage = messages.items.find((entry) => entry.role === "user")!;
  const audioPart = userMessage.parts.find((part) => part.kind === "audio") as
    | {
        media: { mediaId: string; status: string; mimeType: string | null; durationMs: number | null };
        transcription?: { status: string; text: string | null; language: string | null; durationMs: number | null; confidence: number | null; provider: string | null; model: string | null; cached: boolean };
      }
    | undefined;
  if (audioPart === undefined) throw new Error("Core 里没有语音部件");
  const state = audioPart.transcription;
  log(
    "SUCCESS PATH: media.status=" + audioPart.media.status + "（音频仍然可用）transcription.status=" + String(state?.status) +
      " language=" + String(state?.language) + " confidence=" + String(state?.confidence) + " provider=" + String(state?.provider) + " model=" + String(state?.model),
  );
  log("TRANSCRIPT (进入消息文本): \"" + String(state?.text) + "\"");
  log("MESSAGE TEXT RENDER: \"" + userMessage.text + "\"");
  log("REPLY -> WEIXIN: \"" + (weixin.sentMessages[0]?.text ?? "(无)") + "\"（模型看到的是转写文本，不是 [语音] 占位符）");
  log("MOCK ASR CALLS: " + String(asr.requests.length) + "，语言提示=" + String(asr.requests.at(-1)?.fields.language) + "，音频字节=" + String(asr.requests.at(-1)?.fileBytes));

  const raw = container.db.raw as unknown as { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };
  const rows = raw.prepare("SELECT content_json FROM messages").all() as Array<{ content_json: string }>;
  const leaks = rows.filter((row) => row.content_json.includes(Buffer.from(silk).toString("base64")) || row.content_json.includes(Buffer.from(wav(1.2)).toString("base64")) || row.content_json.includes("d3-ok"));
  log("SQLITE CHECK: " + String(rows.length) + " 条消息中，含音频字节/协议参数的 " + String(leaks.length) + " 条（必须为 0）");

  // 幂等：同一音频不会被识别第二次
  const before = asr.requests.length;
  await json("/api/messages/" + userMessage.id + "/transcribe", { method: "POST", body: JSON.stringify({}) });
  log("IDEMPOTENCY: 再次触发转写时新增的 ASR 调用次数=" + String(asr.requests.length - before) + "（已完成的同一音频必须复用，为 0）");

  // ---------- 失败路径 ----------
  asr.config.failTimes = 99;
  asr.config.failStatus = 500;
  const key2 = generateMediaKey();
  cdn.stored.set("d3-fail", Buffer.from(encryptMedia(silk, key2)));
  weixin.queueBatch({
    msgs: [
      inboundVoiceMessage({
        messageId: "9007199254741202",
        fromUserId: "wx-user-asr",
        encryptQueryParam: "d3-fail",
        mediaAesKey: mediaKeyToProtocolBase64(key2),
        contextToken: "ctx-asr-1",
      }),
    ],
    buffer: "cursor-asr-2",
  });
  const deadline2 = Date.now() + 15_000;
  while (Date.now() < deadline2 && weixin.sentMessages.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const messages2 = await json<{ items: Array<{ role: string; text: string; parts: Array<Record<string, unknown>> }> }>(
    "/api/conversations/" + conversation.id + "/messages",
  );
  const failedAudio = messages2.items
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.parts.find((part) => part.kind === "audio") as { media: { status: string }; transcription?: { status: string; errorCode: string | null } } | undefined)
    .filter((part): part is { media: { status: string }; transcription?: { status: string; errorCode: string | null } } => part !== undefined)
    .at(-1)!;
  log(
    "FAILURE PATH: media.status=" + failedAudio.media.status + "（音频必须仍然 available）transcription.status=" + String(failedAudio.transcription?.status) +
      " errorCode=" + String(failedAudio.transcription?.errorCode) + "（错误必须可观测，不能变成空文本）",
  );
  log("FAILURE PATH: 消息仍然被处理，回复条数=" + String(weixin.sentMessages.length));

  log("REAL ASR VERIFICATION: NOT VERIFIED（本轮用的是 mock ASR 服务，不是真实识别后端）");
  log("PHASE 4.5-D3 SMOKE OK（转写成功进入上下文 / 失败不影响音频 / SQLite 无音频字节 / 幂等复用）");
} finally {
  await app.close();
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  await llm.close();
  await asr.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

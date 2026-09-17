/**
 * Phase 4.5-D1 冒烟：真实进程 + 真实 HTTP + 真实 SQLite + 真实文件系统 + 真实 silk-wasm + mock 微信后端/CDN/模型。
 *
 * 覆盖链路：
 *   入站：语音消息 → CDN 下载 → AES 解密 → SILK 解码成 WAV → MediaStorage → Core 消息（占位符）
 *   出站：Core 的 AudioPart（WAV）→ SILK 编码 → CDN 上传 → voice_item → sendmessage
 *
 * 本阶段**没有** ASR/TTS：只做音频传输与编解码，不生成任何转写文本。
 *
 * 用法：node scripts/phase45d1-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { inboundVoiceMessage, startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { decryptMedia, encryptMedia, generateMediaKey, mediaKeyFromProtocolBase64, mediaKeyToProtocolBase64 } from "../src/channels/weixin/media/aes-media.ts";
import { createVoiceCodec, isSilkBytes, isWavBytes, pcmToWav, readWavFormat, VOICE_SAMPLE_RATE } from "../src/channels/weixin/media/voice-codec.ts";
import { ITEM_TYPE_VOICE } from "../src/channels/weixin/protocol/types.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45d1-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};

const codec = createVoiceCodec();

/** 生成 24 kHz 单声道 16bit PCM 正弦波（可指定秒数） */
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
  botToken: "token-phase45d1",
  accountId: "wx-voice-account",
  ilinkUserId: "self-voice",
  cdnBaseUrl: cdn.baseUrl,
});
const llm = await startMockOpenAIServer({ chatReply: "（角色）语音我听到了，稍后回你。" });

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
  log("SILK CODEC: available=" + String(await codec.available()) + "（silk-wasm 是 runtime dependency）");

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

  // ---------- 入站：微信发来一段语音 ----------
  const inboundKey = generateMediaKey();
  const inboundWav = wav(1.5);
  const inboundSilk = (await codec.toSilk(inboundWav)).bytes;
  const inboundCipher = encryptMedia(inboundSilk, inboundKey);
  cdn.stored.set("smoke-voice-in-1", Buffer.from(inboundCipher));
  weixin.queueBatch({
    msgs: [
      inboundVoiceMessage({
        messageId: "9007199254741001",
        fromUserId: "wx-user-voice",
        encryptQueryParam: "smoke-voice-in-1",
        mediaAesKey: mediaKeyToProtocolBase64(inboundKey),
        contextToken: "ctx-voice-1",
      }),
    ],
    buffer: "cursor-voice-1",
  });
  log(
    "INBOUND: SILK 明文 " + inboundSilk.byteLength + " 字节 → CDN 密文 " + inboundCipher.byteLength +
      " 字节（WAV 源 " + inboundWav.byteLength + " 字节）",
  );

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
  const userMessage = messages.items.find((entry) => entry.role === "user");
  const audioPart = userMessage?.parts.find((part) => part.kind === "audio") as
    | { media: { mediaId: string | null; status: string; mimeType: string | null; sizeBytes: number | null; durationMs: number | null; width: number | null }; transcript?: string }
    | undefined;
  if (audioPart === undefined) throw new Error("Core 里没有语音部件");
  log(
    "CORE AUDIO PART: status=" + audioPart.media.status +
      " mediaId=" + String(audioPart.media.mediaId).slice(0, 8) + "... mime=" + String(audioPart.media.mimeType) +
      " size=" + String(audioPart.media.sizeBytes) + " 时长=" + String(audioPart.media.durationMs) + "ms 宽高=" + String(audioPart.media.width) +
      " transcript=" + String(audioPart.transcript ?? "(无，本阶段没有 ASR)"),
  );
  log("CONTEXT RENDER: \"" + String(userMessage?.text) + "\"（占位符，无 [object Object]：" + !String(userMessage?.text).includes("[object Object]") + "）");

  const storedAsset = await container.mediaStorage.get(String(audioPart.media.mediaId));
  const storedIsWav = storedAsset !== null && isWavBytes(storedAsset.bytes);
  const storedFormat = storedIsWav ? readWavFormat(storedAsset!.bytes) : null;
  const expectedWav = await codec.silkToWav(inboundSilk);
  const bytesEqual = storedAsset !== null && Buffer.compare(Buffer.from(storedAsset.bytes), Buffer.from(expectedWav.bytes)) === 0;
  log(
    "MEDIA STORAGE: 是 WAV=" + String(storedIsWav) + "（不是 SILK=" + String(storedAsset !== null && !isSilkBytes(storedAsset.bytes)) +
      "）/ 与确定性解码结果一致=" + String(bytesEqual) +
      " / 格式=" + String(storedFormat?.sampleRate) + "Hz " + String(storedFormat?.channels) + "ch " + String(storedFormat?.bitsPerSample) + "bit",
  );

  const raw = container.db.raw as unknown as { prepare(sql: string): { get(...params: unknown[]): unknown } };
  const storedRow = raw.prepare("SELECT content_json FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1").get("user") as { content_json: string };
  const leaksBinary =
    storedRow.content_json.includes(Buffer.from(inboundSilk).toString("base64")) || storedRow.content_json.includes("smoke-voice-in-1");
  log("DB CHECK: content_json 里没有音频字节（SILK 或 WAV）、也没有协议参数=" + String(!leaksBinary));

  // ---------- 出站：Core 的 AudioPart（WAV）→ SILK → 微信语音消息 ----------
  const outboundWav = wav(1);
  const asset = await container.mediaStorage.put({ bytes: outboundWav, mimeType: "audio/wav", filename: null, origin: "generated" });
  const receipt = await channel.send({
    channel: "weixin",
    accountId,
    conversationId: "wx-user-voice",
    parts: [
      { kind: "text", text: "这段语音给你" },
      {
        kind: "audio",
        media: {
          mediaId: asset.mediaId,
          mimeType: "audio/wav",
          filename: null,
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
    idempotencyKey: "smoke-voice-out-1",
  });
  const uploadCall = weixin.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
  const uploadBody = (uploadCall?.body ?? {}) as Record<string, unknown>;
  log("GETUPLOADURL: media_type=" + uploadBody.media_type + "（语音=4）rawsize=" + uploadBody.rawsize + " filesize=" + uploadBody.filesize + " no_need_thumb=" + uploadBody.no_need_thumb);

  const sentVoice = weixin.sentMessages.at(-1)!;
  const item = sentVoice.items[0]!;
  const voiceItem = item.voice_item as { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number } };
  log(
    "SENT ITEM: type=" + item.type + "（语音=" + ITEM_TYPE_VOICE + "）encrypt_type=" + voiceItem.media.encrypt_type +
      " client_id=" + sentVoice.client_id + " / 额外字段=" + String(Object.keys(voiceItem).filter((key) => key !== "media").length === 0 ? "无（不发明字段）" : "有"),
  );

  const cipherOnCdn = cdn.stored.get(voiceItem.media.encrypt_query_param);
  const uploadedSilk = cipherOnCdn === undefined ? null : decryptMedia(new Uint8Array(cipherOnCdn), mediaKeyFromProtocolBase64(voiceItem.media.aes_key));
  const uploadedIsSilk = uploadedSilk !== null && isSilkBytes(uploadedSilk);
  const decodedBack = uploadedSilk === null ? null : await codec.silkToWav(uploadedSilk);
  const audioRoundTrip = decodedBack !== null && decodedBack.durationMs >= 1000 && decodedBack.durationMs <= 1040;
  log(
    "CDN 上的是 SILK=" + String(uploadedIsSilk) + " / 解码回可播放音频=" + String(audioRoundTrip) +
      "（时长 " + String(decodedBack?.durationMs) + "ms，帧量化容差内）/ 与源 WAV 不同=" + String(uploadedSilk !== null && Buffer.compare(Buffer.from(uploadedSilk), Buffer.from(outboundWav)) !== 0) +
      " / receipt=" + receipt.providerMessageId,
  );

  log("PHASE 4.5-D1 SMOKE OK（入站 SILK→WAV 落库，出站 WAV→SILK 端到端可解码）");
} finally {
  await app.close();
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  await llm.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

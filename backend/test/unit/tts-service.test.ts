import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtsService, DEFAULT_TTS_SETTINGS, readTtsSettings } from "../../src/core/services/tts-service.ts";
import { createTtsSynthesisRepository } from "../../src/storage/repositories/tts-syntheses.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createLocalMediaStorage } from "../../src/storage/media/local-media-storage.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createLogger } from "../../src/app/logger.ts";
import { sanitizeTtsState, TTS_LIMITS } from "../../src/core/model/tts.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";
import { createEchoTtsProvider } from "../../src/providers/tts/echo-tts.ts";
import { pcmToWav, readWavFormat, VOICE_SAMPLE_RATE } from "../../src/channels/weixin/media/voice-codec.ts";
import type { TtsProvider, TtsResult } from "../../src/core/ports/tts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WAV = pcmToWav(new Uint8Array(480 * 2));

/** 可编排的假 provider：记录调用、按脚本返回或抛错 */
function fakeProvider(script: { bytes?: Uint8Array; mimeType?: string; durationMs?: number | null; sampleRate?: number | null; error?: unknown; delayMs?: number } = {}) {
  const calls: Array<{ text: string; voice: string | null; model: string | null; speed: number | null; format: string }> = [];
  const provider: TtsProvider = {
    id: "fake-tts",
    kind: "fake",
    defaultModel: "fake-model",
    defaultVoice: "fake-voice",
    async synthesize(input): Promise<TtsResult> {
      calls.push({ text: input.text, voice: input.voice, model: input.model, speed: input.speed, format: input.format });
      if (script.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, script.delayMs);
          input.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
      if (script.error !== undefined) throw script.error;
      return {
        bytes: script.bytes ?? WAV,
        mimeType: script.mimeType ?? "audio/wav",
        durationMs: script.durationMs === undefined ? 1000 : script.durationMs,
        sampleRate: script.sampleRate === undefined ? VOICE_SAMPLE_RATE : script.sampleRate,
        providerId: "fake-tts",
        model: "fake-model",
        voice: input.voice ?? "fake-voice",
        latencyMs: 1,
      };
    },
  };
  return { provider, calls };
}

function harness(script: Parameters<typeof fakeProvider>[0] = {}, settingsSeed: Record<string, unknown> = {}) {
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-tts-"));
  const logLines: string[] = [];
  const logger = createLogger({ level: "trace", sink: (line) => logLines.push(line) });
  const storage = createLocalMediaStorage({ dataDir, logger, clock });
  const settings = createSettingsRepository(db);
  settings.put("tts.enabled", true, clock.nowIso());
  settings.put("tts.providerId", "fake-tts", clock.nowIso());
  for (const [key, value] of Object.entries(settingsSeed)) settings.put(key, value, clock.nowIso());
  const repository = createTtsSynthesisRepository(db);
  const { provider, calls } = fakeProvider(script);
  const service = createTtsService({
    registry: { get: (id) => (id === "fake-tts" ? provider : undefined), list: () => [provider] },
    repository,
    storage,
    settings,
    logger,
    clock,
  });
  return {
    db,
    clock,
    storage,
    settings,
    repository,
    service,
    calls,
    logLines,
    dataDir,
    close: () => {
      rmSync(dataDir, { recursive: true, force: true });
      db.close();
    },
  };
}

test("TTS provider abstraction: successful synthesis stores audio via MediaStorage and reports real metadata", async () => {
  const h = harness({ bytes: WAV, mimeType: "audio/wav", durationMs: 1500, sampleRate: 24000 });
  try {
    const result = await h.service.synthesizeForText("你好，今天过得怎么样？", { messageRef: "m-1" });
    assert.equal(result.providerCalled, true);
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.mimeType, "audio/wav");
    assert.equal(result.state.durationMs, 1500);
    assert.equal(result.state.sampleRate, 24000);
    assert.equal(result.state.provider, "fake-tts");
    assert.equal(result.state.model, "fake-model");
    assert.match(String(result.state.mediaId), /^[0-9a-f]{32}$/);

    // 音频真的进了 MediaStorage，而且逐字节一致
    const stored = await h.storage.get(String(result.state.mediaId));
    assert.ok(stored !== null);
    assert.equal(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(WAV)), 0);
    assert.equal(stored.origin, "generated", "生成的媒体必须标记为 generated");
    assert.equal(h.calls.length, 1);

    // 数据库里只有引用与元数据，**没有**音频字节
    const row = h.db.raw.prepare("SELECT * FROM tts_syntheses").get() as Record<string, unknown>;
    assert.equal(row.status, "completed");
    assert.equal(row.media_id, result.state.mediaId);
    const json = JSON.stringify(row);
    assert.equal(json.includes(Buffer.from(WAV).toString("base64")), false);
    assert.equal(json.includes("RIFF"), false, "库里不允许出现音频字节");
    // 也不应该保存完整文本（只保存哈希与长度）
    assert.equal(json.includes("你好，今天过得怎么样？"), false);
    assert.equal(typeof row.text_hash, "string");
    assert.equal(row.text_length, "你好，今天过得怎么样？".length);
  } finally {
    h.close();
  }
});

test("echo provider produces deterministic, decodable WAV (same text → same bytes)", async () => {
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-tts-echo-"));
  try {
    const logger = createLogger({ level: "error", sink: () => {} });
    const storage = createLocalMediaStorage({ dataDir, logger, clock });
    const settings = createSettingsRepository(db);
    // 显式打开：默认是关闭的（安全默认值）
    settings.put("tts.enabled", true, clock.nowIso());
    settings.put("tts.providerId", "echo-tts", clock.nowIso());
    const service = createTtsService({
      registry: { get: () => createEchoTtsProvider({ logger }), list: () => [] },
      repository: createTtsSynthesisRepository(db),
      storage,
      settings,
      logger,
      clock,
    });
    const first = await service.synthesizeForText("同一段文本");
    const second = await service.synthesizeForText("同一段文本", { force: true });
    assert.equal(first.state.status, "completed");
    assert.equal(second.state.status, "completed");
    const a = await storage.get(String(first.state.mediaId));
    const b = await storage.get(String(second.state.mediaId));
    assert.equal(Buffer.compare(Buffer.from(a!.bytes), Buffer.from(b!.bytes)), 0, "同文本必须产出同样的音频（确定性）");
    assert.equal(a!.mimeType, "audio/wav");
    const format = readWavFormat(a!.bytes);
    assert.equal(format?.sampleRate, VOICE_SAMPLE_RATE);
    assert.equal(format?.channels, 1);
    assert.equal(format?.bitsPerSample, 16);
    assert.equal(format!.dataBytes > 0, true, "必须是可解码的、非空的 WAV");

    // 不同文本 → 不同音频
    const other = await service.synthesizeForText("另一段文本");
    const c = await storage.get(String(other.state.mediaId));
    assert.notEqual(Buffer.compare(Buffer.from(a!.bytes), Buffer.from(c!.bytes)), 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    db.close();
  }
});

test("provider failure is normalized, text is unaffected, and no audio is claimed", async () => {
  const h = harness({ error: new ProviderError("上游炸了", { providerId: "fake-tts", kind: "server_error", httpStatus: 500, retryable: true }) });
  try {
    const result = await h.service.synthesizeForText("hello");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.errorCode, "server_error");
    assert.equal(result.state.mediaId, null, "失败时绝不能声称有音频");
    assert.equal(result.state.cached, false);
    const row = h.db.raw.prepare("SELECT media_id, status FROM tts_syntheses").get() as { media_id: string | null; status: string };
    assert.equal(row.status, "failed");
    assert.equal(row.media_id, null);
  } finally {
    h.close();
  }
});

test("timeout and cancellation are classified, and cancellation stores nothing", async () => {
  const slow = harness({ delayMs: 300 }, { "tts.timeoutMs": 30 });
  try {
    const result = await slow.service.synthesizeForText("慢一点");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.errorCode, "timeout");
    assert.equal(result.state.mediaId, null);
  } finally {
    slow.close();
  }

  const cancellable = harness({ delayMs: 300 });
  try {
    const controller = new AbortController();
    const task = cancellable.service.synthesizeForText("会被取消", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await task;
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.errorCode, "aborted");
    assert.equal(result.state.mediaId, null, "取消后不允许留下任何可用的媒体引用");
    const assets = await cancellable.storage.has("0".repeat(32));
    assert.equal(assets, false);
  } finally {
    cancellable.close();
  }
});

test("oversized text is rejected before the provider is called", async () => {
  const h = harness({}, { "tts.maxTextLength": 10 });
  try {
    const result = await h.service.synthesizeForText("x".repeat(11));
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.errorCode, "too_long");
    assert.equal(h.calls.length, 0, "超长文本不允许触发 provider 调用");
  } finally {
    h.close();
  }
});

test("disabled / unconfigured TTS fails explicitly with zero provider calls", async () => {
  const disabled = harness({}, { "tts.enabled": false });
  try {
    const result = await disabled.service.synthesizeForText("hi");
    assert.equal(result.state.errorCode, "disabled");
    assert.equal(disabled.calls.length, 0);
  } finally {
    disabled.close();
  }

  const unconfigured = harness({}, { "tts.providerId": "not-registered" });
  try {
    const result = await unconfigured.service.synthesizeForText("hi");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.errorCode, "configuration_error");
    assert.equal(unconfigured.calls.length, 0);
  } finally {
    unconfigured.close();
  }
});

test("empty provider audio is a failure, not a silent success", async () => {
  const h = harness({ bytes: new Uint8Array(0) });
  try {
    const result = await h.service.synthesizeForText("hi");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.errorCode, "invalid_response");
    assert.equal(result.state.mediaId, null);
  } finally {
    h.close();
  }
});

test("metadata is preserved only when the provider actually reports it", async () => {
  const h = harness({ durationMs: null, sampleRate: null });
  try {
    const result = await h.service.synthesizeForText("hi");
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.durationMs, null, "provider 没给时长就必须是 null");
    assert.equal(result.state.sampleRate, null, "provider 没给采样率就必须是 null");
  } finally {
    h.close();
  }
});

test("cache: the same text+config is synthesized once; different voice/model/text are different identities", async () => {
  const h = harness();
  try {
    const first = await h.service.synthesizeForText("同一句话");
    assert.equal(first.providerCalled, true);
    assert.equal(first.state.cached, false);

    const second = await h.service.synthesizeForText("同一句话");
    assert.equal(second.providerCalled, false, "相同指纹必须复用缓存");
    assert.equal(second.state.cached, true);
    assert.equal(second.state.mediaId, first.state.mediaId);
    assert.equal(h.calls.length, 1, "同一段文本不允许被合成两次");

    // 换音色 / 换模型 / 换文本 → 不同指纹 → 允许重新合成
    h.settings.put("tts.voice", "another-voice", h.clock.nowIso());
    await h.service.synthesizeForText("同一句话");
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls.at(-1)?.voice, "another-voice");

    h.settings.put("tts.model", "another-model", h.clock.nowIso());
    await h.service.synthesizeForText("同一句话");
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.at(-1)?.model, "another-model");

    await h.service.synthesizeForText("换一句话");
    assert.equal(h.calls.length, 4);

    // force 才允许忽略缓存
    await h.service.synthesizeForText("同一句话", { force: true });
    assert.equal(h.calls.length, 5);

    const rows = h.db.raw.prepare("SELECT COUNT(*) AS n FROM tts_syntheses").get() as { n: number };
    assert.equal(rows.n, 4, "指纹不同 → 记录不同；指纹相同 → 复用同一条记录");
  } finally {
    h.close();
  }
});

test("one failed synthesis does not block the next one", async () => {
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-tts-seq-"));
  try {
    const logger = createLogger({ level: "error", sink: () => {} });
    const storage = createLocalMediaStorage({ dataDir, logger, clock });
    const settings = createSettingsRepository(db);
    settings.put("tts.enabled", true, clock.nowIso());
    settings.put("tts.providerId", "flaky", clock.nowIso());
    let call = 0;
    const provider: TtsProvider = {
      id: "flaky",
      kind: "fake",
      defaultModel: "fake",
      defaultVoice: null,
      async synthesize(): Promise<TtsResult> {
        call += 1;
        if (call === 1) throw new ProviderError("boom", { providerId: "flaky", kind: "server_error", httpStatus: 500, retryable: true });
        return { bytes: WAV, mimeType: "audio/wav", durationMs: 500, sampleRate: 24000, providerId: "flaky", model: "fake", voice: null, latencyMs: 1 };
      },
    };
    const service = createTtsService({ registry: { get: () => provider, list: () => [provider] }, repository: createTtsSynthesisRepository(db), storage, settings, logger, clock });
    const first = await service.synthesizeForText("第一条");
    const second = await service.synthesizeForText("第二条");
    assert.equal(first.state.status, "failed");
    assert.equal(second.state.status, "completed");
    assert.equal(second.state.mediaId !== null, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    db.close();
  }
});

test("TTS state is sanitized: no mediaId outside completed, lengths capped, no invented metadata", () => {
  const failed = sanitizeTtsState({ status: "failed", mediaId: "deadbeef", durationMs: 999, updatedAt: "t" });
  assert.equal(failed.mediaId, null, "失败状态不允许携带 mediaId");
  assert.equal(failed.mimeType, null);

  const completed = sanitizeTtsState({ status: "completed", mediaId: "a".repeat(TTS_LIMITS.maxMediaIdLength + 50), durationMs: -5, sampleRate: Number.NaN, updatedAt: "t" });
  assert.equal(completed.mediaId?.length, TTS_LIMITS.maxMediaIdLength);
  assert.equal(completed.durationMs, null);
  assert.equal(completed.sampleRate, null);

  const weird = sanitizeTtsState({ status: "not-a-status", updatedAt: "t" });
  assert.equal(weird.status, "pending", "非法状态回落到 pending，而不是凭空变成 completed");

  const control = sanitizeTtsState({ status: "failed", errorMessage: "a\u0000b\u001fc", updatedAt: "t" });
  assert.equal(control.errorMessage, "a b c");
});

test("credentials are never logged and the full text is not logged either", async () => {
  const h = harness({}, { "tts.voice": "secret-voice-name" });
  try {
    await h.service.synthesizeForText("这段文本很长，不应该整段出现在日志里，只应该记录长度与哈希之类的元数据。");
    const joined = h.logLines.join("\n");
    assert.equal(joined.includes("不应该整段出现在日志里"), false, "日志里不记录完整待合成文本");
    assert.equal(joined.includes(Buffer.from(WAV).toString("base64")), false, "日志里不允许出现音频字节");
    assert.equal(joined.includes("RIFF"), false);
    assert.match(joined, /tts completed/, "成功必须留下结构化日志");
    assert.match(joined, /"textLength"/, "只记录长度这类安全元数据");
  } finally {
    h.close();
  }
});

test("TTS settings follow the existing settings conventions with safe defaults", () => {
  const db = createTestDatabase();
  const clock = createFakeClock();
  try {
    const settings = createSettingsRepository(db);
    const defaults = readTtsSettings(settings);
    assert.deepEqual(defaults, DEFAULT_TTS_SETTINGS, "默认关闭，且不猜测 provider/voice");

    settings.put("tts.enabled", true, clock.nowIso());
    settings.put("tts.providerId", "p1", clock.nowIso());
    settings.put("tts.voice", "v1", clock.nowIso());
    settings.put("tts.language", "zh", clock.nowIso());
    settings.put("tts.timeoutMs", 1234, clock.nowIso());
    settings.put("tts.maxTextLength", 222, clock.nowIso());
    settings.put("tts.outputFormat", "mp3", clock.nowIso());
    settings.put("tts.delivery", "file", clock.nowIso());
    const read = readTtsSettings(settings);
    assert.equal(read.enabled, true);
    assert.equal(read.providerId, "p1");
    assert.equal(read.voice, "v1");
    assert.equal(read.language, "zh");
    assert.equal(read.timeoutMs, 1234);
    assert.equal(read.maxTextLength, 222);
    assert.equal(read.outputFormat, "mp3");
    assert.equal(read.delivery, "file");

    // 非法值不能被当真
    settings.put("tts.outputFormat", "exe", clock.nowIso());
    settings.put("tts.delivery", "telepathy", clock.nowIso());
    settings.put("tts.timeoutMs", -5, clock.nowIso());
    const sanitized = readTtsSettings(settings);
    assert.equal(sanitized.outputFormat, "wav");
    assert.equal(sanitized.delivery, "voice");
    assert.equal(sanitized.timeoutMs, DEFAULT_TTS_SETTINGS.timeoutMs);
  } finally {
    db.close();
  }
});

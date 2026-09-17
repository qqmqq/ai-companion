import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptionService, DEFAULT_ASR_SETTINGS, readAsrSettings } from "../../src/core/services/transcription-service.ts";
import { createTranscriptionRepository } from "../../src/storage/repositories/transcriptions.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createLocalMediaStorage } from "../../src/storage/media/local-media-storage.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createLogger } from "../../src/app/logger.ts";
import { sanitizeTranscription, TRANSCRIPTION_LIMITS } from "../../src/core/model/transcription.ts";
import { partsToText, normalizeMessageParts } from "../../src/core/model/message.ts";
import type { AsrProvider, AsrResult } from "../../src/core/ports/asr.ts";
import type { InternalMessage, MessagePart } from "../../src/core/model/message.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";

/** 可编排的假 provider：记录调用次数、按脚本返回结果或抛错 */
function fakeProvider(script: { result?: Partial<AsrResult>; error?: unknown; delayMs?: number } = {}) {
  const calls: Array<{ language: string | null; model: string | null; bytes: number; mediaId: string }> = [];
  const provider: AsrProvider = {
    id: "fake-asr",
    kind: "fake",
    defaultModel: "fake-model",
    async transcribe(input): Promise<AsrResult> {
      calls.push({ language: input.language, model: input.model, bytes: input.audio.bytes.byteLength, mediaId: input.audio.mediaId });
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
        text: script.result?.text ?? "转写结果",
        language: script.result?.language ?? null,
        durationMs: script.result?.durationMs ?? null,
        confidence: script.result?.confidence ?? null,
        providerId: "fake-asr",
        model: script.result?.model ?? "fake-model",
        latencyMs: 1,
      };
    },
  };
  return { provider, calls };
}

function harness(script: { result?: Partial<AsrResult>; error?: unknown; delayMs?: number } = {}, settingsSeed: Record<string, unknown> = {}) {
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-asr-"));
  const logLines: string[] = [];
  const logger = createLogger({ level: "trace", sink: (line) => logLines.push(line) });
  const storage = createLocalMediaStorage({ dataDir, logger, clock });
  const settings = createSettingsRepository(db);
  settings.put("asr.enabled", true, clock.nowIso());
  settings.put("asr.providerId", "fake-asr", clock.nowIso());
  for (const [key, value] of Object.entries(settingsSeed)) settings.put(key, value, clock.nowIso());
  const repository = createTranscriptionRepository(db);
  const { provider, calls } = fakeProvider(script);
  const service = createTranscriptionService({
    registry: { get: (id) => (id === "fake-asr" ? provider : undefined), list: () => [provider] },
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

const WAV_BYTES = new Uint8Array(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), (() => {
  const header = Buffer.alloc(36);
  header.write("fmt ", 0, "ascii");
  header.writeUInt32LE(16, 4);
  header.writeUInt16LE(1, 8);
  header.writeUInt16LE(1, 10);
  header.writeUInt32LE(24000, 12);
  header.writeUInt32LE(48000, 16);
  header.writeUInt16LE(2, 20);
  header.writeUInt16LE(16, 22);
  header.write("data", 24, "ascii");
  header.writeUInt32LE(0, 28);
  return header;
})()]));

async function seedAudio(h: ReturnType<typeof harness>, bytes: Uint8Array = WAV_BYTES, durationMs: number | null = 1000) {
  const asset = await h.storage.put({ bytes, mimeType: "audio/wav", filename: null, origin: "channel" });
  const part: MessagePart = {
    kind: "audio",
    media: {
      mediaId: asset.mediaId,
      mimeType: "audio/wav",
      filename: null,
      sizeBytes: asset.sizeBytes,
      width: null,
      height: null,
      durationMs,
      origin: "channel",
      status: "available",
      url: { kind: "internal", value: "media:" + asset.mediaId },
    },
  };
  return { asset, part };
}

function inboundMessage(parts: MessagePart[], providerMessageId = "wx-msg-1"): InternalMessage {
  return {
    id: providerMessageId,
    channel: "weixin",
    accountId: "acct-1",
    conversationId: "user-1",
    sender: { id: "user-1", name: null, isSelf: false },
    timestamp: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    type: "audio",
    parts,
    replyTo: null,
    metadata: {},
    externalRef: { providerMessageId },
  };
}

test("AudioPart can enter ASR processing and comes back completed with text", async () => {
  const h = harness({ result: { text: "你好，世界", language: "zh", durationMs: 1234, confidence: 0.9 } });
  try {
    const { part } = await seedAudio(h);
    const result = await h.service.transcribeInboundMessage(inboundMessage([part]));
    const state = result.states.get(0)!;
    assert.equal(state.status, "completed");
    assert.equal(state.text, "你好，世界");
    assert.equal(state.language, "zh");
    assert.equal(state.durationMs, 1234);
    assert.equal(state.confidence, 0.9);
    assert.equal(state.provider, "fake-asr");
    assert.equal(state.model, "fake-model");
    assert.equal(state.cached, false);
    assert.equal(h.calls.length, 1);

    // 音频部件本身原样保留（media 引用与状态没有被改动）
    const outPart = result.parts[0]!;
    assert.equal(outPart.kind, "audio");
    assert.deepEqual((outPart as { media: unknown }).media, part.kind === "audio" ? part.media : null);

    // 数据库里有文本，但**没有音频字节**
    const row = h.db.raw.prepare("SELECT * FROM transcriptions WHERE message_ref = ?").get("wx-msg-1") as Record<string, unknown>;
    assert.equal(row.text, "你好，世界");
    assert.equal(String(row.media_id), part.kind === "audio" ? part.media.mediaId : "");
    const json = JSON.stringify(row);
    assert.equal(json.includes(Buffer.from(WAV_BYTES).toString("base64")), false, "转写记录里绝不能有音频字节");
    assert.equal(json.includes("RIFF"), false);
  } finally {
    h.close();
  }
});

test("no provider is configured: explicit failed state, audio untouched", async () => {
  const h = harness({}, { "asr.enabled": true, "asr.providerId": "missing-provider" });
  try {
    const { part } = await seedAudio(h);
    const result = await h.service.transcribeInboundMessage(inboundMessage([part]));
    const state = result.states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "configuration_error");
    assert.equal(state.text, null, "失败绝不能伪装成空文本");
    assert.equal(h.calls.length, 0, "没有可用 provider 时不能调用任何实现");
  } finally {
    h.close();
  }
});

test("ASR disabled: failed with the disabled code and zero provider calls", async () => {
  const h = harness({}, { "asr.enabled": false });
  try {
    const { part } = await seedAudio(h);
    const state = (await h.service.transcribeInboundMessage(inboundMessage([part]))).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "disabled");
    assert.equal(h.calls.length, 0);
  } finally {
    h.close();
  }
});

test("failed transcription keeps media available (media.status is never overloaded)", async () => {
  const h = harness({ error: new ProviderError("上游炸了", { providerId: "fake-asr", kind: "server_error", httpStatus: 500, retryable: true }) });
  try {
    const { part } = await seedAudio(h);
    const result = await h.service.transcribeInboundMessage(inboundMessage([part]));
    const outPart = result.parts[0] as { kind: "audio"; media: { status: string }; transcription?: { status: string; errorCode: string | null } };
    assert.equal(outPart.transcription?.status, "failed");
    assert.equal(outPart.transcription?.errorCode, "server_error");
    assert.equal(outPart.media.status, "available", "转写失败绝不能把音频标记成失败");
    assert.equal(result.states.get(0)?.text, null);
  } finally {
    h.close();
  }
});

test("oversized audio is rejected before any provider call", async () => {
  const h = harness({}, { "asr.maxBytes": 8 });
  try {
    const { part } = await seedAudio(h);
    const state = (await h.service.transcribeInboundMessage(inboundMessage([part]))).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "too_large");
    assert.equal(h.calls.length, 0, "超限音频不允许触发 provider 调用");
  } finally {
    h.close();
  }
});

test("audio longer than maxDurationMs is rejected before any provider call", async () => {
  const h = harness({}, { "asr.maxDurationMs": 500 });
  try {
    const { part } = await seedAudio(h, WAV_BYTES, 5000);
    const state = (await h.service.transcribeInboundMessage(inboundMessage([part]))).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "too_long");
    assert.equal(h.calls.length, 0);
  } finally {
    h.close();
  }
});

test("timeout is classified as timeout, cancellation as aborted, and neither touches the audio", async () => {
  const slow = harness({ result: { text: "太慢了" }, delayMs: 300 }, { "asr.timeoutMs": 30 });
  try {
    const { part } = await seedAudio(slow);
    const state = (await slow.service.transcribeInboundMessage(inboundMessage([part]))).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "timeout");
  } finally {
    slow.close();
  }

  const cancellable = harness({ result: { text: "会被取消" }, delayMs: 300 });
  try {
    const { part } = await seedAudio(cancellable);
    const controller = new AbortController();
    const task = cancellable.service.transcribeInboundMessage(inboundMessage([part]), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const state = (await task).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "aborted");
  } finally {
    cancellable.close();
  }
});

test("a completed transcription is reused: the provider is called exactly once (cost control)", async () => {
  const h = harness({ result: { text: "只识别一次" } });
  try {
    const { part } = await seedAudio(h);
    const first = await h.service.transcribeInboundMessage(inboundMessage([part]));
    assert.equal(first.states.get(0)?.cached, false);
    assert.equal(h.calls.length, 1);

    // 第二次（同一消息 + 同一音频 + 同一 provider/model）必须复用
    const second = await h.service.transcribeInboundMessage(inboundMessage([part]));
    assert.equal(second.states.get(0)?.cached, true);
    assert.equal(second.states.get(0)?.text, "只识别一次");
    assert.equal(h.calls.length, 1, "同一消息不允许被识别两次");

    // 显式 force 才允许重新识别
    const forced = await h.service.transcribeInboundMessage(inboundMessage([part]), { force: true });
    assert.equal(forced.states.get(0)?.cached, false);
    assert.equal(h.calls.length, 2);

    // 配置/模型变化 → 指纹变化 → 允许重新识别（这是刻意的策略，不是意外重复）
    h.settings.put("asr.model", "another-model", h.clock.nowIso());
    await h.service.transcribeInboundMessage(inboundMessage([part]));
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.at(-1)?.model, "another-model", "模型变化必须传给 provider");
  } finally {
    h.close();
  }
});

test("empty provider text is a failure, not a successful empty transcription", async () => {
  const h = harness({ result: { text: "   " } });
  try {
    const { part } = await seedAudio(h);
    const state = (await h.service.transcribeInboundMessage(inboundMessage([part]))).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "invalid_response");
    assert.equal(state.text, null);
  } finally {
    h.close();
  }
});

test("unavailable media or missing mediaId fails without calling the provider", async () => {
  const h = harness();
  try {
    const { part } = await seedAudio(h);
    const brokenPart: MessagePart = part.kind === "audio" ? { ...part, media: { ...part.media, status: "failed", mediaId: null } } : part;
    const state = (await h.service.transcribeInboundMessage(inboundMessage([brokenPart]))).states.get(0)!;
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, "unsupported_audio");
    assert.equal(h.calls.length, 0);
  } finally {
    h.close();
  }
});

test("one failed audio does not stop the next one, and text parts pass through untouched", async () => {
  let call = 0;
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-asr-"));
  try {
    const logger = createLogger({ level: "error", sink: () => {} });
    const storage = createLocalMediaStorage({ dataDir, logger, clock });
    const settings = createSettingsRepository(db);
    settings.put("asr.enabled", true, clock.nowIso());
    settings.put("asr.providerId", "flaky", clock.nowIso());
    const provider: AsrProvider = {
      id: "flaky",
      kind: "fake",
      defaultModel: "fake",
      async transcribe(): Promise<AsrResult> {
        call += 1;
        if (call === 1) throw new ProviderError("boom", { providerId: "flaky", kind: "server_error", httpStatus: 500, retryable: true });
        return { text: "第二条成功", language: null, durationMs: null, confidence: null, providerId: "flaky", model: "fake", latencyMs: 1 };
      },
    };
    const service = createTranscriptionService({
      registry: { get: () => provider, list: () => [provider] },
      repository: createTranscriptionRepository(db),
      storage,
      settings,
      logger,
      clock,
    });

    const first = await seedAudio({ storage } as unknown as ReturnType<typeof harness>);
    const second = await seedAudio({ storage } as unknown as ReturnType<typeof harness>);
    const textPart: MessagePart = { kind: "text", text: "顺带一句话" };
    const message = inboundMessage([first.part, textPart, second.part]);
    const result = await service.transcribeInboundMessage(message);

    assert.equal(result.states.get(0)?.status, "failed");
    assert.equal(result.states.get(2)?.status, "completed");
    assert.equal(result.states.get(2)?.text, "第二条成功");
    assert.equal(result.parts[1]!.kind, "text", "非音频部件必须原样保留");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    db.close();
  }
});

test("transcription reaches the context text and never leaks bytes or secrets", () => {
  const h = harness({ result: { text: "上下文里应该出现这句话", durationMs: 2200 } });
  try {
    const rendered = partsToText([
      { kind: "audio", media: { mediaId: "m", mimeType: "audio/wav", filename: null, sizeBytes: 10, width: null, height: null, durationMs: 2200, origin: "channel", status: "available", url: null }, transcription: sanitizeTranscription({ status: "completed", text: "上下文里应该出现这句话", durationMs: 2200, updatedAt: "t" }) },
    ]);
    assert.match(rendered, /\[语音\] 转写：上下文里应该出现这句话/);
    assert.equal(rendered.includes("[object Object]"), false);

    // 失败状态不产生任何"假文本"
    const failed = partsToText([
      { kind: "audio", media: { mediaId: "m", mimeType: null, filename: null, sizeBytes: null, width: null, height: null, durationMs: null, origin: "channel", status: "available", url: null }, transcription: sanitizeTranscription({ status: "failed", errorCode: "timeout" }) },
    ]);
    assert.equal(failed, "[语音]");

    // 旧字段 transcript 保持历史行为（就是文本本身），不改动既有契约
    const legacy = partsToText([
      { kind: "audio", media: { mediaId: "m", mimeType: null, filename: null, sizeBytes: null, width: null, height: null, durationMs: null, origin: "channel", status: "available", url: null }, transcript: "旧的转写字段" },
    ]);
    assert.equal(legacy, "旧的转写字段");
  } finally {
    h.close();
  }
});

test("transcription state is sanitized on the way in and out (lengths, control chars, no invented confidence)", () => {
  const long = sanitizeTranscription({ status: "completed", text: "字".repeat(TRANSCRIPTION_LIMITS.maxTextLength + 500), confidence: 5, durationMs: -1, updatedAt: "t" });
  assert.equal(long.text?.length, TRANSCRIPTION_LIMITS.maxTextLength);
  assert.equal(long.confidence, null, "越界置信度必须丢弃，而不是夹逼到 0/1");
  assert.equal(long.durationMs, null);

  const failed = sanitizeTranscription({ status: "failed", text: "不该保留的文本", updatedAt: "t" });
  assert.equal(failed.text, null, "失败状态不允许携带文本");

  const control = sanitizeTranscription({ status: "completed", text: "a\u0000b\u001fc", updatedAt: "t" });
  assert.equal(control.text, "a b c");

  // 读取边界（数据库/历史 JSON）也必须走同一套净化
  const normalized = normalizeMessageParts([
    { kind: "audio", media: { mediaId: "m", status: "available" }, transcription: { status: "completed", text: "x".repeat(20_000), confidence: 0.5 } },
  ]);
  const part = normalized.parts[0] as { transcription?: { text: string | null; confidence: number | null } };
  assert.equal(part.transcription?.text?.length, TRANSCRIPTION_LIMITS.maxTextLength);
  assert.equal(part.transcription?.confidence, 0.5);
});

test("logs contain sizes and codes but never audio bytes or the full transcript", async () => {
  const h = harness({ result: { text: "这是一段很长的转写内容，不应该整段出现在日志里" } });
  try {
    const { part } = await seedAudio(h);
    await h.service.transcribeInboundMessage(inboundMessage([part]));
    const joined = h.logLines.join("\n");
    assert.equal(joined.includes(Buffer.from(WAV_BYTES).toString("base64")), false, "日志里不能有音频字节");
    assert.equal(joined.includes("RIFF"), false);
    assert.equal(joined.includes("这是一段很长的转写内容"), false, "日志只记录长度，不记录完整转写原文");
    assert.match(joined, /asr completed/, "成功必须留下可观测的结构化日志");
  } finally {
    h.close();
  }
});

test("ASR settings are read through the existing settings conventions", () => {
  const db = createTestDatabase();
  const clock = createFakeClock();
  try {
    const settings = createSettingsRepository(db);
    assert.deepEqual(readAsrSettings(settings), DEFAULT_ASR_SETTINGS, "默认关闭，且不猜测任何 provider");
    settings.put("asr.enabled", true, clock.nowIso());
    settings.put("asr.providerId", "p1", clock.nowIso());
    settings.put("asr.language", "zh", clock.nowIso());
    settings.put("asr.timeoutMs", 1500, clock.nowIso());
    const read = readAsrSettings(settings);
    assert.equal(read.enabled, true);
    assert.equal(read.providerId, "p1");
    assert.equal(read.language, "zh");
    assert.equal(read.timeoutMs, 1500);
  } finally {
    db.close();
  }
});

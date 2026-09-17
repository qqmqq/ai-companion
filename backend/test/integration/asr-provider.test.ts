import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAiCompatibleAsrProvider, ASR_ACCEPTED_MIME_TYPES } from "../../src/providers/asr/openai-compatible-asr.ts";
import { startMockAsrServer } from "../helpers/mock-asr-server.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";

const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);

function makeProvider(baseUrl: string, overrides: { apiKey?: string | null; timeoutMs?: number } = {}) {
  return createOpenAiCompatibleAsrProvider({
    id: "test-asr",
    baseUrl,
    model: "whisper-test",
    apiKey: overrides.apiKey ?? null,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    logger: createLogger({ level: "trace", sink: () => {} }),
    clock: createFakeClock(),
    fetchImpl: fetch,
  });
}

test("openai-compatible provider posts multipart audio and maps the JSON response", async () => {
  const server = await startMockAsrServer({ transcription: "你好，这是一条语音", language: "zh", durationSeconds: 1.5, confidence: 0.93, model: "whisper-1" });
  try {
    const provider = makeProvider(server.baseUrl);
    const result = await provider.transcribe({
      audio: { mediaId: "m1", bytes: audio, mimeType: "audio/wav", durationMs: 1500, filename: "voice.wav" },
      language: "zh",
      model: null,
    });

    assert.equal(result.text, "你好，这是一条语音");
    assert.equal(result.language, "zh");
    assert.equal(result.durationMs, 1500, "上游给的是秒，必须换成毫秒");
    assert.equal(result.confidence, 0.93);
    assert.equal(result.model, "whisper-1");
    assert.equal(result.providerId, "test-asr");
    assert.ok(result.latencyMs >= 0);

    const request = server.requests.at(-1)!;
    assert.ok(request.contentType?.startsWith("multipart/form-data"));
    assert.equal(request.fields.model, "whisper-test");
    assert.equal(request.fields.response_format, "json");
    assert.equal(request.fields.language, "zh");
    assert.equal(request.fileName, "voice.wav");
    assert.equal(Buffer.compare(request.file!, Buffer.from(audio)), 0, "发给 provider 的必须是与 MediaStorage 一致的字节");
    assert.equal(request.authorization, null, "没有配置密钥时不发送 Authorization");
  } finally {
    await server.close();
  }
});

test("only metadata the provider actually returns is preserved", async () => {
  const server = await startMockAsrServer({ transcription: "只有文本" });
  try {
    const provider = makeProvider(server.baseUrl);
    const result = await provider.transcribe({
      audio: { mediaId: "m1", bytes: audio, mimeType: "audio/wav", durationMs: null },
      language: null,
      model: null,
    });
    assert.equal(result.text, "只有文本");
    assert.equal(result.language, null, "上游没给语言就必须是 null");
    assert.equal(result.durationMs, null, "上游没给时长就必须是 null");
    assert.equal(result.confidence, null, "上游没给置信度就必须是 null —— 绝不编造");
    assert.equal(server.requests.at(-1)?.fields.language, undefined);
  } finally {
    await server.close();
  }
});

test("provider errors are normalized (401 / 429 / 500 / bad json / empty text)", async () => {
  const cases: Array<{ config: Parameters<typeof startMockAsrServer>[0]; kind: string; status: number | null }> = [
    { config: { failTimes: 1, failStatus: 500 }, kind: "server_error", status: 500 },
    { config: { failTimes: 1, failStatus: 429 }, kind: "rate_limited", status: 429 },
    { config: { failTimes: 1, failStatus: 401 }, kind: "unauthorized", status: 401 },
    { config: { invalidJson: true }, kind: "invalid_response", status: 200 },
    { config: { emptyText: true }, kind: "invalid_response", status: 200 },
  ];
  for (const entry of cases) {
    const server = await startMockAsrServer(entry.config);
    try {
      const provider = makeProvider(server.baseUrl);
      await assert.rejects(
        () => provider.transcribe({ audio: { mediaId: "m1", bytes: audio, mimeType: "audio/wav", durationMs: null }, language: null, model: null }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError, "必须归一化成 ProviderError");
          assert.equal(error.providerKind, entry.kind);
          assert.equal(error.upstreamStatus, entry.status);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }
});

test("unsupported audio mime is rejected before any request is made", async () => {
  const server = await startMockAsrServer();
  try {
    const provider = makeProvider(server.baseUrl);
    await assert.rejects(
      () => provider.transcribe({ audio: { mediaId: "m1", bytes: audio, mimeType: "audio/silk", durationMs: null }, language: null, model: null }),
      (error: unknown) => error instanceof ProviderError && error.providerKind === "invalid_response",
    );
    assert.equal(server.requests.length, 0, "不支持的容器绝不发请求");
    assert.equal(ASR_ACCEPTED_MIME_TYPES.includes("audio/wav"), true);
  } finally {
    await server.close();
  }
});

test("timeout and cancellation are classified as timeout / aborted", async () => {
  const slow = await startMockAsrServer({ delayMs: 500 });
  try {
    const provider = makeProvider(slow.baseUrl, { timeoutMs: 50 });
    await assert.rejects(
      () => provider.transcribe({ audio: { mediaId: "m1", bytes: audio, mimeType: "audio/wav", durationMs: null }, language: null, model: null }),
      (error: unknown) => error instanceof ProviderError && error.providerKind === "timeout",
    );
  } finally {
    await slow.close();
  }

  const cancellable = await startMockAsrServer({ delayMs: 500 });
  try {
    const provider = makeProvider(cancellable.baseUrl, { timeoutMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => provider.transcribe({ audio: { mediaId: "m1", bytes: audio, mimeType: "audio/wav", durationMs: null }, language: null, model: null, signal: controller.signal }),
      (error: unknown) => error instanceof ProviderError && error.providerKind === "aborted",
    );
  } finally {
    await cancellable.close();
  }
});

test("credentials are sent to the provider but never appear in error messages", async () => {
  const server = await startMockAsrServer({ requiredApiKey: "sk-super-secret-d3", failTimes: 1, failStatus: 500 });
  try {
    const provider = makeProvider(server.baseUrl, { apiKey: "sk-super-secret-d3" });
    assert.equal(server.requests.length, 0);
    await assert.rejects(
      () => provider.transcribe({ audio: { mediaId: "m1", bytes: audio, mimeType: "audio/wav", durationMs: null }, language: null, model: null }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal((error as Error).message.includes("sk-super-secret-d3"), false, "错误信息里绝不能出现密钥");
        assert.equal(JSON.stringify(error.details ?? {}).includes("sk-super-secret-d3"), false);
        return true;
      },
    );
    // 第一次 500 时也用了密钥（否则会是 401）
    assert.equal(server.requests[0]?.authorization, "Bearer sk-super-secret-d3");
  } finally {
    await server.close();
  }
});

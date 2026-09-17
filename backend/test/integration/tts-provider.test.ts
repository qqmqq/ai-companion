import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAiCompatibleTtsProvider, isSupportedTtsFormat, TTS_FORMAT_MIME } from "../../src/providers/tts/openai-compatible-tts.ts";
import { startMockTtsServer } from "../helpers/mock-tts-server.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";
import { pcmToWav, readWavFormat } from "../../src/channels/weixin/media/voice-codec.ts";

const WAV = pcmToWav(new Uint8Array(480 * 2));

function makeProvider(baseUrl: string, overrides: { apiKey?: string | null; timeoutMs?: number; voice?: string | null } = {}) {
  return createOpenAiCompatibleTtsProvider({
    id: "test-tts",
    baseUrl,
    model: "tts-test-model",
    voice: overrides.voice === undefined ? "alloy" : overrides.voice,
    apiKey: overrides.apiKey ?? null,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    logger: createLogger({ level: "trace", sink: () => {} }),
    clock: createFakeClock(),
    fetchImpl: fetch,
  });
}

test("openai-compatible TTS posts JSON and returns real audio bytes with a real mime type", async () => {
  const server = await startMockTtsServer({ audio: WAV, contentType: "audio/wav", durationMsHeader: 1200, sampleRateHeader: 24000 });
  try {
    const provider = makeProvider(server.baseUrl);
    const result = await provider.synthesize({
      text: "你好",
      voice: "zh-voice",
      language: "zh",
      model: "tts-v2",
      speed: 1.25,
      format: "wav",
    });

    assert.equal(Buffer.compare(Buffer.from(result.bytes), Buffer.from(WAV)), 0, "必须原样返回音频字节");
    assert.equal(result.mimeType, "audio/wav");
    assert.equal(result.durationMs, 1200, "上游给了时长才填");
    assert.equal(result.sampleRate, 24000);
    assert.equal(result.model, "tts-v2");
    assert.equal(result.voice, "zh-voice");
    assert.equal(result.providerId, "test-tts");

    const request = server.requests.at(-1)!;
    assert.equal(request.body.model, "tts-v2");
    assert.equal(request.body.input, "你好");
    assert.equal(request.body.voice, "zh-voice");
    assert.equal(request.body.response_format, "wav");
    assert.equal(request.body.speed, 1.25);
    assert.equal(request.authorization, null, "没配密钥就不发送 Authorization");
    // 注意：language 不是 OpenAI /audio/speech 的字段，因此不能凭空塞进请求体
    assert.equal("language" in request.body, false);
  } finally {
    await server.close();
  }
});

test("provider omits speed when not configured and falls back to the configured voice", async () => {
  const server = await startMockTtsServer({ audio: WAV });
  try {
    const provider = makeProvider(server.baseUrl);
    const result = await provider.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "mp3" });
    const request = server.requests.at(-1)!;
    assert.equal(request.body.voice, "alloy", "调用方不给音色时用配置里的默认音色");
    assert.equal(request.body.model, "tts-test-model");
    assert.equal(request.body.response_format, "mp3");
    assert.equal("speed" in request.body, false);
    assert.equal(result.voice, "alloy");
    // 上游 Content-Type 是 audio/wav，即使请求的是 mp3 也以实际返回为准
    assert.equal(result.mimeType, "audio/wav");
  } finally {
    await server.close();
  }
});

test("provider errors are normalized (401 / 429 / 500 / empty audio)", async () => {
  const cases: Array<{ config: Parameters<typeof startMockTtsServer>[0]; kind: string; status: number | null }> = [
    { config: { failTimes: 1, failStatus: 500 }, kind: "server_error", status: 500 },
    { config: { failTimes: 1, failStatus: 429 }, kind: "rate_limited", status: 429 },
    { config: { failTimes: 1, failStatus: 401 }, kind: "unauthorized", status: 401 },
    { config: { emptyAudio: true }, kind: "invalid_response", status: 200 },
  ];
  for (const entry of cases) {
    const server = await startMockTtsServer(entry.config);
    try {
      const provider = makeProvider(server.baseUrl);
      await assert.rejects(
        () => provider.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav" }),
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

test("timeout and cancellation are classified as timeout / aborted", async () => {
  const slow = await startMockTtsServer({ audio: WAV, delayMs: 400 });
  try {
    const provider = makeProvider(slow.baseUrl, { timeoutMs: 40 });
    await assert.rejects(
      () => provider.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav" }),
      (error: unknown) => error instanceof ProviderError && error.providerKind === "timeout",
    );
  } finally {
    await slow.close();
  }

  const cancellable = await startMockTtsServer({ audio: WAV, delayMs: 400 });
  try {
    const provider = makeProvider(cancellable.baseUrl, { timeoutMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => provider.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav", signal: controller.signal }),
      (error: unknown) => error instanceof ProviderError && error.providerKind === "aborted",
    );
  } finally {
    await cancellable.close();
  }
});

test("missing voice fails before any request; credentials never leak into errors", async () => {
  const server = await startMockTtsServer({ audio: WAV });
  try {
    const noVoice = makeProvider(server.baseUrl, { voice: null });
    await assert.rejects(
      () => noVoice.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav" }),
      (error: unknown) => error instanceof ProviderError && error.providerKind === "model_unavailable",
    );
    assert.equal(server.requests.length, 0, "没有音色时不应该发出请求");

    const keyed = makeProvider(server.baseUrl, { apiKey: "sk-tts-super-secret", voice: "alloy" });
    assert.equal((await keyed.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav" })).mimeType, "audio/wav");
    assert.equal(server.requests.at(-1)?.authorization, "Bearer sk-tts-super-secret");

    const failing = await startMockTtsServer({ failTimes: 1, failStatus: 500, requiredApiKey: "sk-tts-super-secret" });
    try {
      const provider = makeProvider(failing.baseUrl, { apiKey: "sk-tts-super-secret", voice: "alloy" });
      await assert.rejects(
        () => provider.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav" }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal((error as Error).message.includes("sk-tts-super-secret"), false, "错误信息里绝不能出现密钥");
          return true;
        },
      );
    } finally {
      await failing.close();
    }
  } finally {
    await server.close();
  }
});

test("format helpers are explicit about what is supported", () => {
  assert.equal(isSupportedTtsFormat("wav"), true);
  assert.equal(isSupportedTtsFormat("mp3"), true);
  assert.equal(isSupportedTtsFormat("exe"), false);
  assert.equal(isSupportedTtsFormat(null), false);
  assert.equal(TTS_FORMAT_MIME.wav, "audio/wav");
});

test("generated audio integrates with the existing audio pipeline (decodable WAV → readable format)", async () => {
  const server = await startMockTtsServer({ audio: WAV });
  try {
    const provider = makeProvider(server.baseUrl);
    const result = await provider.synthesize({ text: "hi", voice: null, language: null, model: null, speed: null, format: "wav" });
    const format = readWavFormat(result.bytes);
    assert.ok(format !== null, "生成音频必须是既有音频管线认得的容器");
    assert.equal(format.channels, 1);
    assert.equal(format.bitsPerSample, 16);
  } finally {
    await server.close();
  }
});

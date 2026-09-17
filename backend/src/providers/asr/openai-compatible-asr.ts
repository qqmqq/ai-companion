import type { AsrInput, AsrProvider, AsrResult } from "../../core/ports/asr.ts";
import { ProviderError, isRetryable, kindFromHttpStatus, type ProviderErrorKind } from "../../core/model/provider-error.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";

/**
 * OpenAI 兼容的语音转写 Provider（Phase 4.5-D3）。
 *
 * 走标准的 multipart 接口 \`POST <baseUrl>/audio/transcriptions\`：
 * \`file\`（音频字节）+ \`model\` + 可选 \`language\` + \`response_format=json\`。
 *
 * 这样一份实现可以对接：OpenAI、Groq、以及本地/自建的兼容服务
 * （whisper.cpp server、faster-whisper-server、llama.cpp 的 whisper 端点、LiteLLM 等）。
 * **不依赖任何 SDK**：只用内置 fetch/FormData/Blob（Node ≥18 自带）。
 */

export const ASR_ACCEPTED_MIME_TYPES = [
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/flac",
  "audio/ogg",
  "audio/webm",
] as const;

export interface OpenAiCompatibleAsrDeps {
  id: string;
  baseUrl: string;
  /** 默认模型（配置里没给 model 时使用） */
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** 支持的 MIME 白名单（可覆盖，默认见 ASR_ACCEPTED_MIME_TYPES） */
  acceptedMimeTypes?: readonly string[];
}

interface TranscriptionsResponse {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  /** 有些服务用 confidence / avg_logprob / no_speech_prob 表达质量；只有真的有才读 */
  confidence?: unknown;
  model?: unknown;
}

function extensionFor(mimeType: string | null): string {
  switch ((mimeType ?? "").toLowerCase()) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/flac":
      return "flac";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    default:
      return "bin";
  }
}

export function createOpenAiCompatibleAsrProvider(deps: OpenAiCompatibleAsrDeps): AsrProvider {
  const accepted = deps.acceptedMimeTypes ?? ASR_ACCEPTED_MIME_TYPES;
  const base = deps.baseUrl.replace(/\/+$/, "");

  function fail(kind: ProviderErrorKind, httpStatus: number | null, message: string, cause?: unknown): never {
    throw new ProviderError(message, {
      providerId: deps.id,
      kind,
      httpStatus,
      retryable: isRetryable(kind),
      model: deps.model,
    }, cause === undefined ? {} : { cause });
  }

  return {
    id: deps.id,
    kind: "openai-compatible",
    defaultModel: deps.model,

    async transcribe(input: AsrInput): Promise<AsrResult> {
      const started = Date.now();
      const mimeType = (input.audio.mimeType ?? "").toLowerCase();
      // 只做"要不要送去识别"的判断，不做任何转码（D1 已经把语音解成 WAV）
      if (mimeType.length > 0 && !accepted.includes(mimeType as (typeof ASR_ACCEPTED_MIME_TYPES)[number])) {
        fail("invalid_response", null, "不支持的音频类型：" + mimeType.slice(0, 40));
      }

      const model = input.model ?? deps.model;
      const form = new FormData();
      form.set("model", model);
      form.set("response_format", "json");
      if (input.language !== null && input.language.length > 0) form.set("language", input.language);
      const filename = input.audio.filename ?? "audio." + extensionFor(input.audio.mimeType);
      form.set("file", new Blob([Buffer.from(input.audio.bytes)], { type: mimeType.length > 0 ? mimeType : "application/octet-stream" }), filename);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timeout")), deps.timeoutMs);
      const onAbort = (): void => controller.abort(input.signal?.reason);
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          clearTimeout(timeout);
          fail("aborted", null, "转写被取消");
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const response = await (deps.fetchImpl ?? fetch)(base + "/audio/transcriptions", {
          method: "POST",
          headers: deps.apiKey === null ? {} : { authorization: "Bearer " + deps.apiKey },
          body: form,
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          fail(kindFromHttpStatus(response.status), response.status, "语音转写请求失败：HTTP " + String(response.status) + (detail.length > 0 ? " " + detail : ""));
        }

        let payload: TranscriptionsResponse;
        try {
          payload = (await response.json()) as TranscriptionsResponse;
        } catch (error) {
          fail("invalid_response", response.status, "语音转写响应不是 JSON", error);
        }
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (text.length === 0) {
          // 上游返回了 200 但没有任何文本：这是失败（空转写），绝不能当成"识别成功但内容为空"
          fail("invalid_response", response.status, "语音转写返回了空文本");
        }
        const duration = typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration >= 0 ? payload.duration : null;
        const confidence = typeof payload.confidence === "number" && payload.confidence >= 0 && payload.confidence <= 1 ? payload.confidence : null;
        return {
          text,
          language: typeof payload.language === "string" && payload.language.length > 0 ? payload.language : null,
          // 上游给的是秒；统一成毫秒（不给就是 null）
          durationMs: duration === null ? null : Math.round(duration * 1000),
          confidence,
          providerId: deps.id,
          model: typeof payload.model === "string" && payload.model.length > 0 ? payload.model : model,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (controller.signal.aborted) {
          if (input.signal?.aborted === true) fail("aborted", null, "转写被取消", error);
          fail("timeout", null, "语音转写超时（" + String(deps.timeoutMs) + "ms）", error);
        }
        fail("network", null, "语音转写网络错误", error);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

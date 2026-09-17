import type { TtsInput, TtsProvider, TtsResult } from "../../core/ports/tts.ts";
import { TTS_FORMAT_MIME, isSupportedTtsFormat, type TtsOutputFormat } from "../../core/model/tts.ts";
import { ProviderError, isRetryable, kindFromHttpStatus, type ProviderErrorKind } from "../../core/model/provider-error.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";

/**
 * OpenAI 兼容的语音合成 Provider（Phase 4.5-D4）。
 *
 * \`POST <baseUrl>/audio/speech\`，请求体是 JSON：
 * \`{ model, input, voice, response_format, speed }\`，响应体就是**音频字节**（不是 JSON）。
 *
 * 一份实现可以对接：OpenAI、以及兼容该形状的本地/自建服务（例如各种 OpenAI-compatible
 * TTS 网关、LiteLLM、部分自建 Piper/CosyVoice/Fish Speech 的 HTTP 包装）。
 * 只用内置 \`fetch\`，**不依赖任何 TTS SDK**。
 */

// 输出格式与 MIME 的映射属于 Core 常识（core/model/tts.ts）；这里重新导出，保持 provider 自身的可用性
export { TTS_FORMAT_MIME, isSupportedTtsFormat };

export interface OpenAiCompatibleTtsDeps {
  id: string;
  baseUrl: string;
  model: string;
  /** 默认音色（配置没给时使用）；没有默认音色且调用方也没给时，会在调用前失败 */
  voice: string | null;
  apiKey: string | null;
  timeoutMs: number;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
}

interface SpeechErrorBody {
  error?: { message?: unknown };
}

export function createOpenAiCompatibleTtsProvider(deps: OpenAiCompatibleTtsDeps): TtsProvider {
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
    defaultVoice: deps.voice,

    async synthesize(input: TtsInput): Promise<TtsResult> {
      const started = Date.now();
      const voice = input.voice ?? deps.voice;
      if (voice === null || voice.length === 0) {
        fail("model_unavailable", null, "没有可用的音色（voice 未配置）");
      }
      const model = input.model ?? deps.model;
      const body: Record<string, unknown> = {
        model,
        input: input.text,
        voice,
        response_format: input.format,
      };
      if (input.speed !== null && input.speed > 0) body.speed = input.speed;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timeout")), deps.timeoutMs);
      const onAbort = (): void => controller.abort(input.signal?.reason);
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          clearTimeout(timeout);
          fail("aborted", null, "语音合成被取消");
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const response = await (deps.fetchImpl ?? fetch)(base + "/audio/speech", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(deps.apiKey === null ? {} : { authorization: "Bearer " + deps.apiKey }),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let detail = "";
          try {
            const parsed = (await response.json()) as SpeechErrorBody;
            const message = parsed.error?.message;
            if (typeof message === "string") detail = " " + message.slice(0, 150);
          } catch {
            // 错误体不是 JSON：不强行解析，也不回显原始内容
          }
          fail(kindFromHttpStatus(response.status), response.status, "语音合成请求失败：HTTP " + String(response.status) + detail);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0) fail("invalid_response", response.status, "语音合成返回了空音频");

        // 上游可能在 Content-Type 里给出更准确的类型（例如 audio/mpeg）；否则用请求格式对应的 MIME
        const headerType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        const mimeType = headerType.startsWith("audio/") ? headerType : TTS_FORMAT_MIME[input.format];
        // 时长/采样率：上游不提供就不填（绝不从字节数推算）
        const durationHeader = response.headers.get("x-audio-duration-ms");
        const sampleRateHeader = response.headers.get("x-audio-sample-rate");
        const durationMs = durationHeader !== null && /^[0-9]+$/.test(durationHeader) ? Number(durationHeader) : null;
        const sampleRate = sampleRateHeader !== null && /^[0-9]+$/.test(sampleRateHeader) ? Number(sampleRateHeader) : null;

        return {
          bytes,
          mimeType,
          durationMs,
          sampleRate,
          providerId: deps.id,
          model,
          voice,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (controller.signal.aborted) {
          if (input.signal?.aborted === true) fail("aborted", null, "语音合成被取消", error);
          fail("timeout", null, "语音合成超时（" + String(deps.timeoutMs) + "ms）", error);
        }
        fail("network", null, "语音合成网络错误", error);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

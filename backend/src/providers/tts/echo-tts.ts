import type { TtsInput, TtsProvider, TtsResult } from "../../core/ports/tts.ts";
import { WAV_MIME, VOICE_SAMPLE_RATE, pcmToWav } from "./wav.ts";
import type { Logger } from "../../core/ports/logger.ts";

/**
 * 确定性的"占位" TTS Provider（Phase 4.5-D4）。
 *
 * 与既有 echo LLM / echo ASR 同思路：**零配置、零网络**也能把整条链路跑通。
 *
 * 它**不是语音合成**：不产生任何人声，而是按文本哈希生成一段确定性的音频信号
 * （24 kHz / 单声道 / 16bit WAV，时长与文本长度成正比）。
 * 这样做的好处是：它产出的是一份**真实、可解码、可被 D1 编码成 SILK** 的音频，
 * 因此出站语音链路可以被真正验证，而不是只搬一段假字节。
 */
export interface EchoTtsDeps {
  id?: string;
  model?: string;
  voice?: string;
  logger: Logger;
  /** 模拟耗时（测试用，毫秒） */
  delayMs?: number;
  /** 每字符对应的音频时长（毫秒），默认 60ms/字符，上限 8 秒 */
  msPerChar?: number;
  /** 模拟"provider 不报告元数据"（默认 false：echo 会报告采样率与时长） */
  omitMetadata?: boolean;
}

export function createEchoTtsProvider(deps: EchoTtsDeps): TtsProvider {
  const id = deps.id ?? "echo-tts";
  const model = deps.model ?? "echo-tts";
  const voice = deps.voice ?? "echo";
  const msPerChar = deps.msPerChar ?? 60;

  return {
    id,
    kind: "echo",
    defaultModel: model,
    defaultVoice: voice,

    async synthesize(input: TtsInput): Promise<TtsResult> {
      const started = Date.now();
      if (deps.delayMs !== undefined && deps.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, deps.delayMs);
          input.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
      }

      const durationMs = Math.min(8000, Math.max(120, Math.round(input.text.length * msPerChar)));
      const samples = Math.round((durationMs / 1000) * VOICE_SAMPLE_RATE);
      const pcm = new Uint8Array(samples * 2);
      const view = new DataView(pcm.buffer);
      // 用文本哈希决定基频：同样的文本 → 同样的音频（确定性）；不同文本 → 不同音频
      let hash = 0;
      for (let index = 0; index < input.text.length; index += 1) {
        hash = (hash * 31 + input.text.charCodeAt(index)) % 100_000;
      }
      const frequency = 220 + (hash % 440);
      for (let index = 0; index < samples; index += 1) {
        const value = Math.round(9000 * Math.sin((2 * Math.PI * frequency * index) / VOICE_SAMPLE_RATE));
        view.setInt16(index * 2, value, true);
      }
      deps.logger.debug("echo tts produced placeholder audio", { bytes: pcm.byteLength, durationMs });

      return {
        bytes: pcmToWav(pcm),
        mimeType: WAV_MIME,
        durationMs: deps.omitMetadata === true ? null : durationMs,
        sampleRate: deps.omitMetadata === true ? null : VOICE_SAMPLE_RATE,
        providerId: id,
        model,
        // 音色是调用方给的（或默认）；这不代表任何真实音色模型
        voice: input.voice ?? voice,
        latencyMs: Date.now() - started,
      };
    },
  };
}

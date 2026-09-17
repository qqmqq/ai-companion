import type { AsrInput, AsrProvider, AsrResult } from "../../core/ports/asr.ts";
import type { Logger } from "../../core/ports/logger.ts";

/**
 * 确定性的"回声" ASR Provider（Phase 4.5-D3）。
 *
 * 作用与既有的 echo LLM provider 一致：**零配置也能把链路跑通**，并且让测试完全不依赖网络。
 * 它**不是**语音识别：不做任何解码，只按字节长度与哈希产出一段可预测的占位文本，
 * 并且明确标注自己没有语言/置信度信息（两者都是 null，绝不编造）。
 */

export interface EchoAsrDeps {
  id?: string;
  model?: string;
  logger: Logger;
  /** 固定文本（测试用）；给了就完全按它返回 */
  text?: string;
  /** 模拟失败（测试用）：抛出的错误由调用方决定 */
  failWith?: "timeout" | "rate_limited" | "unauthorized" | "server_error" | "network";
  /** 模拟耗时（测试用，毫秒） */
  delayMs?: number;
  signalAware?: boolean;
}

export function createEchoAsrProvider(deps: EchoAsrDeps): AsrProvider {
  const id = deps.id ?? "echo-asr";
  const model = deps.model ?? "echo-asr";

  return {
    id,
    kind: "echo",
    defaultModel: model,

    async transcribe(input: AsrInput): Promise<AsrResult> {
      const started = Date.now();
      if (deps.delayMs !== undefined && deps.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, deps.delayMs);
          if (input.signal !== undefined) {
            input.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }
        }).catch(() => {
          throw new Error("echo ASR aborted");
        });
      }
      if (deps.failWith !== undefined) {
        // 由上层（transcription service / provider 包装）决定如何分类；这里只模拟上游行为
        throw new Error("echo ASR 模拟失败：" + deps.failWith);
      }
      const bytes = input.audio.bytes.byteLength;
      const text = deps.text ?? "（echo ASR 占位转写：收到 " + String(bytes) + " 字节音频）";
      deps.logger.debug("echo asr produced placeholder text", { providerId: id, bytes });
      return {
        text,
        // echo 没有真实识别能力：语言/时长/置信度一律 null，绝不假装知道
        language: null,
        durationMs: input.audio.durationMs,
        confidence: null,
        providerId: id,
        model,
        latencyMs: Date.now() - started,
      };
    },
  };
}

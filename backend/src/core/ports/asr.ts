import type { ProviderErrorKind } from "../model/provider-error.ts";

/**
 * ASR（语音转文字）端口（Phase 4.5-D3）。
 *
 * Core 只认识这个接口：不认识 Whisper、不认识 OpenAI、不认识任何云端或本地实现。
 * 具体实现放在 providers/asr/ 下，由组合根装配。
 *
 * 刻意保持"字节 + 元数据"的输入形态：
 * - Core 从 MediaStorage 取字节（不暴露任何文件系统路径），
 * - provider 只看得到它需要的东西：字节、MIME、时长、语言提示、AbortSignal。
 */

export interface AsrAudioInput {
  /** MediaStorage 的引用；日志里可以出现，便于排障 */
  mediaId: string;
  /** 音频字节（可用音频，绝不是 CDN 密文） */
  bytes: Uint8Array;
  /** 例如 audio/wav；未知时为 null */
  mimeType: string | null;
  /** 已知时长；未知为 null（不猜测） */
  durationMs: number | null;
  /** 可选文件名提示（例如 voice.wav） */
  filename?: string | null;
}

export interface AsrInput {
  audio: AsrAudioInput;
  /** 语言提示（例如 "zh"）；null 表示让 provider 自己判断 */
  language: string | null;
  /** 模型覆盖；null 表示用 provider 的默认模型 */
  model: string | null;
  signal?: AbortSignal;
}

export interface AsrResult {
  /** 识别文本；provider 返回空文本时必须由 provider 自己判定为失败，不要在这里伪造 */
  text: string;
  /** 只有 provider 真的返回了才填，否则 null */
  language: string | null;
  /** 只有 provider 真的返回了才填，否则 null */
  durationMs: number | null;
  /** 只有 provider 真的返回了置信度才填，否则 null（**绝不编造**） */
  confidence: number | null;
  providerId: string;
  model: string | null;
  /** 上游耗时（毫秒），用于诊断与成本观察 */
  latencyMs: number;
}

/** 错误分类：与 ProviderError 的分类体系保持一致（不另立一套） */
export type AsrErrorKind = ProviderErrorKind | "unsupported_audio" | "too_large" | "disabled";

export interface AsrProvider {
  readonly id: string;
  /** provider 实现种类（openai-compatible / echo / …），仅用于展示与日志 */
  readonly kind: string;
  /** provider 实际使用的默认模型（可能来自配置） */
  readonly defaultModel: string;
  transcribe(input: AsrInput): Promise<AsrResult>;
}

export interface AsrProviderRegistry {
  get(id: string): AsrProvider | undefined;
  list(): AsrProvider[];
}

import type { ProviderErrorKind } from "../model/provider-error.ts";

/**
 * TTS（语音合成）端口（Phase 4.5-D4）。
 *
 * Core 只认识这个接口：不认识 OpenAI、ElevenLabs、Edge TTS、Piper、CosyVoice、Fish Speech……
 * 具体实现放在 providers/tts/ 下，由组合根装配。
 *
 * 输入输出都刻意保持"纯数据"：文本进去、音频字节 + 真实元数据出来。
 * 没有就返回 null（例如 provider 不告诉采样率），**绝不编造**。
 */

import type { TtsOutputFormat } from "../model/tts.ts";
export type { TtsOutputFormat };

export interface TtsInput {
  text: string;
  /** 音色（provider 各自的命名，例如 alloy / zh-CN-XiaoxiaoNeural / 自定义 id） */
  voice: string | null;
  language: string | null;
  model: string | null;
  /** 语速（1 = 原速）；不支持时 provider 可以忽略，但必须原样报告 */
  speed: number | null;
  format: TtsOutputFormat;
  signal?: AbortSignal;
}

export interface TtsResult {
  bytes: Uint8Array;
  /** 生成音频的真实 MIME（例如 audio/wav） */
  mimeType: string | null;
  /** 只有 provider 真的返回了时长才填 */
  durationMs: number | null;
  /** 只有 provider 真的返回了采样率才填 */
  sampleRate: number | null;
  providerId: string;
  model: string | null;
  voice: string | null;
  latencyMs: number;
}

/** 错误分类：与 ProviderError 体系保持一致（不另立一套） */
export type TtsErrorKind = ProviderErrorKind | "disabled" | "configuration_error" | "too_long" | "unsupported_format";

export interface TtsProvider {
  readonly id: string;
  readonly kind: string;
  readonly defaultModel: string;
  readonly defaultVoice: string | null;
  synthesize(input: TtsInput): Promise<TtsResult>;
}

export interface TtsProviderRegistry {
  get(id: string): TtsProvider | undefined;
  list(): TtsProvider[];
}

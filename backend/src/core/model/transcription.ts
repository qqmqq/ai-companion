import { MEDIA_LIMITS } from "./media.ts";

/**
 * 语音转写（ASR）的状态模型（Phase 4.5-D3）。
 *
 * 关键设计：**媒体可用性与转写可用性是两件独立的事**。
 * - `AudioPart.media.status` 说的是"音频本身能不能用"；
 * - `AudioPart.transcription.status` 说的是"有没有转写文本"。
 * 因此 `media: available` + `transcription: failed` 是完全合法的组合，
 * 转写失败**绝不会**把音频标记成失败，也不会删除音频。
 */

export type TranscriptionStatus = "pending" | "processing" | "completed" | "failed";

export const TRANSCRIPTION_STATUSES: TranscriptionStatus[] = ["pending", "processing", "completed", "failed"];

/** 转写相关字段的长度上限，防止异常长的识别结果灌进上下文 */
export const TRANSCRIPTION_LIMITS = {
  maxTextLength: 8000,
  maxLanguageLength: 32,
  maxModelLength: 120,
  maxProviderLength: 120,
  maxErrorCodeLength: 64,
  maxErrorMessageLength: 300,
} as const;

export interface TranscriptionState {
  status: TranscriptionStatus;
  /** 只有 completed 才有文本；失败时是 null（绝不把失败伪装成空字符串） */
  text: string | null;
  /** 只有 provider 真的返回了才保留 */
  language: string | null;
  /** provider 真的返回了时长才保留 */
  durationMs: number | null;
  /** 只有 provider 真的返回了置信度才保留（绝不编造） */
  confidence: number | null;
  provider: string | null;
  model: string | null;
  /** 失败时的结构化错误分类（例如 timeout / rate_limited / aborted） */
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
  /** 是否复用了已有结果（没有再次调用 provider） */
  cached: boolean;
}

export interface TranscriptionStateInput {
  status?: unknown;
  text?: unknown;
  language?: unknown;
  durationMs?: unknown;
  confidence?: unknown;
  provider?: unknown;
  model?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
  updatedAt?: unknown;
  cached?: unknown;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function clampText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function clampCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/** 任何来源的转写状态都必须经过这里：截断、净化、规范化。 */
export function sanitizeTranscription(input: TranscriptionStateInput = {}): TranscriptionState {
  const status = TRANSCRIPTION_STATUSES.includes(input.status as TranscriptionStatus)
    ? (input.status as TranscriptionStatus)
    : "pending";
  return {
    status,
    text: status === "completed" ? clampText(input.text, TRANSCRIPTION_LIMITS.maxTextLength) : null,
    language: clampText(input.language, TRANSCRIPTION_LIMITS.maxLanguageLength),
    durationMs: clampCount(input.durationMs),
    confidence: clampConfidence(input.confidence),
    provider: clampText(input.provider, TRANSCRIPTION_LIMITS.maxProviderLength),
    model: clampText(input.model, TRANSCRIPTION_LIMITS.maxModelLength),
    errorCode: clampText(input.errorCode, TRANSCRIPTION_LIMITS.maxErrorCodeLength),
    errorMessage: clampText(input.errorMessage, TRANSCRIPTION_LIMITS.maxErrorMessageLength),
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt.length > 0 ? input.updatedAt : "",
    cached: input.cached === true,
  };
}

/** 转写状态是否应该出现在上下文里（只有真正拿到文本才算） */
export function transcriptionText(state: TranscriptionState | undefined): string | null {
  if (state === undefined || state.status !== "completed") return null;
  return state.text;
}

/** 供 partsToText 使用：有转写就带上去，没有就返回 null（不编造） */
export function describeTranscription(state: TranscriptionState | undefined): string | null {
  const text = transcriptionText(state);
  if (text === null) return null;
  if (state?.durationMs === null || state?.durationMs === undefined) return text;
  const seconds = Math.round(state.durationMs / 100) / 10;
  return text + "（语音 " + String(seconds) + "s）";
}

/** 媒体大小上限同样适用于"要不要送去转写"的判断 */
export function isTranscribableSize(sizeBytes: number | null): boolean {
  return sizeBytes !== null && Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes <= MEDIA_LIMITS.maxMediaBytes;
}

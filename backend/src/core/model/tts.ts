/**
 * 语音合成（TTS）状态模型（Phase 4.5-D4）。
 *
 * 与 D3 的转写状态**完全独立**：一条消息可以"有转写、没有语音"，也可以"有语音、没有转写"。
 * 而且 TTS 状态是**消息级**的（一段语音代表整条回复），不像转写是部件级的。
 *
 * 绝不重载 message.status / MediaReference.status / AudioPart.status。
 */

export type TtsStatus = "pending" | "processing" | "completed" | "failed" | "skipped";

/** 支持的输出容器（与各家 provider 的实现无关） */
export type TtsOutputFormat = "wav" | "mp3" | "opus" | "aac" | "flac";

export const TTS_OUTPUT_FORMATS: TtsOutputFormat[] = ["wav", "mp3", "opus", "aac", "flac"];

/** 输出格式 → MIME（Core 层的常识，provider 与渠道都从这里取，避免各写一份） */
export const TTS_FORMAT_MIME: Record<TtsOutputFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
};

export function isSupportedTtsFormat(value: unknown): value is TtsOutputFormat {
  return typeof value === "string" && (TTS_OUTPUT_FORMATS as string[]).includes(value);
}

export const TTS_STATUSES: TtsStatus[] = ["pending", "processing", "completed", "failed", "skipped"];

export const TTS_LIMITS = {
  maxTextLength: 4000,
  maxErrorCodeLength: 64,
  maxErrorMessageLength: 300,
  maxVoiceLength: 120,
  maxModelLength: 120,
  maxLanguageLength: 32,
  maxMediaIdLength: 120,
  maxMimeTypeLength: 120,
} as const;

export interface TtsState {
  status: TtsStatus;
  /** 生成音频的 MediaStorage 引用（只有 completed 才有） */
  mediaId: string | null;
  mimeType: string | null;
  /** 只有 provider 真的返回了才保留 */
  durationMs: number | null;
  sampleRate: number | null;
  provider: string | null;
  model: string | null;
  voice: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** 是否复用了缓存（没有再次调用 provider） */
  cached: boolean;
  updatedAt: string;
}

export interface TtsStateInput {
  status?: unknown;
  mediaId?: unknown;
  mimeType?: unknown;
  durationMs?: unknown;
  sampleRate?: unknown;
  provider?: unknown;
  model?: unknown;
  voice?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
  cached?: unknown;
  updatedAt?: unknown;
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

/** 任何来源的 TTS 状态都必须经过这里：截断、净化、规范化。 */
export function sanitizeTtsState(input: TtsStateInput = {}): TtsState {
  const status = TTS_STATUSES.includes(input.status as TtsStatus) ? (input.status as TtsStatus) : "pending";
  return {
    status,
    // 只有 completed 才允许声称有音频；其它状态一律清空，绝不留下"半成品引用"
    mediaId: status === "completed" ? clampText(input.mediaId, TTS_LIMITS.maxMediaIdLength) : null,
    mimeType: status === "completed" ? clampText(input.mimeType, TTS_LIMITS.maxMimeTypeLength) : null,
    durationMs: clampCount(input.durationMs),
    sampleRate: clampCount(input.sampleRate),
    provider: clampText(input.provider, TTS_LIMITS.maxModelLength),
    model: clampText(input.model, TTS_LIMITS.maxModelLength),
    voice: clampText(input.voice, TTS_LIMITS.maxVoiceLength),
    errorCode: clampText(input.errorCode, TTS_LIMITS.maxErrorCodeLength),
    errorMessage: clampText(input.errorMessage, TTS_LIMITS.maxErrorMessageLength),
    cached: input.cached === true,
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt.length > 0 ? input.updatedAt : "",
  };
}

/** 消息级 TTS 状态是否表示"已经有一段可用的语音" */
export function hasGeneratedSpeech(state: TtsState | undefined): boolean {
  return state !== undefined && state.status === "completed" && state.mediaId !== null;
}

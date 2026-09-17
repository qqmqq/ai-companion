import { MEDIA_LIMITS, isWithinMediaSizeLimit } from "../../../core/model/media.ts";
import { normalizeFileMime } from "./file-validation.ts";
import { isSilkBytes, isWavBytes, readWavFormat, type WavFormat } from "./voice-codec.ts";

/**
 * 音频校验（Phase 4.5-D1）。
 *
 * 原则与文件/视频一致：
 * - 音频只是"一段不透明字节"：**不解码、不做波形/声纹/降噪分析**，只做安全收发所需的检查；
 * - MIME **不做白名单**：只拒绝语法非法的值，未知但合法的音频类型放行；协议没有类型时用安全兜底；
 * - 容器识别用纯 JS 魔数（SILK / WAV）——只用于**一致性检查**，认不出来一律放行；
 * - 大小上限复用 Core 的 MEDIA_LIMITS。
 */

export type AudioContainer = "silk" | "wav" | "unknown";

export type AudioRejectReason = "empty" | "too_large" | "invalid_mime" | "mime_mismatch";

export interface AudioValidationOk {
  ok: true;
  mimeType: string;
  sizeBytes: number;
  container: AudioContainer;
  /** 只有 WAV 能读出格式；SILK 不给（它的参数由编解码器决定） */
  wavFormat: WavFormat | null;
}

export interface AudioValidationFailure {
  ok: false;
  reason: AudioRejectReason;
  detail: string;
}

export type AudioValidationResult = AudioValidationOk | AudioValidationFailure;

/** 只读魔数：认不出来返回 "unknown"（调用方必须放行，而不是拒绝） */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer {
  if (isSilkBytes(bytes)) return "silk";
  if (isWavBytes(bytes)) return "wav";
  return "unknown";
}

/** 常见音频类型 → 期望容器；未知类型返回 null（表示"不做一致性检查"） */
function containerForMime(mimeType: string): AudioContainer | null {
  if (mimeType === "audio/silk" || mimeType === "audio/x-silk") return "silk";
  if (mimeType === "audio/wav" || mimeType === "audio/wave" || mimeType === "audio/x-wav" || mimeType === "audio/vnd.wave") return "wav";
  return null;
}

export function validateAudio(input: {
  bytes: Uint8Array;
  declaredMime?: unknown;
  maxBytes?: number;
}): AudioValidationResult {
  const maxBytes = input.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, reason: "empty", detail: "音频内容为空" };
  if (!isWithinMediaSizeLimit(size, maxBytes)) {
    return { ok: false, reason: "too_large", detail: `音频超过大小上限（${size} > ${maxBytes} 字节）` };
  }

  const mime = normalizeFileMime(input.declaredMime);
  if (!mime.ok) return { ok: false, reason: mime.reason, detail: mime.detail };

  const container = sniffAudioContainer(input.bytes);
  const expected = containerForMime(mime.mimeType);
  if (expected !== null && container !== "unknown" && container !== expected) {
    return { ok: false, reason: "mime_mismatch", detail: "声明的音频类型与实际容器不符" };
  }

  const wavFormat = container === "wav" ? readWavFormat(input.bytes) : null;
  if (container === "wav" && wavFormat === null) {
    return { ok: false, reason: "mime_mismatch", detail: "WAV 文件头不可解析" };
  }

  return { ok: true, mimeType: mime.mimeType, sizeBytes: size, container, wavFormat };
}

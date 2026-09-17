import { MEDIA_LIMITS, isWithinMediaSizeLimit } from "../../../core/model/media.ts";
import { DEFAULT_FILE_MIME, normalizeFileMime } from "./file-validation.ts";

/**
 * 视频校验（Phase 4.5-C3）。
 *
 * 原则：
 * - **不做视频解码、不转码、不生成缩略图、不看帧**：视频只是一段不透明字节；
 * - MIME **不做白名单**：下面这份"常见类型"只用于**一致性检查**，不是准入名单，
 *   未知但语法合法的 \`video/*\` 一律放行（与文件策略一致）；
 * - 容器嗅探只读文件头（mp4 的 \`ftyp\`、Matroska/WebM 的 EBML 头、RIFF/AVI），
 *   只用于"声明与实际是否矛盾"，认不出来就**放行**（绝不猜）；
 * - 宽高/时长由协议提供才保留，我们**不为了拿这些值去解析视频**；
 * - 大小上限复用 Core 的 MEDIA_LIMITS。
 *
 * 协议事实（Phase 0 研究报告 §3.7）：入站视频的消息构造里**没有** MIME/宽高/时长字段，
 * 因此入站视频的 mimeType 一律走安全兜底 application/octet-stream。
 */

/** 常见视频类型（仅用于声明与内容的一致性检查，不是白名单）。 */
export const COMMON_VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo"] as const;

export type VideoRejectReason = "empty" | "too_large" | "invalid_mime" | "mime_mismatch";

export interface VideoValidationOk {
  ok: true;
  mimeType: string;
  sizeBytes: number;
}

export interface VideoValidationFailure {
  ok: false;
  reason: VideoRejectReason;
  detail: string;
}

export type VideoValidationResult = VideoValidationOk | VideoValidationFailure;

export type VideoContainer = "ftyp" | "ebml" | "riff-avi";

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/**
 * 只看文件头判断"这是哪一类容器家族"：
 * - \`ftyp\`：MP4 / MOV（ISO BMFF 家族，两者共用同一个 box）
 * - \`ebml\`：Matroska / WebM
 * - \`riff-avi\`：AVI
 * 认不出来返回 null —— 调用方必须**放行**而不是拒绝。
 */
export function sniffVideoContainer(bytes: Uint8Array): VideoContainer | null {
  // ISO BMFF：偏移 4 起是 "ftyp"
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "ftyp";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x41, 0x56, 0x49, 0x20], 8)) return "riff-avi";
  return null;
}

/** 声明类型 → 期望的容器家族；未知类型返回 null（表示"不做一致性检查"）。 */
function containerForMime(mimeType: string): VideoContainer | null {
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") return "ftyp";
  if (mimeType === "video/webm") return "ebml";
  if (mimeType === "video/x-msvideo") return "riff-avi";
  return null;
}

/**
 * 校验一段字节是否是可以收发、可以入库的视频。
 * \`declaredMime\` 只用于一致性检查，**不作为信任来源**；缺失时用安全兜底。
 */
export function validateVideo(input: {
  bytes: Uint8Array;
  declaredMime?: unknown;
  maxBytes?: number;
}): VideoValidationResult {
  const maxBytes = input.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, reason: "empty", detail: "视频内容为空" };
  if (!isWithinMediaSizeLimit(size, maxBytes)) {
    return { ok: false, reason: "too_large", detail: "视频超过大小上限（" + String(size) + " > " + String(maxBytes) + " 字节）" };
  }

  const mime = normalizeFileMime(input.declaredMime);
  if (!mime.ok) return { ok: false, reason: "invalid_mime", detail: mime.detail };

  // 只有"声明了常见类型 + 内容认得出家族 + 两者不一致"才拒绝；认不出内容一律放行
  const expected = containerForMime(mime.mimeType);
  if (expected !== null) {
    const actual = sniffVideoContainer(input.bytes);
    if (actual !== null && actual !== expected) {
      return { ok: false, reason: "mime_mismatch", detail: "声明的类型与内容容器不符" };
    }
  }

  return { ok: true, mimeType: mime.mimeType, sizeBytes: size };
}

/** 协议没给类型时的兜底（与文件一致）。 */
export const FALLBACK_VIDEO_MIME = DEFAULT_FILE_MIME;

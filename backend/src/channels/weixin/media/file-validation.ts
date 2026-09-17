import { MEDIA_LIMITS, isWithinMediaSizeLimit, sanitizeFilename, sanitizeMimeType } from "../../../core/model/media.ts";

/**
 * 文件校验（Phase 4.5-C2）。
 *
 * 原则：
 * - **文件是"不透明字节"**：不做内容嗅探、不解析内容、不看扩展名，也就不可能被内容误导；
 * - 文件名是**不可信输入**：先去掉路径成分与控制字符，再拒绝 "." / ".." 这类伪名字；
 * - MIME 不做"白名单"：文件本来就有成千上万种合法类型，只拒绝**语法非法**的值，
 *   协议没有给出类型时统一按 application/octet-stream 处理；
 * - 大小上限复用 Core 的 MEDIA_LIMITS（不新造第二套限制）。
 */

/** 协议没有给出更具体的类型时使用它。 */
export const DEFAULT_FILE_MIME = "application/octet-stream";

export type FileRejectReason = "empty" | "too_large" | "invalid_mime";

export interface FileValidationOk {
  ok: true;
  mimeType: string;
  sizeBytes: number;
  filename: string | null;
}

export interface FileValidationFailure {
  ok: false;
  reason: FileRejectReason;
  detail: string;
}

export type FileValidationResult = FileValidationOk | FileValidationFailure;

/**
 * 文件名净化：复用 Core 的 sanitizeFilename（去路径成分、去控制字符、限长），
 * 再拒绝没有实际名字的值（"." / ".." / "..."），保证文件名永远只是一个名字。
 */
export function sanitizeAttachmentFilename(value: unknown): string | null {
  const base = sanitizeFilename(value);
  if (base === null) return null;
  if (/^\.+$/.test(base)) return null;
  return base;
}

/**
 * 协议里的文件大小（file_item.len）是**十进制字符串**：只用它做"下载前的大小闸门"，
 * 解析失败就当作未知（不影响后续按实际字节判断）。
 */
export function parseDeclaredSize(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[0-9]{1,20}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** 声明大小已经超过上限时可以立刻拒绝，省掉一次没有意义的下载。 */
export function exceedsMediaLimit(declaredSizeBytes: number | null, maxBytes: number = MEDIA_LIMITS.maxMediaBytes): boolean {
  return declaredSizeBytes !== null && !isWithinMediaSizeLimit(declaredSizeBytes, maxBytes);
}

export function normalizeFileMime(
  declared: unknown,
): { ok: true; mimeType: string } | { ok: false; reason: "invalid_mime"; detail: string } {
  if (declared === null || declared === undefined) return { ok: true, mimeType: DEFAULT_FILE_MIME };
  if (typeof declared !== "string") return { ok: false, reason: "invalid_mime", detail: "MIME 不是字符串" };
  const trimmed = declared.trim();
  if (trimmed.length === 0) return { ok: true, mimeType: DEFAULT_FILE_MIME };
  // 去掉参数部分（charset 等）：协议里的类型只需要 type/subtype
  const bare = trimmed.split(";")[0]!.trim();
  if (bare.length === 0) return { ok: false, reason: "invalid_mime", detail: "MIME 语法非法" };
  const normalized = sanitizeMimeType(bare);
  // sanitizeMimeType 已经做了长度上限、控制字符清理与 "type/subtype" 语法校验
  if (normalized === null || !normalized.includes("/")) {
    return { ok: false, reason: "invalid_mime", detail: "MIME 语法非法" };
  }
  return { ok: true, mimeType: normalized };
}

/**
 * 校验一段字节是否是"可以收发、可以入库的文件"。
 * 只判断"大小 + MIME 语法 + 文件名净化"，**不判断内容**：PDF/ZIP/EXE 都只是一段字节。
 */
export function validateFile(input: {
  bytes: Uint8Array;
  declaredMime?: unknown;
  filename?: unknown;
  maxBytes?: number;
}): FileValidationResult {
  const maxBytes = input.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, reason: "empty", detail: "文件内容为空" };
  if (!isWithinMediaSizeLimit(size, maxBytes)) {
    return { ok: false, reason: "too_large", detail: `文件超过大小上限（${size} > ${maxBytes} 字节）` };
  }
  const mime = normalizeFileMime(input.declaredMime);
  if (!mime.ok) return { ok: false, reason: mime.reason, detail: mime.detail };
  return {
    ok: true,
    mimeType: mime.mimeType,
    sizeBytes: size,
    filename: sanitizeAttachmentFilename(input.filename),
  };
}

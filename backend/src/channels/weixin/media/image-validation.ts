import { MEDIA_LIMITS } from "../../../core/model/media.ts";

/**
 * 图片校验与轻量元数据解析（无第三方依赖、无 AI、无 OCR）。
 *
 * 原则：
 * - **不信任文件名后缀**：MIME 一律以魔数为准（文件名只作为辅助提示）；
 * - 只接受协议真正会出现的图片类型（jpeg/png/gif/webp），不做巨型白名单；
 * - 尺寸解析是"读文件头"级别的轻量实现，不认识就返回 null，绝不猜。
 */

export const IMAGE_MIME_ALLOWLIST = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_ALLOWLIST)[number];

export type ImageRejectReason =
  | "empty"
  | "too_large"
  | "unsupported_mime"
  | "not_an_image"
  | "mime_mismatch";

export interface ImageValidationOk {
  ok: true;
  mimeType: ImageMimeType;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

export interface ImageValidationFailure {
  ok: false;
  reason: ImageRejectReason;
  detail: string;
}

export type ImageValidationResult = ImageValidationOk | ImageValidationFailure;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/** 以魔数判断真实图片类型；不认识返回 null。 */
export function sniffImageMime(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // GIF8(7a|9a)
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

/** 只读取文件头里的宽高；解析不出来返回 null（不猜测）。 */
export function readImageDimensions(bytes: Uint8Array, mimeType: ImageMimeType): { width: number; height: number } | null {
  try {
    if (mimeType === "image/png") {
      // 8 字节签名 + 4 长度 + 4 类型("IHDR") + 宽 4 + 高 4
      if (bytes.byteLength < 24) return null;
      return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
    }
    if (mimeType === "image/gif") {
      if (bytes.byteLength < 10) return null;
      return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
    }
    if (mimeType === "image/webp") {
      // RIFF....WEBP + chunk fourcc + payload
      if (bytes.byteLength < 30) return null;
      const chunk = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
      if (chunk === "VP8X") {
        return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
      }
      if (chunk === "VP8 ") {
        return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const bits = (bytes[22] ?? 0) | ((bytes[23] ?? 0) << 8) | ((bytes[24] ?? 0) << 16) | ((bytes[25] ?? 0) << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG：扫描 SOFn 段
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: readUint16BE(bytes, offset + 5), width: readUint16BE(bytes, offset + 7) };
      }
      const segmentLength = readUint16BE(bytes, offset + 2);
      if (segmentLength <= 0) return null;
      offset += 2 + segmentLength;
    }
    return null;
  } catch {
    return null;
  }
}

export function mimeFromFilename(filename: string | null): string | null {
  if (filename === null) return null;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

/**
 * 校验一段字节是否是"可以发给微信/可以入库的图片"。
 * `declaredMime` 只作为一致性检查对象，**不作为信任来源**。
 */
export function validateImage(input: {
  bytes: Uint8Array;
  declaredMime?: string | null;
  filename?: string | null;
  maxBytes?: number;
}): ImageValidationResult {
  const maxBytes = input.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, reason: "empty", detail: "图片内容为空" };
  if (size > maxBytes) return { ok: false, reason: "too_large", detail: `图片超过大小上限（${size} > ${maxBytes} 字节）` };

  const sniffed = sniffImageMime(input.bytes);
  if (sniffed === null) {
    const declared = (input.declaredMime ?? mimeFromFilename(input.filename ?? null) ?? "").toLowerCase();
    if (declared.length > 0 && !IMAGE_MIME_ALLOWLIST.includes(declared as ImageMimeType)) {
      return { ok: false, reason: "unsupported_mime", detail: `不支持的图片类型：${declared}` };
    }
    return { ok: false, reason: "not_an_image", detail: "内容不是可识别的图片（魔数不匹配）" };
  }

  const declared = (input.declaredMime ?? "").toLowerCase().split(";")[0]!.trim();
  if (declared.length > 0 && declared.startsWith("image/") && declared !== sniffed) {
    return { ok: false, reason: "mime_mismatch", detail: `声明的类型（${declared}）与内容不符（${sniffed}）` };
  }

  const dimensions = readImageDimensions(input.bytes, sniffed);
  return {
    ok: true,
    mimeType: sniffed,
    sizeBytes: size,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { WeixinTransportError } from "../protocol/errors.ts";

/**
 * 微信媒体加密：AES-128-ECB + PKCS#7（手工填充，便于严格校验与测试）。
 *
 * 本模块是纯函数集合：
 * - 不读时钟、不做 IO、**不打任何日志**（密钥与媒体内容都不允许出现在日志里）；
 * - 密钥长度严格校验，既不截断也不补齐；
 * - 解密时的 padding 由我们自己校验，非法 padding 必须显式报错，绝不返回可疑明文。
 */

export const MEDIA_KEY_BYTES = 16;
export const AES_BLOCK_BYTES = 16;
export const AES_MEDIA_ALGORITHM = "aes-128-ecb";

/** 微信协议里的 `filesize`：PKCS#7 填充后的密文长度。 */
export function encryptedSize(plaintextSize: number): number {
  if (!Number.isFinite(plaintextSize) || plaintextSize < 0) {
    throw new WeixinTransportError("encryption_error", "明文大小非法", { retryable: false });
  }
  const size = Math.ceil((plaintextSize + 1) / AES_BLOCK_BYTES) * AES_BLOCK_BYTES;
  return size;
}

export function assertMediaKey(key: Uint8Array, phase: "encryption_error" | "decryption_error" = "encryption_error"): Buffer {
  if (!(key instanceof Uint8Array)) {
    throw new WeixinTransportError(phase, "媒体密钥必须是 Uint8Array/Buffer", { retryable: false });
  }
  if (key.byteLength !== MEDIA_KEY_BYTES) {
    // 关键：不截断、不补齐，直接拒绝
    throw new WeixinTransportError(phase, `媒体密钥长度必须是 ${MEDIA_KEY_BYTES} 字节，实际 ${key.byteLength}`, { retryable: false });
  }
  return Buffer.from(key);
}

export function generateMediaKey(): Uint8Array {
  return new Uint8Array(randomBytes(MEDIA_KEY_BYTES));
}

/** PKCS#7 填充（导出以便单独测试） */
export function pkcs7Pad(plaintext: Uint8Array): Buffer {
  const data = Buffer.from(plaintext);
  const padLength = AES_BLOCK_BYTES - (data.length % AES_BLOCK_BYTES);
  const padding = Buffer.alloc(padLength, padLength);
  return Buffer.concat([data, padding]);
}

/** PKCS#7 去填充；任何非法情况都抛 decryption_error。 */
export function pkcs7Unpad(padded: Uint8Array): Buffer {
  const data = Buffer.from(padded);
  if (data.length === 0) {
    throw new WeixinTransportError("decryption_error", "invalid padding: 空密文", { retryable: false });
  }
  if (data.length % AES_BLOCK_BYTES !== 0) {
    throw new WeixinTransportError("decryption_error", "invalid padding: 密文长度不是块大小的整数倍", { retryable: false });
  }
  const padLength = data[data.length - 1]!;
  if (padLength === 0 || padLength > AES_BLOCK_BYTES) {
    throw new WeixinTransportError("decryption_error", `invalid padding: padding 长度非法（${padLength}）`, { retryable: false });
  }
  if (padLength > data.length) {
    throw new WeixinTransportError("decryption_error", "invalid padding: padding 超过密文长度", { retryable: false });
  }
  for (let index = data.length - padLength; index < data.length; index += 1) {
    if (data[index] !== padLength) {
      throw new WeixinTransportError("decryption_error", "invalid padding: padding 字节不一致", { retryable: false });
    }
  }
  return data.subarray(0, data.length - padLength);
}

export function encryptMedia(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const keyBuffer = assertMediaKey(key, "encryption_error");
  const padded = pkcs7Pad(plaintext);
  const cipher = createCipheriv(AES_MEDIA_ALGORITHM, keyBuffer, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  if (encrypted.length !== encryptedSize(plaintext.byteLength)) {
    throw new WeixinTransportError("encryption_error", "密文长度与预期不一致", { retryable: false });
  }
  return new Uint8Array(encrypted);
}

export function decryptMedia(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const keyBuffer = assertMediaKey(key, "decryption_error");
  const data = Buffer.from(ciphertext);
  if (data.length === 0 || data.length % AES_BLOCK_BYTES !== 0) {
    throw new WeixinTransportError("decryption_error", "invalid ciphertext: 长度非法", { retryable: false });
  }
  const decipher = createDecipheriv(AES_MEDIA_ALGORITHM, keyBuffer, null);
  decipher.setAutoPadding(false);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (error) {
    // 错误的密钥通常在这里失败；不泄漏密钥内容
    throw new WeixinTransportError("decryption_error", "解密失败（密钥不匹配或密文损坏）", { retryable: false, cause: error });
  }
  return new Uint8Array(pkcs7Unpad(decrypted));
}

/** 协议字段：getUploadUrl.aeskey 使用 16 字节密钥的十六进制字符串 */
export function mediaKeyToHex(key: Uint8Array): string {
  assertMediaKey(key);
  return Buffer.from(key).toString("hex");
}

export function mediaKeyFromHex(hex: string): Uint8Array {
  const cleaned = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(cleaned)) {
    throw new WeixinTransportError("decryption_error", "aeskey 必须是 32 个十六进制字符", { retryable: false });
  }
  return new Uint8Array(Buffer.from(cleaned, "hex"));
}

/** 协议字段：媒体消息里的 aes_key 是"十六进制字符串"再做 base64 */
export function mediaKeyToProtocolBase64(key: Uint8Array): string {
  return Buffer.from(mediaKeyToHex(key), "utf8").toString("base64");
}

export function mediaKeyFromProtocolBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch (error) {
    throw new WeixinTransportError("decryption_error", "aes_key 不是合法 base64", { retryable: false, cause: error });
  }
  return mediaKeyFromHex(decoded);
}

/** 明文 md5（十六进制）：协议 `rawfilemd5` 需要 */
export function plaintextMd5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(Buffer.from(bytes)).digest("hex");
}
/**
 * 入站媒体密钥的线上形态（三者都接受，顺序即协议里的优先级由调用方决定）：
 * - 32 位十六进制字符串（`image_item.aeskey`）
 * - base64(16 原始字节)
 * - base64(32 位十六进制字符串)
 */
export function decodeWireMediaKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new WeixinTransportError("decryption_error", "缺少媒体密钥", { retryable: false });
  }
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return mediaKeyFromHex(trimmed);

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.byteLength === MEDIA_KEY_BYTES) return new Uint8Array(decoded);
  if (decoded.byteLength === 32) {
    const asHex = decoded.toString("utf8");
    if (/^[0-9a-fA-F]{32}$/.test(asHex)) return mediaKeyFromHex(asHex);
  }
  throw new WeixinTransportError("decryption_error", `无法识别的媒体密钥编码（${decoded.byteLength} 字节）`, { retryable: false });
}

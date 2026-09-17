import { randomBytes } from "node:crypto";

/**
 * UUIDv7：48 位毫秒时间戳 + 版本/变体位 + 随机位。
 * 有序，适合作为 SQLite 主键（分页与时间范围扫描友好）。
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(nowMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 非幂等随机令牌（用于会话、幂等键等）。 */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

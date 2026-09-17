import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: string; // base64
  nonce: string; // base64
  tag: string; // base64
  keyRef: string;
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`master key must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/** AES-256-GCM；本地存储一律这条路径（协议侧的 AES-128-ECB 只允许用于微信传输）。 */
export function sealSecret(plaintext: string, key: Buffer, keyRef = "default"): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyRef,
  };
}

export function openSecret(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  AES_BLOCK_BYTES,
  MEDIA_KEY_BYTES,
  assertMediaKey,
  decryptMedia,
  encryptedSize,
  encryptMedia,
  generateMediaKey,
  decodeWireMediaKey,
  mediaKeyFromHex,
  mediaKeyFromProtocolBase64,
  mediaKeyToHex,
  mediaKeyToProtocolBase64,
  pkcs7Pad,
  pkcs7Unpad,
  plaintextMd5Hex,
} from "../../src/channels/weixin/media/aes-media.ts";
import { WeixinTransportError } from "../../src/channels/weixin/protocol/errors.ts";

function expectKind(error: unknown, kind: string): boolean {
  assert.ok(error instanceof WeixinTransportError, `expected WeixinTransportError, got ${String(error)}`);
  assert.equal((error as WeixinTransportError).kind, kind);
  assert.equal((error as WeixinTransportError).retryable, false, "加密/解密错误一律不可重试");
  return true;
}

test("encryptedSize matches PKCS#7 padding for all boundary sizes", () => {
  const cases: Array<[number, number]> = [
    [0, 16],
    [1, 16],
    [15, 16],
    [16, 32],
    [17, 32],
    [31, 32],
    [32, 48],
    [33, 48],
  ];
  for (const [plain, expected] of cases) {
    assert.equal(encryptedSize(plain), expected, `encryptedSize(${plain})`);
    assert.equal(encryptedSize(plain), pkcs7Pad(new Uint8Array(plain)).length, "公式必须与 PKCS#7 填充一致");
  }
  assert.throws(() => encryptedSize(-1), (error: unknown) => expectKind(error, "encryption_error"));
  assert.throws(() => encryptedSize(Number.NaN), (error: unknown) => expectKind(error, "encryption_error"));
});

test("PKCS#7 padding round-trips and always adds a full block when aligned", () => {
  for (const size of [0, 1, 15, 16, 17, 31, 32, 33]) {
    const data = new Uint8Array(randomBytes(size));
    const padded = pkcs7Pad(data);
    assert.equal(padded.length % AES_BLOCK_BYTES, 0);
    assert.ok(padded.length > size, "至少会补出 1 个字节的 padding");
    const restored = pkcs7Unpad(padded);
    assert.ok(Buffer.from(restored).equals(Buffer.from(data)), `size ${size} 还原失败`);
  }
  // 16 字节整块必须补出完整的一块
  assert.equal(pkcs7Pad(new Uint8Array(16)).length, 32);
});

test("invalid padding is rejected with a clear error, never returning wrong plaintext", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["not block aligned", new Uint8Array(20)],
    ["pad length 0", new Uint8Array(32)],
    ["pad length > 16", (() => { const b = new Uint8Array(32); b[31] = 17; return b; })()],
    ["inconsistent padding bytes", (() => { const b = new Uint8Array(32); b[31] = 4; b[30] = 3; b[29] = 4; b[28] = 4; return b; })()],
  ];
  for (const [label, bytes] of cases) {
    assert.throws(
      () => pkcs7Unpad(bytes),
      (error: unknown) => {
        assert.ok(error instanceof WeixinTransportError);
        assert.equal((error as WeixinTransportError).kind, "decryption_error");
        assert.match((error as Error).message, /invalid padding|ciphertext/);
        return true;
      },
      label,
    );
  }
});

test("AES-128-ECB round-trips for every size, comparing bytes not strings", () => {
  const key = generateMediaKey();
  const sizes = [0, 1, 15, 16, 17, 32, 33, 1024, 65535];
  for (const size of sizes) {
    const plaintext = new Uint8Array(randomBytes(size));
    const ciphertext = encryptMedia(plaintext, key);
    assert.equal(ciphertext.byteLength, encryptedSize(size), `密文长度必须等于 encryptedSize(${size})`);
    const decrypted = decryptMedia(ciphertext, key);
    assert.ok(Buffer.from(decrypted).equals(Buffer.from(plaintext)), `size ${size} 二进制不一致`);
  }

  // 随机二进制（含 0x00/0xFF 等）也必须完全一致
  const random = new Uint8Array(randomBytes(4096));
  const decrypted = decryptMedia(encryptMedia(random, key), key);
  assert.equal(Buffer.compare(Buffer.from(decrypted), Buffer.from(random)), 0);
});

test("media keys are strictly 16 bytes: no truncation, no padding", () => {
  assert.equal(generateMediaKey().byteLength, MEDIA_KEY_BYTES);
  assertMediaKey(new Uint8Array(16));

  for (const size of [0, 15, 17, 32]) {
    assert.throws(
      () => assertMediaKey(new Uint8Array(size)),
      (error: unknown) => {
        assert.ok(error instanceof WeixinTransportError);
        assert.equal((error as WeixinTransportError).kind, "encryption_error");
        assert.match((error as Error).message, /16 字节/);
        return true;
      },
      `key length ${size} 必须被拒绝`,
    );
  }
  assert.throws(() => assertMediaKey("0123456789abcdef" as unknown as Uint8Array), (error: unknown) => expectKind(error, "encryption_error"));
});

test("decryption fails cleanly with a wrong key or tampered ciphertext", () => {
  const key = generateMediaKey();
  const other = generateMediaKey();
  const plaintext = new Uint8Array(randomBytes(256));
  const ciphertext = encryptMedia(plaintext, key);

  // 错误的密钥可能直接解密失败，也可能"解出来但 padding 非法"——两种都必须显式报错，
  // 关键是绝不允许返回可疑明文。
  assert.throws(() => decryptMedia(ciphertext, other), (error: unknown) => {
    assert.ok(error instanceof WeixinTransportError);
    assert.equal((error as WeixinTransportError).kind, "decryption_error");
    assert.equal((error as WeixinTransportError).retryable, false);
    assert.match((error as Error).message, /解密失败|invalid padding/);
    return true;
  });

  const tampered = new Uint8Array(ciphertext);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
  assert.throws(() => decryptMedia(tampered, key), (error: unknown) => expectKind(error, "decryption_error"));

  assert.throws(() => decryptMedia(new Uint8Array(17), key), (error: unknown) => expectKind(error, "decryption_error"));
  assert.throws(() => decryptMedia(new Uint8Array(0), key), (error: unknown) => expectKind(error, "decryption_error"));
});

test("key encodings follow the protocol exactly (hex in request, base64-of-hex in messages)", () => {
  const key = new Uint8Array(randomBytes(16));
  const hex = mediaKeyToHex(key);
  assert.match(hex, /^[0-9a-f]{32}$/);
  assert.ok(Buffer.from(mediaKeyFromHex(hex)).equals(Buffer.from(key)));

  const protocolValue = mediaKeyToProtocolBase64(key);
  assert.equal(Buffer.from(protocolValue, "base64").toString("utf8"), hex);
  assert.ok(Buffer.from(mediaKeyFromProtocolBase64(protocolValue)).equals(Buffer.from(key)));

  assert.throws(() => mediaKeyFromHex("zz"), (error: unknown) => expectKind(error, "decryption_error"));
  assert.throws(() => mediaKeyFromHex("0".repeat(31)), (error: unknown) => expectKind(error, "decryption_error"));
});

test("wire media keys are accepted in every protocol form we may receive", () => {
  const key = new Uint8Array(randomBytes(16));
  const hex = mediaKeyToHex(key);

  // 形态一：image_item.aeskey 的 32 位 hex
  assert.ok(Buffer.from(decodeWireMediaKey(hex)).equals(Buffer.from(key)));
  // 形态二：media.aes_key = base64(32 位 hex 字符串)
  assert.ok(Buffer.from(decodeWireMediaKey(mediaKeyToProtocolBase64(key))).equals(Buffer.from(key)));
  // 形态三：base64(16 字节原始密钥)
  assert.ok(Buffer.from(decodeWireMediaKey(Buffer.from(key).toString("base64"))).equals(Buffer.from(key)));

  // 无效输入一律失败，且错误里不能出现输入本身
  for (const bad of ["", "zz", "0".repeat(31), Buffer.from(new Uint8Array(8)).toString("base64"), "not-a-key"]) {
    assert.throws(
      () => decodeWireMediaKey(bad),
      (error: unknown) => {
        assert.ok(error instanceof WeixinTransportError);
        assert.equal((error as Error).message.includes(bad) && bad.length > 0, false, "错误信息不得回显密钥材料");
        return true;
      },
    );
  }
});

test("rawfilemd5 is the plaintext md5 in hex", () => {
  const bytes = new Uint8Array(randomBytes(64));
  assert.equal(plaintextMd5Hex(bytes), createHash("md5").update(Buffer.from(bytes)).digest("hex"));
});

test("the crypto module never logs and never reaches the network", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "channels", "weixin", "media", "aes-media.ts"), "utf8");
  assert.equal(/console\.(log|info|warn|error|debug)/.test(source), false, "加密模块不允许有任何 console 调用");
  assert.equal(/logger/.test(source), false, "加密模块不接触日志器（密钥/字节都不允许落日志）");
  assert.equal(/\bfetch\s*\(/.test(source), false, "加密模块不得发起网络请求");
});
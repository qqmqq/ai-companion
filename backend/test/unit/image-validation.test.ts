import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_MIME_ALLOWLIST, mimeFromFilename, readImageDimensions, sniffImageMime, validateImage } from "../../src/channels/weixin/media/image-validation.ts";

function png(width = 2, height = 3): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return new Uint8Array(Buffer.concat([signature, ihdr]));
}

function jpeg(width = 40, height = 20): Uint8Array {
  const bytes = Buffer.alloc(20);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  bytes.writeUInt16BE(height, 11);
  bytes.writeUInt16BE(width, 13);
  return new Uint8Array(bytes);
}

function gif(width = 5, height = 6): Uint8Array {
  const bytes = Buffer.alloc(12);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return new Uint8Array(bytes);
}

function webpVp8x(width = 320, height = 200): Uint8Array {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(24, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return new Uint8Array(bytes);
}

test("magic bytes decide the type and the allowlist stays small", () => {
  assert.deepEqual([...IMAGE_MIME_ALLOWLIST], ["image/jpeg", "image/png", "image/gif", "image/webp"]);
  assert.equal(sniffImageMime(png()), "image/png");
  assert.equal(sniffImageMime(jpeg()), "image/jpeg");
  assert.equal(sniffImageMime(gif()), "image/gif");
  assert.equal(sniffImageMime(webpVp8x()), "image/webp");
  // 不是图片的东西一律 null，不猜
  assert.equal(sniffImageMime(new TextEncoder().encode("<html>hi</html>")), null);
  assert.equal(sniffImageMime(new Uint8Array(0)), null);
  assert.equal(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null, "只有 RIFF 前缀不算 webp");
});

test("dimensions come from the header only, per format", () => {
  assert.deepEqual(readImageDimensions(png(12, 34), "image/png"), { width: 12, height: 34 });
  assert.deepEqual(readImageDimensions(jpeg(40, 20), "image/jpeg"), { width: 40, height: 20 });
  assert.deepEqual(readImageDimensions(gif(5, 6), "image/gif"), { width: 5, height: 6 });
  assert.deepEqual(readImageDimensions(webpVp8x(320, 200), "image/webp"), { width: 320, height: 200 });
  // 头部被截断时不猜测
  assert.equal(readImageDimensions(new Uint8Array([0x89, 0x50]), "image/png"), null);
  assert.equal(readImageDimensions(new Uint8Array(4), "image/jpeg"), null);
});

test("accepts real images and reports size plus dimensions", () => {
  const result = validateImage({ bytes: png(7, 9), declaredMime: "image/png" });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 7);
  assert.equal(result.height, 9);
  assert.equal(result.sizeBytes, png(7, 9).byteLength);
});

test("filenames are never trusted: a lie about the extension is rejected", () => {
  const text = new TextEncoder().encode("PNG? no, just text pretending to be one");
  const byName = validateImage({ bytes: text, filename: "photo.png" });
  assert.equal(byName.ok, false);
  assert.ok(!byName.ok);
  assert.equal(byName.reason, "not_an_image");

  // 真图配错后缀：仍然以内容为准（后缀不参与判断）
  const real = validateImage({ bytes: png(), filename: "photo.jpg" });
  assert.equal(real.ok, true);
  assert.ok(real.ok);
  assert.equal(real.mimeType, "image/png");

  assert.equal(mimeFromFilename("A.PNG"), "image/png");
  assert.equal(mimeFromFilename("a.webp"), "image/webp");
  assert.equal(mimeFromFilename("a.bmp"), null);
  assert.equal(mimeFromFilename(null), null);
});

test("a declared type that contradicts the content is a mismatch, not a pass", () => {
  const mismatch = validateImage({ bytes: jpeg(), declaredMime: "image/png" });
  assert.equal(mismatch.ok, false);
  assert.ok(!mismatch.ok);
  assert.equal(mismatch.reason, "mime_mismatch");
  assert.match(mismatch.detail, /image\/jpeg/);

  // 非 image/* 的声明不触发 mismatch（它只是元数据），仍然能通过
  const declared = validateImage({ bytes: png(), declaredMime: "application/octet-stream" });
  assert.equal(declared.ok, true);

  // 不支持的图片类型明确报 unsupported_mime
  const unsupported = validateImage({ bytes: new TextEncoder().encode("BM...."), declaredMime: "image/bmp" });
  assert.equal(unsupported.ok, false);
  assert.ok(!unsupported.ok);
  assert.equal(unsupported.reason, "unsupported_mime");
});

test("empty and oversized payloads are rejected before anything else happens", () => {
  const empty = validateImage({ bytes: new Uint8Array(0) });
  assert.equal(empty.ok, false);
  assert.ok(!empty.ok);
  assert.equal(empty.reason, "empty");

  const ten = validateImage({ bytes: png(), maxBytes: 8 });
  assert.equal(ten.ok, false);
  assert.ok(!ten.ok);
  assert.equal(ten.reason, "too_large");

  // 边界：正好等于上限必须通过
  const bytes = png();
  const boundary = validateImage({ bytes, maxBytes: bytes.byteLength });
  assert.equal(boundary.ok, true, "等于上限是允许的，不能差一字节就拒");
});

test("the validation module is pure: no logging, no network, no image library", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "channels", "weixin", "media", "image-validation.ts"), "utf8");
  assert.equal(/console\.(log|info|warn|error|debug)/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/logger/.test(source), false);
  // 不引入图像/AI 依赖：只允许 node 内置与本地模块
  assert.equal(/from "(sharp|jimp|canvas|tesseract)/.test(source), false);
});

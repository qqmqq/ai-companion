import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMON_VIDEO_MIME_TYPES, FALLBACK_VIDEO_MIME, sniffVideoContainer, validateVideo } from "../../src/channels/weixin/media/video-validation.ts";
import { MEDIA_LIMITS } from "../../src/core/model/media.ts";

const bytes = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = index % 256;
  return out;
};

function mp4(size = 512): Uint8Array {
  const out = bytes(size);
  out.set([0x66, 0x74, 0x79, 0x70], 4);
  return out;
}

function webm(size = 512): Uint8Array {
  const out = bytes(size);
  out.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return out;
}

function avi(size = 512): Uint8Array {
  const out = bytes(size);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  out.set([0x41, 0x56, 0x49, 0x20], 8);
  return out;
}

test("container sniffing only reads the header family and never guesses", () => {
  assert.equal(sniffVideoContainer(mp4()), "ftyp");
  assert.equal(sniffVideoContainer(webm()), "ebml");
  assert.equal(sniffVideoContainer(avi()), "riff-avi");
  // 认不出来 → null（调用方必须放行，而不是拒绝）
  assert.equal(sniffVideoContainer(bytes(64)), null);
  assert.equal(sniffVideoContainer(new Uint8Array(0)), null);
  assert.equal(sniffVideoContainer(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null, "只有 RIFF 前缀不算 AVI");
});

test("common video MIME types are accepted, and unknown but valid ones are not rejected", () => {
  for (const mimeType of COMMON_VIDEO_MIME_TYPES) {
    const data = mimeType === "video/webm" ? webm() : mimeType === "video/x-msvideo" ? avi() : mp4();
    const result = validateVideo({ bytes: data, declaredMime: mimeType });
    assert.equal(result.ok, true, mimeType);
    assert.equal(result.ok ? result.mimeType : null, mimeType);
  }

  // 未知但语法合法的视频类型必须放行（不做 MIME 白名单）
  for (const mimeType of ["video/x-matroska", "video/mpeg", "video/3gpp", "video/x-flv", "video/ogg", "video/av1"]) {
    const result = validateVideo({ bytes: bytes(256), declaredMime: mimeType });
    assert.equal(result.ok, true, mimeType);
    assert.equal(result.ok ? result.mimeType : null, mimeType);
  }

  // 大写与参数都会被规范化
  const normalized = validateVideo({ bytes: mp4(), declaredMime: "VIDEO/MP4; codecs=avc1" });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.ok ? normalized.mimeType : null, "video/mp4");
});

test("protocol without a MIME falls back safely instead of rejecting", () => {
  for (const missing of [null, undefined, "", "   "]) {
    const result = validateVideo({ bytes: mp4(), declaredMime: missing });
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.mimeType : null, FALLBACK_VIDEO_MIME, "兜底必须是 application/octet-stream");
  }
  // 这是入站视频的真实情况：协议不提供 MIME
  const inbound = validateVideo({ bytes: bytes(1024) });
  assert.equal(inbound.ok, true);
  assert.equal(inbound.ok ? inbound.mimeType : null, FALLBACK_VIDEO_MIME);
});

test("declared type that contradicts the container is rejected, unknown containers are not", () => {
  const mismatch = validateVideo({ bytes: webm(), declaredMime: "video/mp4" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.ok === false ? mismatch.reason : null, "mime_mismatch");
  assert.equal((mismatch as { detail: string }).detail.includes("不符"), true);

  // mp4 与 quicktime 同属 ISO BMFF 家族：不能互相判为不匹配
  assert.equal(validateVideo({ bytes: mp4(), declaredMime: "video/quicktime" }).ok, true);
  assert.equal(validateVideo({ bytes: avi(), declaredMime: "video/x-msvideo" }).ok, true);

  // 声明了常见类型但内容认不出来 → 放行（绝不猜）
  assert.equal(validateVideo({ bytes: bytes(256), declaredMime: "video/mp4" }).ok, true);
  // 声明了未知类型 → 不做一致性检查
  assert.equal(validateVideo({ bytes: mp4(), declaredMime: "video/x-flv" }).ok, true);
});

test("invalid MIME syntax, empty and oversized payloads are rejected", () => {
  const empty = validateVideo({ bytes: new Uint8Array(0) });
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false ? empty.reason : null, "empty");

  for (const broken of ["not a mime", "video/", "/mp4", "video//mp4", 42, {}, "x".repeat(300) + "/y"]) {
    const result = validateVideo({ bytes: mp4(), declaredMime: broken });
    assert.equal(result.ok, false, JSON.stringify(broken));
    assert.equal(result.ok === false ? result.reason : null, "invalid_mime");
  }

  // 精确上限通过、上限 + 1 拒绝（复用同一套 MEDIA_LIMITS）
  assert.equal(validateVideo({ bytes: bytes(64), maxBytes: 64 }).ok, true);
  const over = validateVideo({ bytes: bytes(65), maxBytes: 64 });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false ? over.reason : null, "too_large");
  const overCore = validateVideo({ bytes: bytes(MEDIA_LIMITS.maxMediaBytes + 1) });
  assert.equal(overCore.ok, false);
  assert.equal(overCore.ok === false ? overCore.reason : null, "too_large");
});

test("the validation layer is pure: no decoding, no transcoding, no thumbnails, no network", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "channels", "weixin", "media", "video-validation.ts"), "utf8");
  assert.equal(/console\.(log|info|warn|error|debug)/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/logger/.test(source), false);
  // 不引入任何视频库 / 解码器
  assert.equal(/from "(ffmpeg|fluent-ffmpeg|sharp|mp4box|ebml|node-webm)/.test(source), false);
  assert.equal(/thumb/i.test(source.replace(/no_need_thumb|thumb_media/g, "")), false, "校验层不生成缩略图");
});

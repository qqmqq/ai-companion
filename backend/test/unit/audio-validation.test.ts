import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffAudioContainer, validateAudio } from "../../src/channels/weixin/media/audio-validation.ts";
import { pcmToWav } from "../../src/channels/weixin/media/voice-codec.ts";
import { MEDIA_LIMITS } from "../../src/core/model/media.ts";

const bytes = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = index % 256;
  return out;
};

const SILK_HEADER = [0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33];

function silk(size = 256): Uint8Array {
  const out = bytes(size);
  out.set(SILK_HEADER, 0);
  return out;
}

function wav(size = 480): Uint8Array {
  return pcmToWav(bytes(size));
}

test("container sniffing recognises SILK and WAV, and says unknown rather than guessing", () => {
  assert.equal(sniffAudioContainer(silk()), "silk");
  assert.equal(sniffAudioContainer(wav()), "wav");
  assert.equal(sniffAudioContainer(bytes(128)), "unknown");
  assert.equal(sniffAudioContainer(new Uint8Array(0)), "unknown");
  assert.equal(sniffAudioContainer(new Uint8Array([0x49, 0x44, 0x33])), "unknown", "MP3 我们不认容器（本阶段不解码 mp3）");
});

test("common audio MIME types pass, unknown but valid ones are not rejected", () => {
  for (const mimeType of ["audio/mpeg", "audio/wav", "audio/wave", "audio/x-wav", "audio/ogg", "audio/webm", "audio/mp4", "audio/aac", "audio/flac", "audio/silk", "application/octet-stream"]) {
    const result = validateAudio({ bytes: bytes(256), declaredMime: mimeType });
    assert.equal(result.ok, true, mimeType);
    assert.equal(result.ok ? result.mimeType : null, mimeType);
  }
  // 未知但语法合法 → 放行（不做 MIME 白名单）
  assert.equal(validateAudio({ bytes: bytes(64), declaredMime: "audio/x-something-weird" }).ok, true);
  // 大写与参数规范化
  const normalized = validateAudio({ bytes: wav(), declaredMime: "AUDIO/WAV; codecs=1" });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.ok ? normalized.mimeType : null, "audio/wav");
});

test("missing MIME falls back safely (Weixin gives us no audio MIME)", () => {
  for (const missing of [null, undefined, "", "   "]) {
    const result = validateAudio({ bytes: silk(), declaredMime: missing });
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.mimeType : null, "application/octet-stream");
    assert.equal(result.ok ? result.container : null, "silk");
  }
});

test("declared type that contradicts the container is rejected; unknown containers are not", () => {
  const mismatch = validateAudio({ bytes: silk(), declaredMime: "audio/wav" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.ok === false ? mismatch.reason : null, "mime_mismatch");

  const mismatch2 = validateAudio({ bytes: wav(), declaredMime: "audio/silk" });
  assert.equal(mismatch2.ok, false);

  // 认不出容器 → 放行（绝不猜）
  assert.equal(validateAudio({ bytes: bytes(256), declaredMime: "audio/wav" }).ok, true);
  // 未知类型 → 不做一致性检查
  assert.equal(validateAudio({ bytes: bytes(256), declaredMime: "audio/ogg" }).ok, true);
  // WAV 头不可解析（RIFF/WAVE 但 chunk 结构坏）→ 拒绝
  const broken = new Uint8Array(48);
  broken.set([0x52, 0x49, 0x46, 0x46], 0);
  broken.set([0x57, 0x41, 0x56, 0x45], 8);
  const brokenResult = validateAudio({ bytes: broken, declaredMime: "audio/wav" });
  assert.equal(brokenResult.ok, false);
});

test("WAV format metadata is read from the header without decoding audio", () => {
  const result = validateAudio({ bytes: wav(1000), declaredMime: "audio/wav" });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.container, "wav");
  assert.equal(result.wavFormat?.sampleRate, 24000);
  assert.equal(result.wavFormat?.channels, 1);
  assert.equal(result.wavFormat?.bitsPerSample, 16);
  assert.equal(result.wavFormat?.dataBytes, 1000);
});

test("empty, oversized and syntactically invalid MIME are rejected", () => {
  const empty = validateAudio({ bytes: new Uint8Array(0) });
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false ? empty.reason : null, "empty");

  assert.equal(validateAudio({ bytes: bytes(1), declaredMime: "audio/mpeg" }).ok, true);

  for (const broken of ["not a mime", "audio/", "/mpeg", "audio//mpeg", 42, {}, "x".repeat(300) + "/y"]) {
    const result = validateAudio({ bytes: bytes(64), declaredMime: broken });
    assert.equal(result.ok, false, JSON.stringify(broken));
    assert.equal(result.ok === false ? result.reason : null, "invalid_mime");
  }

  assert.equal(validateAudio({ bytes: bytes(64), maxBytes: 64 }).ok, true, "正好等于上限是允许的");
  const over = validateAudio({ bytes: bytes(65), maxBytes: 64 });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false ? over.reason : null, "too_large");
  const overCore = validateAudio({ bytes: bytes(MEDIA_LIMITS.maxMediaBytes + 1) });
  assert.equal(overCore.ok, false);
  assert.equal(overCore.ok === false ? overCore.reason : null, "too_large");
});

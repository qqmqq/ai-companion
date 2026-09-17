import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  DEFAULT_FILE_MIME,
  exceedsMediaLimit,
  normalizeFileMime,
  parseDeclaredSize,
  sanitizeAttachmentFilename,
  validateFile,
} from "../../src/channels/weixin/media/file-validation.ts";
import { createLocalMediaStorage } from "../../src/storage/media/local-media-storage.ts";
import { MEDIA_LIMITS } from "../../src/core/model/media.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createLogger } from "../../src/app/logger.ts";

const bytes = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = index % 256;
  return out;
};

test("filenames are reduced to a pure name: no paths, no drive letters, no UNC, no control chars", () => {
  const cases: Array<[string, string | null]> = [
    ["normal.pdf", "normal.pdf"],
    ["hello world.txt", "hello world.txt"],
    ["中文文件.pdf", "中文文件.pdf"],
    ["../../secret.txt", "secret.txt"],
    ["..\\..\\secret.txt", "secret.txt"],
    ["C:\\secret.txt", "secret.txt"],
    ["\\\\server\\share\\secret.txt", "secret.txt"],
    ["/etc/passwd", "passwd"],
    ["../", null],
    ["..", null],
    [".", null],
    ["...", null],
    ["", null],
    ["   ", null],
    ["\u0000", null],
    ["a\u0000b.txt", "ab.txt"],
    ["evil\r\nname.txt", "evilname.txt"],
    ["file\u001b[31m.txt", "file[31m.txt"],
    ["a".repeat(500) + ".bin", "a".repeat(MEDIA_LIMITS.maxFilenameLength)],
  ];
  for (const [input, expected] of cases) {
    const sanitized = sanitizeAttachmentFilename(input);
    assert.equal(sanitized, expected, JSON.stringify(input));
    if (sanitized !== null) {
      assert.equal(/[\\/]/.test(sanitized), false, "结果里不允许残留路径分隔符");
      assert.equal(sanitized.includes(":"), false, "结果里不允许残留盘符冒号");
      assert.ok(sanitized.length <= MEDIA_LIMITS.maxFilenameLength);
      assert.equal(/[\u0000-\u001f\u007f]/.test(sanitized), false, "结果里不允许控制字符");
    }
  }
  assert.equal(sanitizeAttachmentFilename(undefined), null);
  assert.equal(sanitizeAttachmentFilename(42), null);
});

test("a hostile filename can never decide where bytes are written", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-file-root-"));
  try {
    const storage = createLocalMediaStorage({
      dataDir: root,
      logger: createLogger({ level: "error", sink: () => {} }),
      clock: createFakeClock(),
    });
    const hostile = ["../../secret.txt", "..\\..\\secret.txt", "C:\\secret.txt", "\\\\server\\share\\secret.txt", ".."];
    const ids: string[] = [];
    for (const name of hostile) {
      const sanitized = sanitizeAttachmentFilename(name);
      const asset = await storage.put({ bytes: bytes(64), mimeType: "text/plain", filename: sanitized, origin: "channel" });
      ids.push(asset.mediaId);
    }

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(root);

    const mediaRoot = join(root, "media") + sep;
    assert.equal(files.length, hostile.length * 2, "每个媒体只有 .bin 与 .json 两个文件");
    for (const file of files) {
      assert.ok(file.startsWith(mediaRoot), "落盘路径必须待在媒体根目录内：" + file);
      assert.ok(/^[0-9a-f]{32}\.(bin|json)$/.test(file.slice(mediaRoot.length).split(sep).pop() ?? ""), "文件名只能是 mediaId");
    }
    assert.equal(files.some((file) => file.endsWith("secret.txt")), false);

    // 元数据里保存的也是净化后的名字
    for (const id of ids) {
      const stored = await storage.get(id);
      assert.equal(/[\\/]/.test(stored?.filename ?? ""), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file MIME policy: normalize valid values, default when absent, reject only broken syntax", () => {
  const accepted: Array<[string, string]> = [
    ["application/pdf", "application/pdf"],
    ["application/zip", "application/zip"],
    ["application/octet-stream", "application/octet-stream"],
    ["text/plain", "text/plain"],
    ["application/json", "application/json"],
    ["APPLICATION/PDF", "application/pdf"],
    ["text/plain; charset=utf-8", "text/plain"],
    [" application/vnd.openxmlformats-officedocument.wordprocessingml.document ", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ];
  for (const [input, expected] of accepted) {
    const result = normalizeFileMime(input);
    assert.equal(result.ok, true, input);
    assert.equal(result.ok ? result.mimeType : null, expected);
  }

  // 协议没给类型 → octet-stream，而不是拒绝
  for (const missing of [null, undefined, "", "   "]) {
    const result = normalizeFileMime(missing);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.mimeType : null, DEFAULT_FILE_MIME);
  }

  // 语法非法 → 明确拒绝
  for (const broken of ["definitely not a mime", "text/", "/plain", "text//plain", "text plain", 42, {}, "a".repeat(300) + "/x"]) {
    const result = normalizeFileMime(broken);
    assert.equal(result.ok, false, JSON.stringify(broken));
    assert.equal(result.ok === false ? result.reason : null, "invalid_mime");
  }

  // 未知但语法合法的类型必须放行（不做 MIME 白名单）
  assert.equal(normalizeFileMime("application/x-something-weird").ok, true);
});

test("declared sizes come from the protocol as decimal strings and never overflow", () => {
  assert.equal(parseDeclaredSize("0"), 0);
  assert.equal(parseDeclaredSize("123"), 123);
  assert.equal(parseDeclaredSize("  42  "), 42);
  assert.equal(parseDeclaredSize(7), 7);
  for (const bad of ["", " ", "-1", "1.5", "abc", "0x10", "1e3", null, undefined, {}, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseDeclaredSize(bad), null, JSON.stringify(bad));
  }
  // 超过安全整数范围的十进制字符串也不能被当成精确大小
  assert.equal(parseDeclaredSize("99999999999999999999"), null);

  assert.equal(exceedsMediaLimit(null), false);
  assert.equal(exceedsMediaLimit(MEDIA_LIMITS.maxMediaBytes), false);
  assert.equal(exceedsMediaLimit(MEDIA_LIMITS.maxMediaBytes + 1), true);
});

test("size policy reuses the shared media limit and rejects undersized/oversized payloads", () => {
  const empty = validateFile({ bytes: bytes(0) });
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false ? empty.reason : null, "empty");

  const one = validateFile({ bytes: bytes(1), declaredMime: "text/plain" });
  assert.equal(one.ok, true);
  assert.equal(one.ok ? one.sizeBytes : -1, 1);

  const small = validateFile({ bytes: bytes(1024), declaredMime: "application/zip", filename: "a.zip" });
  assert.equal(small.ok, true);
  assert.equal(small.ok ? small.filename : null, "a.zip");

  // 正好等于上限：允许
  const exact = validateFile({ bytes: bytes(64), maxBytes: 64 });
  assert.equal(exact.ok, true);

  // 上限 + 1：拒绝，并且理由明确
  const over = validateFile({ bytes: bytes(65), maxBytes: 64 });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false ? over.reason : null, "too_large");

  const overCore = validateFile({ bytes: bytes(MEDIA_LIMITS.maxMediaBytes + 1) });
  assert.equal(overCore.ok, false);
  assert.equal(overCore.ok === false ? overCore.reason : null, "too_large");
});

test("filename sanitization and MIME rejection compose inside validateFile", () => {
  const hostile = validateFile({ bytes: bytes(16), filename: "..\\..\\boot.ini", declaredMime: "text/plain" });
  assert.equal(hostile.ok, true);
  assert.equal(hostile.ok ? hostile.filename : null, "boot.ini");

  const noName = validateFile({ bytes: bytes(16), filename: ".." });
  assert.equal(noName.ok, true);
  assert.equal(noName.ok ? noName.filename : "unexpected", null, "伪名字不产生文件名，但不是失败");

  const badMime = validateFile({ bytes: bytes(16), declaredMime: "not a mime", filename: "a.bin" });
  assert.equal(badMime.ok, false);
  assert.equal(badMime.ok === false ? badMime.reason : null, "invalid_mime");

  // 文件内容是"不透明字节"：既不做内容嗅探，也不看扩展名
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  const executable = validateFile({ bytes: elf, filename: "not-really.txt", declaredMime: "application/x-elf" });
  assert.equal(executable.ok, true, "可执行文件也只当普通文件传输，不做任何解释");
});

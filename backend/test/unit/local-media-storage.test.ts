import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLocalMediaStorage } from "../../src/storage/media/local-media-storage.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createLogger } from "../../src/app/logger.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { MEDIA_LIMITS } from "../../src/core/model/media.ts";

function stack(maxBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "companion-media-"));
  const logLines: string[] = [];
  const storage = createLocalMediaStorage({
    dataDir: dir,
    logger: createLogger({ level: "trace", sink: (line) => logLines.push(line) }),
    clock: createFakeClock(),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { storage, logLines, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("media storage keeps bytes out of the database and returns metadata only", async () => {
  const s = stack();
  try {
    const bytes = new Uint8Array(randomBytes(2048));
    const asset = await s.storage.put({ bytes, mimeType: "image/png", filename: "a.png", origin: "channel" });
    assert.match(asset.mediaId, /^[0-9a-f]{32}$/);
    assert.equal(asset.sizeBytes, 2048);
    assert.equal(asset.mimeType, "image/png");
    assert.equal(asset.filename, "a.png");
    assert.equal(asset.checksum.length, 64);
    assert.equal("bytes" in asset, false, "元数据里不能带内容");

    assert.equal(await s.storage.has(asset.mediaId), true);
    const read = await s.storage.get(asset.mediaId);
    assert.ok(read !== null);
    assert.equal(Buffer.compare(Buffer.from(read.bytes), Buffer.from(bytes)), 0, "读回必须二进制一致");
    assert.deepEqual(await s.storage.stat(asset.mediaId), asset);

    assert.equal(await s.storage.remove(asset.mediaId), true);
    assert.equal(await s.storage.get(asset.mediaId), null);
    assert.equal(await s.storage.remove(asset.mediaId), false, "重复删除返回 false");
  } finally {
    s.cleanup();
  }
});

test("media storage enforces its size limit and rejects malformed ids", async () => {
  const s = stack(1024);
  try {
    await assert.rejects(
      () => s.storage.put({ bytes: new Uint8Array(2048), mimeType: null, filename: null, origin: "channel" }),
      (error: unknown) => error instanceof DomainError && /大小上限/.test(error.message),
    );
    assert.equal(await s.storage.get("../../etc/passwd"), null, "非法 id 不能触及文件系统");
    assert.equal(await s.storage.get("not-an-id"), null);
    assert.equal(await s.storage.has("ZZZZ"), false);
    await assert.rejects(() => s.storage.remove("../../etc/passwd"), (error: unknown) => error instanceof DomainError);
  } finally {
    s.cleanup();
  }
});

test("media storage logs sizes and ids only, never content", async () => {
  const s = stack();
  try {
    const bytes = new Uint8Array(randomBytes(256));
    const asset = await s.storage.put({ bytes, mimeType: "application/pdf", filename: "r.pdf", origin: "channel" });
    await s.storage.get(asset.mediaId);
    await s.storage.remove(asset.mediaId);

    const joined = s.logLines.join("\n");
    assert.match(joined, /media stored/);
    assert.match(joined, new RegExp(asset.mediaId));
    assert.equal(joined.includes(Buffer.from(bytes).toString("base64")), false, "日志里不能出现内容");
    assert.equal(joined.includes(Buffer.from(bytes).toString("hex")), false);
  } finally {
    s.cleanup();
  }
});

test("default limit matches the shared media limit constant", async () => {
  const s = stack();
  try {
    const asset = await s.storage.put({ bytes: new Uint8Array(16), mimeType: null, filename: null, origin: "channel" });
    assert.equal(typeof asset.mediaId, "string");
    assert.equal(MEDIA_LIMITS.maxMediaBytes, 25 * 1024 * 1024);
  } finally {
    s.cleanup();
  }
});

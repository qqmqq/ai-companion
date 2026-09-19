import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inferMessageType,
  normalizeMessageParts,
  partsToText,
  type MessagePart,
} from "../../src/core/model/message.ts";
import {
  MEDIA_LIMITS,
  describeMedia,
  emptyMediaReference,
  hasMediaPayload,
  isExternalMedia,
  sanitizeFilename,
  sanitizeMediaReference,
  sanitizeMediaUrl,
  sanitizeMimeType,
} from "../../src/core/model/media.ts";
import { toOutboundParts } from "../../src/core/services/messaging-pipeline.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { seedFixtures } from "../helpers/memory-stack.ts";
import { createMessageRepository } from "../../src/storage/repositories/messages.ts";

const AT = "2026-03-01T00:00:00.000Z";

test("every part kind round-trips through normalization", () => {
  const parts: MessagePart[] = [
    { kind: "text", text: "看这张图" },
    { kind: "image", media: sanitizeMediaReference({ mediaId: "media-1", mimeType: "image/png", width: 800, height: 600, status: "available" }) },
    { kind: "audio", media: sanitizeMediaReference({ mediaId: "media-2", mimeType: "audio/wav", durationMs: 3200 }), transcript: "你好呀" },
    { kind: "video", media: sanitizeMediaReference({ mediaId: "media-3", mimeType: "video/mp4", durationMs: 12_000, width: 1920, height: 1080 }) },
    { kind: "file", media: sanitizeMediaReference({ mediaId: "media-4", mimeType: "application/pdf", filename: "报告.pdf", sizeBytes: 1024 }) },
  ];

  const result = normalizeMessageParts(JSON.parse(JSON.stringify(parts)));
  assert.deepEqual(result.rejected, []);
  assert.equal(result.parts.length, 5);
  assert.equal(result.parts[0]?.kind, "text");

  const image = result.parts[1];
  assert.equal(image?.kind, "image");
  if (image?.kind !== "image") throw new Error("unreachable");
  assert.equal(image.media.mediaId, "media-1");
  assert.equal(image.media.mimeType, "image/png");
  assert.equal(image.media.width, 800);
  assert.equal(image.media.status, "available");

  const audio = result.parts[2];
  if (audio?.kind !== "audio") throw new Error("unreachable");
  assert.equal(audio.media.durationMs, 3200);
  assert.equal(audio.transcript, "你好呀");

  const file = result.parts[4];
  if (file?.kind !== "file") throw new Error("unreachable");
  assert.equal(file.media.filename, "报告.pdf");
  assert.equal(file.media.sizeBytes, 1024);
});

test("a mixed message keeps order and survives a database round-trip", () => {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const messages = createMessageRepository(db);
  try {
    const parts: MessagePart[] = [
      { kind: "text", text: "第一段" },
      { kind: "image", media: sanitizeMediaReference({ mediaId: "m-img", mimeType: "image/jpeg" }) },
      { kind: "text", text: "第二段" },
      { kind: "file", media: sanitizeMediaReference({ mediaId: "m-file", mimeType: "application/pdf", filename: "a.pdf", sizeBytes: 5 }) },
    ];
    messages.insert({
      id: "msg-media",
      conversationId: "cv1",
      role: "user",
      parts,
      textRender: partsToText(parts),
      replyToId: null,
      providerMessageId: null,
      tokenCount: null,
      status: "completed",
      errorText: null,
      source: "conversation",
      createdAt: AT,
      editedAt: null,
      branchOfId: null,
    });

    const stored = messages.getById("msg-media");
    assert.ok(stored !== null);
    assert.deepEqual(
      stored.parts.map((part) => part.kind),
      ["text", "image", "text", "file"],
      "顺序必须保持",
    );
    assert.equal(stored.textRender, "第一段\n[图片]\n第二段\n[文件: a.pdf]");
    assert.equal(inferMessageType(stored.parts), "mixed");
  } finally {
    db.close();
  }
});

test("文本片段只清控制垃圾，换行与制表符必须留下（否则从库里读回来的消息会变成一行）", () => {
  const result = normalizeMessageParts([
    { kind: "text", text: "第一行\n第二行\n\t缩进" },
    { kind: "text", text: "坏\u0000字\u001b符" },
  ]);
  assert.equal(result.parts[0]?.kind === "text" ? result.parts[0].text : "", "第一行\n第二行\n\t缩进");
  assert.equal(result.parts[1]?.kind === "text" ? result.parts[1].text : "", "坏字符", "NUL/ESC 仍要被清掉");
  assert.equal(partsToText(result.parts), "第一行\n第二行\n\t缩进\n坏字符");
});

test("empty and structurally invalid inputs degrade safely instead of throwing", () => {
  assert.deepEqual(normalizeMessageParts([]), { parts: [], rejected: [] });
  assert.deepEqual(normalizeMessageParts([]).parts, []);
  assert.equal(partsToText([]), "");
  assert.equal(inferMessageType([]), "system");

  const broken = normalizeMessageParts([null, "string", 42, { kind: "text", text: "" }, { kind: "quote" }, { notAPart: true }]);
  assert.equal(broken.parts.length, 0);
  assert.deepEqual(
    broken.rejected.map((entry) => entry.reason),
    ["invalid_shape", "invalid_shape", "invalid_shape", "invalid_shape", "invalid_shape", "unknown_kind"],
  );

  // 非数组输入不能让消息系统崩溃
  assert.deepEqual(normalizeMessageParts(null).parts, []);
  assert.deepEqual(normalizeMessageParts({ kind: "text", text: "x" }).parts, []);
});

test("unknown part kinds are rejected but the rest of the message survives", () => {
  const result = normalizeMessageParts([
    { kind: "text", text: "保留我" },
    { kind: "unsupported_future_kind", payload: { anything: true } },
    { kind: "audio", media: { mediaId: "ok", mimeType: "audio/wav" } },
  ]);
  assert.deepEqual(
    result.parts.map((part) => part.kind),
    ["text", "audio"],
  );
  assert.deepEqual(result.rejected, [{ index: 1, reason: "unknown_kind" }]);
  assert.equal(partsToText(result.parts), "保留我\n[语音]");
});

test("legacy flat media parts are upgraded to the unified model", () => {
  // Phase 1 时代的扁平结构（fileId/mime/name/size）
  const legacy = [
    { kind: "text", text: "老消息" },
    { kind: "image", fileId: "legacy-file-1", mime: "image/png", width: 100, height: 50 },
    { kind: "file", fileId: "legacy-file-2", mime: "application/pdf", name: "旧文件.pdf", size: 2048 },
    { kind: "audio", fileId: "legacy-file-3", mime: "audio/wav", durationMs: 1000, transcript: "老语音" },
  ];
  const result = normalizeMessageParts(legacy);
  assert.deepEqual(result.rejected, []);

  const image = result.parts[1];
  if (image?.kind !== "image") throw new Error("unreachable");
  assert.equal(image.media.mediaId, "legacy-file-1");
  assert.equal(image.media.mimeType, "image/png");
  assert.equal(image.media.width, 100);

  const file = result.parts[2];
  if (file?.kind !== "file") throw new Error("unreachable");
  assert.equal(file.media.filename, "旧文件.pdf");
  assert.equal(file.media.sizeBytes, 2048);

  const audio = result.parts[3];
  if (audio?.kind !== "audio") throw new Error("unreachable");
  assert.equal(audio.transcript, "老语音");
  assert.equal(partsToText(result.parts), "老消息\n[图片]\n[文件: 旧文件.pdf]\n老语音");
});

test("a legacy text-only row in the database still reads correctly", () => {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const messages = createMessageRepository(db);
  try {
    // 直接写一条 Phase 1 风格的旧行（扁平 parts JSON）
    db.raw
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content_json, text_render, reply_to_id, provider_message_id, token_count, status, error_text, source, created_at, edited_at, branch_of_id)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'completed', NULL, 'conversation', ?, NULL, NULL)`,
      )
      .run("legacy-1", "cv1", "user", JSON.stringify([{ kind: "text", text: "很久以前的消息" }]), "很久以前的消息", AT);

    const stored = messages.getById("legacy-1");
    assert.ok(stored !== null);
    assert.equal(stored.parts.length, 1);
    assert.equal(stored.parts[0]?.kind, "text");
    assert.equal(stored.textRender, "很久以前的消息");
    assert.equal(partsToText(stored.parts), "很久以前的消息");
  } finally {
    db.close();
  }
});

test("MIME handling accepts real types and rejects junk", () => {
  assert.equal(sanitizeMimeType("image/png"), "image/png");
  assert.equal(sanitizeMimeType("IMAGE/JPEG"), "image/jpeg");
  assert.equal(sanitizeMimeType("audio/wav"), "audio/wav");
  assert.equal(sanitizeMimeType("video/mp4"), "video/mp4");
  assert.equal(sanitizeMimeType("application/pdf"), "application/pdf");
  assert.equal(sanitizeMimeType("text/plain; charset=utf-8"), "text/plain; charset=utf-8");
  assert.equal(sanitizeMimeType("not a mime"), null);
  assert.equal(sanitizeMimeType("image/"), null);
  assert.equal(sanitizeMimeType(42), null);
  assert.equal(sanitizeMimeType("x".repeat(500)), null, "超长 mime 直接判为非法");
});

test("oversized fields are clamped and never enter Core unbounded", () => {
  const media = sanitizeMediaReference({
    mediaId: "m".repeat(5000),
    mimeType: "image/png",
    filename: "f".repeat(5000),
    sizeBytes: 123,
    url: `https://example.com/${"a".repeat(10_000)}`,
    status: "available",
  });
  assert.equal(media.mediaId?.length, MEDIA_LIMITS.maxMediaIdLength);
  assert.equal(media.filename?.length, MEDIA_LIMITS.maxFilenameLength);
  assert.equal(media.url?.value.length, MEDIA_LIMITS.maxUrlLength);

  const textResult = normalizeMessageParts([{ kind: "text", text: "x".repeat(100_000) }]);
  assert.equal(textResult.parts[0]?.kind === "text" ? textResult.parts[0].text.length : -1, MEDIA_LIMITS.maxTextPartLength);
  assert.deepEqual(textResult.rejected, [{ index: 0, reason: "text_truncated" }]);

  const tooMany = normalizeMessageParts(Array.from({ length: MEDIA_LIMITS.maxPartsPerMessage + 5 }, (_v, index) => ({ kind: "text", text: `t${index}` })));
  assert.equal(tooMany.parts.length, MEDIA_LIMITS.maxPartsPerMessage);
  assert.equal(tooMany.rejected.filter((entry) => entry.reason === "too_many_parts").length, 5);

  const longCaption = normalizeMessageParts([{ kind: "image", media: {}, caption: "c".repeat(5000) }]);
  const image = longCaption.parts[0];
  if (image?.kind !== "image") throw new Error("unreachable");
  assert.ok((image.caption?.length ?? 0) <= 500);
});

test("filenames never carry path components and control characters are stripped", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Users\\me\\secret.png"), "secret.png");
  assert.equal(sanitizeFilename("bad\u0000name\u001b.png"), "badname.png");
  assert.equal(sanitizeFilename("   "), null);
});

test("media urls are labelled by origin and never treated as instructions", () => {
  const external = sanitizeMediaReference({ origin: "external", url: "https://example.com/a.png" });
  assert.equal(external.url?.kind, "external");
  assert.equal(isExternalMedia(external), true);

  const internal = sanitizeMediaReference({ mediaId: "m1", url: "local://media/m1" });
  assert.equal(internal.url?.kind, "internal");
  assert.equal(isExternalMedia(internal), false);

  // 显式声明 internal 的不会被 origin 改写
  assert.equal(sanitizeMediaUrl("local://x", "internal")?.kind, "internal");
  assert.equal(sanitizeMediaUrl(12345), null);
  assert.equal(emptyMediaReference().status, "pending");
  assert.equal(hasMediaPayload(emptyMediaReference()), false);
  assert.equal(hasMediaPayload(sanitizeMediaReference({ mediaId: "m" })), true);
});

test("context text representation uses placeholders only, never object dumps", () => {
  const parts = normalizeMessageParts([
    { kind: "image", media: { mediaId: "m1", mimeType: "image/png", filename: "secret-path.png" } },
    { kind: "audio", media: { mediaId: "m2", mimeType: "audio/wav", durationMs: 1000 } },
    { kind: "video", media: { mediaId: "m3", mimeType: "video/mp4" } },
    { kind: "file", media: { mediaId: "m4", mimeType: "application/pdf" } },
    { kind: "file", media: { mediaId: "m5", mimeType: "application/pdf", filename: "报告.pdf" } },
  ]).parts;
  const text = partsToText(parts);
  assert.equal(text, "[图片]\n[语音]\n[视频]\n[文件]\n[文件: 报告.pdf]");
  assert.equal(text.includes("[object"), false);
  assert.equal(text.includes("mediaId"), false, "占位文本里不能出现内部字段名");
  assert.equal(text.includes("m1"), false, "占位文本里不能出现内部 id");
  assert.equal(describeMedia("file", emptyMediaReference()), "[文件]");
});

test("outbound mapping forwards media as data instead of a placeholder string", () => {
  const parts = normalizeMessageParts([
    { kind: "text", text: "给你看个东西" },
    { kind: "image", media: { mediaId: "m1", mimeType: "image/png" }, caption: "配图" },
    { kind: "file", media: { mediaId: "m2", mimeType: "application/pdf", filename: "a.pdf" } },
  ]).parts;
  const outbound = toOutboundParts(parts);
  assert.deepEqual(
    outbound.map((part) => part.kind),
    ["text", "image", "file"],
  );
  assert.deepEqual(outbound[1], { kind: "image", media: expectImageMedia(), caption: "配图" });
});

function expectImageMedia(): unknown {
  return (normalizeMessageParts([{ kind: "image", media: { mediaId: "m1", mimeType: "image/png" } }]).parts[0] as { media: unknown }).media;
}

test("the media model itself never performs network access", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "core", "model", "media.ts"), "utf8");
  assert.equal(/\bfetch\s*\(/.test(source), false, "媒体模型不得自己发起网络请求");
  assert.equal(/node:http|node:https|axios|undici/.test(source), false, "媒体模型不得引入网络客户端");
  assert.equal(/Date\.now/.test(source), false, "媒体模型保持纯函数，不依赖时钟");
});

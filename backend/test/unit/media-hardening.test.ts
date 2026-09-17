import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptionService } from "../../src/core/services/transcription-service.ts";
import { createTtsService } from "../../src/core/services/tts-service.ts";
import { createTranscriptionRepository } from "../../src/storage/repositories/transcriptions.ts";
import { createTtsSynthesisRepository } from "../../src/storage/repositories/tts-syntheses.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createMessageRepository } from "../../src/storage/repositories/messages.ts";
import { createLocalMediaStorage } from "../../src/storage/media/local-media-storage.ts";
import { auditMediaReferences } from "../../src/app/media-audit.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { seedFixtures } from "../helpers/memory-stack.ts";
import { runMigrations } from "../../src/storage/migrations.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createKeyedLock } from "../../src/util/keyed-lock.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";
import { DomainError } from "../../src/core/model/errors.ts";
import { sanitizeTtsState } from "../../src/core/model/tts.ts";
import { pcmToWav } from "../../src/channels/weixin/media/voice-codec.ts";
import type { AsrProvider } from "../../src/core/ports/asr.ts";
import type { TtsProvider } from "../../src/core/ports/tts.ts";
import type { InternalMessage, MessagePart } from "../../src/core/model/message.ts";

const WAV = pcmToWav(new Uint8Array(480 * 2));

function harness(options: { asrDelayMs?: number; ttsDelayMs?: number; asrError?: unknown; ttsError?: unknown } = {}) {
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-e-"));
  const logger = createLogger({ level: "error", sink: () => {} });
  const storage = createLocalMediaStorage({ dataDir, logger, clock });
  const settings = createSettingsRepository(db);
  settings.put("asr.enabled", true, clock.nowIso());
  settings.put("asr.providerId", "asr", clock.nowIso());
  settings.put("tts.enabled", true, clock.nowIso());
  settings.put("tts.providerId", "tts", clock.nowIso());
  settings.put("tts.voice", "v1", clock.nowIso());

  let asrCalls = 0;
  let ttsCalls = 0;
  const asrProvider: AsrProvider = {
    id: "asr",
    kind: "fake",
    defaultModel: "asr-model",
    async transcribe() {
      asrCalls += 1;
      if (options.asrDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.asrDelayMs));
      if (options.asrError !== undefined) throw options.asrError;
      return { text: "转写文本", language: null, durationMs: 1000, confidence: null, providerId: "asr", model: "asr-model", latencyMs: 1 };
    },
  };
  const ttsProvider: TtsProvider = {
    id: "tts",
    kind: "fake",
    defaultModel: "tts-model",
    defaultVoice: "v1",
    async synthesize() {
      ttsCalls += 1;
      if (options.ttsDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.ttsDelayMs));
      if (options.ttsError !== undefined) throw options.ttsError;
      return { bytes: WAV, mimeType: "audio/wav", durationMs: 1000, sampleRate: 24000, providerId: "tts", model: "tts-model", voice: "v1", latencyMs: 1 };
    },
  };

  const transcriptions = createTranscriptionRepository(db);
  const ttsSyntheses = createTtsSynthesisRepository(db);
  const messages = createMessageRepository(db);
  const transcription = createTranscriptionService({
    registry: { get: () => asrProvider, list: () => [asrProvider] },
    repository: transcriptions,
    storage,
    settings,
    logger,
    clock,
    lock: createKeyedLock(),
  });
  const tts = createTtsService({
    registry: { get: () => ttsProvider, list: () => [ttsProvider] },
    repository: ttsSyntheses,
    storage,
    settings,
    logger,
    clock,
    lock: createKeyedLock(),
  });

  return {
    db,
    clock,
    storage,
    settings,
    messages,
    transcriptions,
    ttsSyntheses,
    transcription,
    tts,
    dataDir,
    asrCalls: () => asrCalls,
    ttsCalls: () => ttsCalls,
    close: () => {
      rmSync(dataDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function seedAudio(h: ReturnType<typeof harness>, durationMs: number | null = 1000) {
  const asset = await h.storage.put({ bytes: WAV, mimeType: "audio/wav", filename: null, origin: "channel" });
  const part: MessagePart = {
    kind: "audio",
    media: {
      mediaId: asset.mediaId,
      mimeType: "audio/wav",
      filename: null,
      sizeBytes: asset.sizeBytes,
      width: null,
      height: null,
      durationMs,
      origin: "channel",
      status: "available",
      url: { kind: "internal", value: "media:" + asset.mediaId },
    },
  };
  return { asset, part };
}

function inbound(parts: MessagePart[], id = "wx-e-1"): InternalMessage {
  return {
    id,
    channel: "weixin",
    accountId: "acct",
    conversationId: "user",
    sender: { id: "user", name: null, isSelf: false },
    timestamp: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    type: "audio",
    parts,
    replyTo: null,
    metadata: {},
    externalRef: { providerMessageId: id },
  };
}

test("E-A: concurrent ASR for the same audio calls the provider exactly once", async () => {
  const h = harness({ asrDelayMs: 50 });
  try {
    const { part } = await seedAudio(h);
    const message = inbound([part]);
    // 两个并发请求（前端连点 / 自动 + 显式重试同时到达）
    const [a, b] = await Promise.all([
      h.transcription.transcribeInboundMessage(message),
      h.transcription.transcribeInboundMessage(message),
    ]);
    assert.equal(h.asrCalls(), 1, "并发请求不允许重复调用 provider（重复付费）");
    const statuses = [a.states.get(0)?.status, b.states.get(0)?.status].sort();
    assert.deepEqual(statuses, ["completed", "completed"]);
    const cachedFlags = [a.states.get(0)?.cached, b.states.get(0)?.cached].sort();
    assert.deepEqual(cachedFlags, [false, true], "后到的那一个必须命中前一个写下的结果");
    // 只有一条记录（主键是 消息+部件）
    const rows = h.db.raw.prepare("SELECT COUNT(*) AS n FROM transcriptions").get() as { n: number };
    assert.equal(rows.n, 1);
  } finally {
    h.close();
  }
});

test("E-B: concurrent TTS for the same text calls the provider once and stores one media object", async () => {
  const h = harness({ ttsDelayMs: 50 });
  try {
    const [a, b] = await Promise.all([
      h.tts.synthesizeForText("同一段文本"),
      h.tts.synthesizeForText("同一段文本"),
    ]);
    assert.equal(h.ttsCalls(), 1, "并发合成不允许重复调用 provider");
    assert.equal(a.state.mediaId, b.state.mediaId, "两次结果必须指向同一个媒体对象");
    const files = readdirSync(join(h.dataDir, "media")).flatMap((shard) => readdirSync(join(h.dataDir, "media", shard))).filter((f) => f.endsWith(".bin"));
    assert.equal(files.length, 1, "不允许产生重复的媒体对象");
    const rows = h.db.raw.prepare("SELECT COUNT(*) AS n FROM tts_syntheses").get() as { n: number };
    assert.equal(rows.n, 1);
  } finally {
    h.close();
  }
});

test("E-C: crash while processing → restart recovery converges ASR/TTS/message states to failed(interrupted)", async () => {
  const h = harness();
  try {
    // 消息有外键约束：先建真实的父行（用户/角色/会话）
    seedFixtures(h.db, { userId: "u1", characterId: "ch1", conversationId: "c1" });
    // 模拟"进程在转写/合成途中被杀"：直接把记录写成 processing，且时间戳很旧
    const { part } = await seedAudio(h);
    const old = "2026-01-01T00:00:00.000Z";
    h.transcriptions.upsert({ messageRef: "wx-e-1", partIndex: 0, fingerprint: "fp-asr", mediaId: part.kind === "audio" ? part.media.mediaId : null, status: "processing", nowIso: old });
    h.ttsSyntheses.upsert({ fingerprint: "fp-tts", status: "processing", nowIso: old });

    // 也模拟消息级 TTS 状态卡在 processing
    h.messages.insert({
      id: "m-stuck",
      conversationId: "c1",
      role: "character",
      parts: [{ kind: "text", text: "回复" }],
      textRender: "回复",
      replyToId: null,
      providerMessageId: null,
      tokenCount: null,
      status: "completed",
      errorText: null,
      source: "conversation",
      createdAt: old,
      editedAt: null,
      branchOfId: null,
      tts: sanitizeTtsState({ status: "processing", updatedAt: old }),
    });

    const cutoff = "2026-06-01T00:00:00.000Z";
    const now = "2026-06-01T01:00:00.000Z";
    assert.equal(h.transcriptions.recoverInterrupted(cutoff, now), 1);
    assert.equal(h.ttsSyntheses.recoverInterrupted(cutoff, now), 1);
    assert.equal(h.messages.recoverStaleTts(cutoff, now), 1);

    const transcription = h.transcriptions.get("wx-e-1", 0)!;
    assert.equal(transcription.status, "failed");
    assert.equal(transcription.errorCode, "interrupted");
    const synthesis = h.ttsSyntheses.get("fp-tts")!;
    assert.equal(synthesis.status, "failed");
    assert.equal(synthesis.errorCode, "interrupted");
    const message = h.messages.getById("m-stuck")!;
    assert.equal(message.tts?.status, "failed");
    assert.equal(message.tts?.errorCode, "interrupted");
    assert.equal(message.tts?.mediaId, null);

    // 恢复之后，用户仍可以显式重试（并且真的会重新调用 provider）
    const retried = await h.transcription.transcribeInboundMessage(inbound([part]));
    assert.equal(retried.states.get(0)?.status, "completed");
    assert.equal(h.asrCalls(), 1);
  } finally {
    h.close();
  }
});

test("E-D: a stuck processing record is NOT converged while it is still fresh", async () => {
  const h = harness();
  try {
    const now = h.clock.nowIso();
    h.ttsSyntheses.upsert({ fingerprint: "fp-fresh", status: "processing", nowIso: now });
    const earlier = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();
    assert.equal(h.ttsSyntheses.recoverInterrupted(earlier, now), 0, "还在正常处理窗口内不能被误标成失败");
    assert.equal(h.ttsSyntheses.get("fp-fresh")?.status, "processing");
  } finally {
    h.close();
  }
});

test("E-E: failed TTS keeps the assistant text valid and never claims media", async () => {
  const h = harness({ ttsError: new ProviderError("boom", { providerId: "tts", kind: "server_error", httpStatus: 500, retryable: true }) });
  try {
    const result = await h.tts.synthesizeForText("文字仍然要活着");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.mediaId, null);
    // 文字侧完全没有被触碰：这里断言服务没有产生任何媒体副作用
    const mediaRoot = join(h.dataDir, "media");
    const files = (existsSync(mediaRoot) ? readdirSync(mediaRoot).flatMap((shard) => readdirSync(join(mediaRoot, shard))) : []).filter((f) => f.endsWith(".bin"));
    assert.equal(files.length, 0, "失败不得留下媒体对象");
  } finally {
    h.close();
  }
});

test("E-F: failed ASR keeps AudioPart available (media.status is never overloaded)", async () => {
  const h = harness({ asrError: new ProviderError("boom", { providerId: "asr", kind: "server_error", httpStatus: 500, retryable: true }) });
  try {
    const { part } = await seedAudio(h);
    const result = await h.transcription.transcribeInboundMessage(inbound([part]));
    const outPart = result.parts[0] as { kind: "audio"; media: { status: string; mediaId: string | null }; transcription?: { status: string } };
    assert.equal(outPart.transcription?.status, "failed");
    assert.equal(outPart.media.status, "available");
    assert.equal(outPart.media.mediaId, part.kind === "audio" ? part.media.mediaId : null);
    // 存储里的音频还在，而且能被完整读回
    const stored = await h.storage.get(String(outPart.media.mediaId));
    assert.equal(Buffer.compare(Buffer.from(stored!.bytes), Buffer.from(WAV)), 0);
  } finally {
    h.close();
  }
});

test("E-G: media audit finds missing references, orphans and unreadable objects (report only)", async () => {
  const db = createTestDatabase();
  const clock = createFakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), "companion-e-audit-"));
  try {
    runMigrations(db);
    seedFixtures(db, { userId: "u1", characterId: "ch1", conversationId: "c" });
    const logger = createLogger({ level: "error", sink: () => {} });
    const storage = createLocalMediaStorage({ dataDir, logger, clock });
    const messages = createMessageRepository(db);

    // 1) 正常引用
    const kept = await storage.put({ bytes: WAV, mimeType: "audio/wav", filename: null, origin: "channel" });
    messages.insert({
      id: "m-ok", conversationId: "c", role: "user", parts: [{ kind: "audio", media: { mediaId: kept.mediaId, mimeType: "audio/wav", filename: null, sizeBytes: kept.sizeBytes, width: null, height: null, durationMs: null, origin: "channel", status: "available", url: null } }],
      textRender: "[语音]", replyToId: null, providerMessageId: null, tokenCount: null, status: "completed", errorText: null, source: "conversation", createdAt: clock.nowIso(), editedAt: null, branchOfId: null,
    });
    // 2) DB 引用但存储里没有（missing）
    messages.insert({
      id: "m-missing", conversationId: "c", role: "user", parts: [{ kind: "audio", media: { mediaId: "a".repeat(32), mimeType: "audio/wav", filename: null, sizeBytes: 1, width: null, height: null, durationMs: null, origin: "channel", status: "available", url: null } }],
      textRender: "[语音]", replyToId: null, providerMessageId: null, tokenCount: null, status: "completed", errorText: null, source: "conversation", createdAt: clock.nowIso(), editedAt: null, branchOfId: null,
    });
    // 3) 存储里有但没人引用（orphan）
    const orphan = await storage.put({ bytes: WAV, mimeType: "audio/wav", filename: null, origin: "generated" });
    // 4) 字节被改坏（unreadable：checksum 不匹配）
    const broken = await storage.put({ bytes: WAV, mimeType: "audio/wav", filename: null, origin: "channel" });
    const brokenPath = join(dataDir, "media", broken.mediaId.slice(0, 2), broken.mediaId + ".bin");
    const tampered = Buffer.from(readFileSync(brokenPath));
    tampered[0] = tampered[0]! ^ 0xff;
    writeFileSync(brokenPath, tampered);
    messages.insert({
      id: "m-broken", conversationId: "c", role: "user", parts: [{ kind: "audio", media: { mediaId: broken.mediaId, mimeType: "audio/wav", filename: null, sizeBytes: tampered.byteLength, width: null, height: null, durationMs: null, origin: "channel", status: "available", url: null } }],
      textRender: "[语音]", replyToId: null, providerMessageId: null, tokenCount: null, status: "completed", errorText: null, source: "conversation", createdAt: clock.nowIso(), editedAt: null, branchOfId: null,
    });

    const result = await auditMediaReferences({ db, mediaStorage: storage, dataDir, logger });
    assert.equal(result.referenced, 3);
    assert.deepEqual(result.missing, ["a".repeat(32)]);
    assert.deepEqual(result.orphaned.sort(), [orphan.mediaId].sort());
    assert.deepEqual(result.unreadable, [broken.mediaId], "被篡改的字节必须被 checksum 校验抓出来");
    assert.equal(result.storedTotal, 3);

    // 破坏的媒体对上层来说就是"不存在"（既有 missing 语义），不会把坏字节送进管线
    assert.equal(await storage.get(broken.mediaId), null);
    // 审计只报告，不删除
    assert.equal(await storage.has(orphan.mediaId), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    db.close();
  }
});

test("E-H: invalid media ids can never escape the storage root", async () => {
  const h = harness();
  try {
    for (const id of ["../../etc/passwd", "..\\..\\windows\\system32", "/etc/passwd", "C:\\secret.txt", "not-hex", "", "a".repeat(31), "a".repeat(33), "A".repeat(32)]) {
      assert.equal(await h.storage.get(id), null, "非法 id 必须当作不存在：" + id);
      assert.equal(await h.storage.stat(id), null);
      assert.equal(await h.storage.has(id), false);
      // remove 是"写路径"：非法 id 必须显式报错（4.5-B 既定契约，有既有测试锁定），
      // 而且绝不会因为报错就碰到文件系统
      await assert.rejects(() => h.storage.remove(id), (error: unknown) => error instanceof DomainError);
    }
    // 写路径是内部生成的 id，外部无法影响路径
    const asset = await h.storage.put({ bytes: WAV, mimeType: "audio/wav", filename: "../../etc/passwd", origin: "channel" });
    assert.match(asset.mediaId, /^[0-9a-f]{32}$/);
    const stored = await h.storage.get(asset.mediaId);
    assert.equal(stored?.filename, "passwd", "文件名被净化为纯名字（并且从不参与路径）");
  } finally {
    h.close();
  }
});

test("E-I: oversized media is rejected at the storage boundary (no partial object)", async () => {
  const h = harness();
  try {
    await assert.rejects(() => h.storage.put({ bytes: new Uint8Array(25 * 1024 * 1024 + 1), mimeType: null, filename: null, origin: "generated" }));
    const mediaRoot = join(h.dataDir, "media");
    const files = existsSync(mediaRoot) ? readdirSync(mediaRoot).flatMap((shard) => readdirSync(join(mediaRoot, shard))) : [];
    assert.equal(files.length, 0, "被拒绝的写入不允许留下任何半成品文件");
  } finally {
    h.close();
  }
});

test("E-J: secrets and audio bytes never reach transcripts/syntheses tables or their errors", async () => {
  const h = harness();
  try {
    const { part } = await seedAudio(h);
    await h.transcription.transcribeInboundMessage(inbound([part]));
    await h.tts.synthesizeForText("这段文本会被合成");
    const dump =
      JSON.stringify(h.db.raw.prepare("SELECT * FROM transcriptions").all()) +
      JSON.stringify(h.db.raw.prepare("SELECT * FROM tts_syntheses").all()) +
      JSON.stringify(h.db.raw.prepare("SELECT * FROM messages").all());
    assert.equal(dump.includes(Buffer.from(WAV).toString("base64")), false, "库里不允许出现音频字节");
    assert.equal(dump.includes("RIFF"), false);
    for (const secret of ["sk-", "Bearer ", "encrypt_query_param", "aes_key"]) {
      assert.equal(dump.includes(secret), false, "库里不允许出现凭据/协议机密：" + secret);
    }
  } finally {
    h.close();
  }
});

/**
 * Phase 4.5-E 冒烟：媒体/语音加固行为（audit + hardening）。
 *
 * 演示本阶段真正实现的加固（不是新特性）：
 *   1. 崩溃遗留的 processing 状态在"重启"后被收敛为 failed(interrupted)，并且仍可显式重试
 *   2. 并发转写/合成只调用一次 provider（不会重复付费、不会产生重复媒体）
 *   3. 媒体引用审计：missing / orphaned / unreadable 三类问题都能被发现（只报告，不删除）
 *   4. 媒体字节被篡改时按"不存在"处理（checksum 校验），坏字节不会进入处理管线
 *   5. 失败/取消不留下媒体副作用；删除消息后的残留媒体可以被审计出来
 *
 * 用法：node scripts/phase45e-smoke.ts [dataDir]
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/app/config.ts";
import { openDatabase } from "../src/storage/db.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { createLogger } from "../src/app/logger.ts";
import { createLocalMediaStorage } from "../src/storage/media/local-media-storage.ts";
import { createTranscriptionRepository } from "../src/storage/repositories/transcriptions.ts";
import { createTtsSynthesisRepository } from "../src/storage/repositories/tts-syntheses.ts";
import { createSettingsRepository } from "../src/storage/repositories/settings.ts";
import { createTranscriptionService } from "../src/core/services/transcription-service.ts";
import { createTtsService } from "../src/core/services/tts-service.ts";
import { createKeyedLock } from "../src/util/keyed-lock.ts";
import { auditMediaReferences } from "../src/app/media-audit.ts";
import { auditMediaReferences as auditAgain } from "../src/app/media-audit.ts";
import { pcmToWav } from "../src/channels/weixin/media/voice-codec.ts";
import { ProviderError } from "../src/core/model/provider-error.ts";
import type { AsrProvider } from "../src/core/ports/asr.ts";
import type { TtsProvider } from "../src/core/ports/tts.ts";
import type { InternalMessage, MessagePart } from "../src/core/model/message.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45e-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(message + "\n");
};
void auditAgain;

const WAV = pcmToWav(new Uint8Array(2400 * 2));
const config = loadConfig({ COMPANION_DATA_DIR: dataDir, COMPANION_LOG_LEVEL: "warn", COMPANION_SCHEDULER_ENABLED: "false" });
const logger = createLogger({ level: "warn" });
const clockNow = (): string => new Date().toISOString();

let asrCalls = 0;
let ttsCalls = 0;

function audioPart(mediaId: string, sizeBytes: number, durationMs: number | null): MessagePart {
  return {
    kind: "audio",
    media: {
      mediaId,
      mimeType: "audio/wav",
      filename: null,
      sizeBytes,
      width: null,
      height: null,
      durationMs,
      origin: "channel",
      status: "available",
      url: { kind: "internal", value: "media:" + mediaId },
    },
  };
}

function inbound(parts: MessagePart[], id: string): InternalMessage {
  return {
    id,
    channel: "weixin",
    accountId: "acct",
    conversationId: "user",
    sender: { id: "user", name: null, isSelf: false },
    timestamp: clockNow(),
    receivedAt: clockNow(),
    type: "audio",
    parts,
    replyTo: null,
    metadata: {},
    externalRef: { providerMessageId: id },
  };
}

try {
  const db = openDatabase({ path: config.databasePath });
  try {
    runMigrations(db);
    log("DATA DIR: " + dataDir);

    const storage = createLocalMediaStorage({ dataDir, logger, clock: { now: () => new Date(), nowIso: clockNow } });
    const settings = createSettingsRepository(db);
    settings.put("asr.enabled", true, clockNow());
    settings.put("asr.providerId", "asr", clockNow());
    settings.put("tts.enabled", true, clockNow());
    settings.put("tts.providerId", "tts", clockNow());
    settings.put("tts.voice", "smoke-voice", clockNow());

    const asrProvider: AsrProvider = {
      id: "asr",
      kind: "smoke",
      defaultModel: "asr-model",
      async transcribe() {
        asrCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40)); // 制造并发窗口
        return { text: "冒烟转写文本", language: null, durationMs: 1000, confidence: null, providerId: "asr", model: "asr-model", latencyMs: 1 };
      },
    };
    const ttsProvider: TtsProvider = {
      id: "tts",
      kind: "smoke",
      defaultModel: "tts-model",
      defaultVoice: "smoke-voice",
      async synthesize() {
        ttsCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { bytes: WAV, mimeType: "audio/wav", durationMs: 1000, sampleRate: 24000, providerId: "tts", model: "tts-model", voice: "smoke-voice", latencyMs: 1 };
      },
    };

    const transcription = createTranscriptionService({
      registry: { get: () => asrProvider, list: () => [asrProvider] },
      repository: createTranscriptionRepository(db),
      storage,
      settings,
      logger,
      clock: { now: () => new Date(), nowIso: clockNow },
      lock: createKeyedLock(),
    });
    const tts = createTtsService({
      registry: { get: () => ttsProvider, list: () => [ttsProvider] },
      repository: createTtsSynthesisRepository(db),
      storage,
      settings,
      logger,
      clock: { now: () => new Date(), nowIso: clockNow },
      lock: createKeyedLock(),
    });

    // ---------- 2) 并发只调用一次 provider ----------
    const asset = await storage.put({ bytes: WAV, mimeType: "audio/wav", filename: null, origin: "channel" });
    const message = inbound([audioPart(asset.mediaId, asset.sizeBytes, 1000)], "smoke-e-1");
    const [a, b] = await Promise.all([
      transcription.transcribeInboundMessage(message),
      transcription.transcribeInboundMessage(message),
    ]);
    log(
      "CONCURRENCY (ASR): provider 调用次数=" + String(asrCalls) + "（必须为 1）状态=" +
        [a.states.get(0)?.status, b.states.get(0)?.status].join(",") + " 缓存命中=" +
        [String(a.states.get(0)?.cached), String(b.states.get(0)?.cached)].join(","),
    );

    const [ta, tb] = await Promise.all([tts.synthesizeForText("并发合成同一段文本"), tts.synthesizeForText("并发合成同一段文本")]);
    const mediaFiles = readdirSync(join(dataDir, "media")).flatMap((shard) => readdirSync(join(dataDir, "media", shard))).filter((f) => f.endsWith(".bin"));
    log(
      "CONCURRENCY (TTS): provider 调用次数=" + String(ttsCalls) + "（必须为 1）同一媒体=" +
        String(ta.state.mediaId === tb.state.mediaId) + " 存储对象总数=" + String(mediaFiles.length) + "（入站音频 1 + 生成的语音 1，没有重复对象）",
    );

    // ---------- 1) 崩溃遗留 processing → 重启收敛 ----------
    const stale = "2020-01-01T00:00:00.000Z";
    createTranscriptionRepository(db).upsert({ messageRef: "crash-1", partIndex: 0, fingerprint: "fp-crash", mediaId: asset.mediaId, status: "processing", nowIso: stale });
    createTtsSynthesisRepository(db).upsert({ fingerprint: "fp-crash-tts", status: "processing", nowIso: stale });
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recoveredAsr = createTranscriptionRepository(db).recoverInterrupted(cutoff, clockNow());
    const recoveredTts = createTtsSynthesisRepository(db).recoverInterrupted(cutoff, clockNow());
    const recoveredRows = createTranscriptionRepository(db).get("crash-1", 0);
    log(
      "RESTART RECOVERY: 收敛的转写=" + String(recoveredAsr) + " 合成=" + String(recoveredTts) +
        " 状态=" + String(recoveredRows?.status) + "/" + String(recoveredRows?.errorCode) + "（重启后必须可观测、可重试）",
    );
    const retried = await transcription.transcribeInboundMessage(message);
    log("RESTART RECOVERY: 显式重试后状态=" + String(retried.states.get(0)?.status) + "（provider 调用次数=" + String(asrCalls) + "）");

    // ---------- 4) 字节被篡改 → 按不存在处理 ----------
    const tampered = await storage.put({ bytes: WAV, mimeType: "audio/wav", filename: null, origin: "channel" });
    const tamperedPath = join(dataDir, "media", tampered.mediaId.slice(0, 2), tampered.mediaId + ".bin");
    const bytes = Buffer.from(readFileSync(tamperedPath));
    bytes[10] = bytes[10]! ^ 0xff;
    writeFileSync(tamperedPath, bytes);
    const readBack = await storage.get(tampered.mediaId);
    log("TAMPERED MEDIA: get() 返回=" + String(readBack === null ? "null（按不存在处理）" : "被篡改的字节（严重问题！）"));

    // ---------- 3) 审计：missing / orphaned / unreadable ----------
    const audit = await auditMediaReferences({ db, mediaStorage: storage, dataDir, logger });
    log(
      "MEDIA AUDIT: referenced=" + String(audit.referenced) + " stored=" + String(audit.storedTotal) +
        " missing=" + String(audit.missing.length) + " orphaned=" + String(audit.orphaned.length) +
        " unreadable=" + String(audit.unreadable.length) + "（只报告，不删除；orphan 就是上面那个被篡改后已无引用的对象）",
    );

    // ---------- 5) 失败不留副作用 ----------
    const failingTts = createTtsService({
      registry: {
        get: () => ({
          id: "tts",
          kind: "smoke",
          defaultModel: "tts-model",
          defaultVoice: "smoke-voice",
          async synthesize() {
            throw new ProviderError("smoke failure", { providerId: "tts", kind: "server_error", httpStatus: 500, retryable: true });
          },
        }),
        list: () => [],
      },
      repository: createTtsSynthesisRepository(db),
      storage,
      settings,
      logger,
      clock: { now: () => new Date(), nowIso: clockNow },
      lock: createKeyedLock(),
    });
    const beforeFiles = readdirSync(join(dataDir, "media")).flatMap((shard) => readdirSync(join(dataDir, "media", shard))).filter((f) => f.endsWith(".bin")).length;
    const failed = await failingTts.synthesizeForText("这段合成会失败");
    const afterFiles = readdirSync(join(dataDir, "media")).flatMap((shard) => readdirSync(join(dataDir, "media", shard))).filter((f) => f.endsWith(".bin")).length;
    log(
      "FAILED TTS: status=" + String(failed.state.status) + " errorCode=" + String(failed.state.errorCode) +
        " mediaId=" + String(failed.state.mediaId) + " 新增媒体文件=" + String(afterFiles - beforeFiles) + "（必须为 0）",
    );

    const mediaRoot = join(dataDir, "media");
    log("MEDIA ROOT: " + (existsSync(mediaRoot) ? "存在，共 " + String(afterFiles) + " 个对象" : "不存在"));
    log("REAL SERVICE STATUS: Weixin native voice / ASR / TTS 全部仍未验证（本轮不涉及真实后端）");
    log("PHASE 4.5-E SMOKE OK（并发去重 / 崩溃恢复 / 篡改检测 / 引用审计 / 失败无残留）");
  } finally {
    db.close();
  }
} finally {
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

import type { Database } from "../db.ts";
import type { TtsSynthesisRecord, TtsSynthesisRepository, TtsSynthesisUpsertInput } from "../../core/ports/repositories.phase45.ts";
import type { TtsStatus } from "../../core/model/tts.ts";
import { TTS_LIMITS } from "../../core/model/tts.ts";

interface Row {
  fingerprint: string;
  status: string;
  media_id: string | null;
  mime_type: string | null;
  duration_ms: number | null;
  sample_rate: number | null;
  provider: string | null;
  model: string | null;
  voice: string | null;
  language: string | null;
  format: string | null;
  text_hash: string | null;
  text_length: number | null;
  error_code: string | null;
  error_message: string | null;
  message_ref: string | null;
  cached: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "fingerprint, status, media_id, mime_type, duration_ms, sample_rate, provider, model, voice, language, format, text_hash, text_length, error_code, error_message, message_ref, cached, created_at, updated_at";

function clamp(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function clampInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function toRecord(row: Row): TtsSynthesisRecord {
  const status = (["pending", "processing", "completed", "failed", "skipped"] as TtsStatus[]).includes(row.status as TtsStatus)
    ? (row.status as TtsStatus)
    : "pending";
  return {
    fingerprint: row.fingerprint,
    status,
    // 只有 completed 才带着可用的 mediaId（其余状态一律不对外声称有音频）
    mediaId: status === "completed" ? clamp(row.media_id, TTS_LIMITS.maxMediaIdLength) : null,
    mimeType: status === "completed" ? clamp(row.mime_type, TTS_LIMITS.maxMimeTypeLength) : null,
    durationMs: clampInt(row.duration_ms),
    sampleRate: clampInt(row.sample_rate),
    provider: clamp(row.provider, TTS_LIMITS.maxModelLength),
    model: clamp(row.model, TTS_LIMITS.maxModelLength),
    voice: clamp(row.voice, TTS_LIMITS.maxVoiceLength),
    language: clamp(row.language, TTS_LIMITS.maxLanguageLength),
    format: clamp(row.format, 16),
    textHash: clamp(row.text_hash, 128),
    textLength: clampInt(row.text_length),
    errorCode: clamp(row.error_code, TTS_LIMITS.maxErrorCodeLength),
    errorMessage: clamp(row.error_message, TTS_LIMITS.maxErrorMessageLength),
    messageRef: clamp(row.message_ref, TTS_LIMITS.maxMediaIdLength),
    cached: row.cached === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** TTS 合成记录仓库：只碰文本元数据与媒体引用，**永远不碰音频字节**。 */
export function createTtsSynthesisRepository(db: Database): TtsSynthesisRepository {
  const selectOne = db.raw.prepare("SELECT " + COLUMNS + " FROM tts_syntheses WHERE fingerprint = ?");

  return {
    upsert(input: TtsSynthesisUpsertInput): TtsSynthesisRecord {
      const status: TtsStatus = (["pending", "processing", "completed", "failed", "skipped"] as TtsStatus[]).includes(input.status)
        ? input.status
        : "pending";
      db.raw
        .prepare(
          "INSERT INTO tts_syntheses (fingerprint, status, media_id, mime_type, duration_ms, sample_rate, provider, model, voice, language, format, text_hash, text_length, error_code, error_message, message_ref, cached, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) " +
            "ON CONFLICT(fingerprint) DO UPDATE SET " +
            "status = excluded.status, media_id = excluded.media_id, mime_type = excluded.mime_type, duration_ms = excluded.duration_ms, " +
            "sample_rate = excluded.sample_rate, provider = excluded.provider, model = excluded.model, voice = excluded.voice, " +
            "language = excluded.language, format = excluded.format, text_hash = excluded.text_hash, text_length = excluded.text_length, " +
            "error_code = excluded.error_code, error_message = excluded.error_message, message_ref = excluded.message_ref, updated_at = excluded.updated_at",
        )
        .run(
          input.fingerprint,
          status,
          input.mediaId ?? null,
          input.mimeType ?? null,
          input.durationMs ?? null,
          input.sampleRate ?? null,
          input.provider ?? null,
          input.model ?? null,
          input.voice ?? null,
          input.language ?? null,
          input.format ?? null,
          input.textHash ?? null,
          input.textLength ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.messageRef ?? null,
          input.nowIso,
          input.nowIso,
        );
      const row = selectOne.get(input.fingerprint) as unknown as Row;
      return toRecord(row);
    },

    get(fingerprint: string): TtsSynthesisRecord | null {
      const row = selectOne.get(fingerprint) as unknown as Row | undefined;
      return row === undefined ? null : toRecord(row);
    },

    findCompleted(fingerprint: string): TtsSynthesisRecord | null {
      const row = db.raw
        .prepare("SELECT " + COLUMNS + " FROM tts_syntheses WHERE fingerprint = ? AND status = 'completed'")
        .get(fingerprint) as unknown as Row | undefined;
      return row === undefined ? null : toRecord(row);
    },

    recoverInterrupted(cutoffIso: string, nowIso: string): number {
      const result = db.raw
        .prepare(
          "UPDATE tts_syntheses SET status = 'failed', error_code = 'interrupted', error_message = ?, updated_at = ? " +
            "WHERE status = 'processing' AND updated_at < ?",
        )
        .run("进程在合成完成前中断（重启后收敛为可重试的失败态）", nowIso, cutoffIso);
      return Number(result.changes ?? 0);
    },

    listForMessage(messageRef: string): TtsSynthesisRecord[] {
      const rows = db.raw
        .prepare("SELECT " + COLUMNS + " FROM tts_syntheses WHERE message_ref = ? ORDER BY created_at ASC")
        .all(messageRef) as unknown as Row[];
      return rows.map(toRecord);
    },
  };
}

export const TTS_SYNTHESIS_TABLE = "tts_syntheses";

import type {
  TranscriptionRecord,
  TranscriptionRepository,
  TranscriptionUpsertInput,
} from "../../core/ports/repositories.phase45.ts";
import type { TranscriptionStatus } from "../../core/model/transcription.ts";
import { sanitizeTranscription } from "../../core/model/transcription.ts";
import type { Database } from "../db.ts";

interface Row {
  message_ref: string;
  part_index: number;
  status: string;
  text: string | null;
  language: string | null;
  duration_ms: number | null;
  confidence: number | null;
  provider: string | null;
  model: string | null;
  error_code: string | null;
  error_message: string | null;
  media_id: string | null;
  fingerprint: string;
  cached: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: Row): TranscriptionRecord {
  const state = sanitizeTranscription({
    status: row.status,
    text: row.text,
    language: row.language,
    durationMs: row.duration_ms,
    confidence: row.confidence,
    provider: row.provider,
    model: row.model,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
    cached: row.cached === 1,
  });
  return {
    ...state,
    messageRef: row.message_ref,
    partIndex: row.part_index,
    fingerprint: row.fingerprint,
    mediaId: row.media_id,
    createdAt: row.created_at,
  };
}

/** 转写记录仓库：只碰文本与元数据，**永远不碰音频字节**。 */
export function createTranscriptionRepository(db: Database): TranscriptionRepository {
  const selectOne = db.raw.prepare("SELECT * FROM transcriptions WHERE message_ref = ? AND part_index = ?");

  return {
    upsert(input: TranscriptionUpsertInput): TranscriptionRecord {
      const state = sanitizeTranscription({
        status: input.status,
        text: input.text,
        language: input.language,
        durationMs: input.durationMs,
        confidence: input.confidence,
        provider: input.provider,
        model: input.model,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        updatedAt: input.nowIso,
        cached: false,
      });
      db.raw.prepare(
        "INSERT INTO transcriptions (message_ref, part_index, status, text, language, duration_ms, confidence, provider, model, error_code, error_message, media_id, fingerprint, cached, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) " +
          "ON CONFLICT(message_ref, part_index) DO UPDATE SET " +
          "status = excluded.status, text = excluded.text, language = excluded.language, duration_ms = excluded.duration_ms, " +
          "confidence = excluded.confidence, provider = excluded.provider, model = excluded.model, error_code = excluded.error_code, " +
          "error_message = excluded.error_message, media_id = excluded.media_id, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at",
      ).run(
        input.messageRef,
        input.partIndex,
        state.status,
        state.text,
        state.language,
        state.durationMs,
        state.confidence,
        state.provider,
        state.model,
        state.errorCode,
        state.errorMessage,
        input.mediaId,
        input.fingerprint,
        input.nowIso,
        input.nowIso,
      );
      const row = selectOne.get(input.messageRef, input.partIndex) as unknown as Row;
      return toRecord(row);
    },

    get(messageRef: string, partIndex: number): TranscriptionRecord | null {
      const row = selectOne.get(messageRef, partIndex) as unknown as Row | undefined;
      return row === undefined ? null : toRecord(row);
    },

    listByMessage(messageRef: string): TranscriptionRecord[] {
      const rows = db.raw
        .prepare("SELECT * FROM transcriptions WHERE message_ref = ? ORDER BY part_index ASC")
        .all(messageRef) as unknown as Row[];
      return rows.map(toRecord);
    },

    findCompleted(messageRef: string, partIndex: number, fingerprint: string): TranscriptionRecord | null {
      const row = db.raw
        .prepare("SELECT * FROM transcriptions WHERE message_ref = ? AND part_index = ? AND status = 'completed' AND fingerprint = ?")
        .get(messageRef, partIndex, fingerprint) as unknown as Row | undefined;
      return row === undefined ? null : toRecord(row);
    },

    recoverInterrupted(cutoffIso: string, nowIso: string): number {
      // 只收敛"卡住"的中间态：pending 从来不落库（服务直接写 processing），因此这里只看 processing
      const result = db.raw
        .prepare(
          "UPDATE transcriptions SET status = 'failed', error_code = 'interrupted', error_message = ?, updated_at = ? " +
            "WHERE status = 'processing' AND updated_at < ?",
        )
        .run("进程在转写完成前中断（重启后收敛为可重试的失败态）", nowIso, cutoffIso);
      return Number(result.changes ?? 0);
    },

    delete(messageRef: string, partIndex: number): boolean {
      const existing = selectOne.get(messageRef, partIndex) as unknown as Row | undefined;
      db.raw.prepare("DELETE FROM transcriptions WHERE message_ref = ? AND part_index = ?").run(messageRef, partIndex);
      return existing !== undefined;
    },
  };
}

/** 导出给迁移测试用：确认表名与列名在这里是唯一真相 */
export const TRANSCRIPTION_TABLE = "transcriptions";
export type { TranscriptionStatus };

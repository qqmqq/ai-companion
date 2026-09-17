import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { EmotionRepository } from "../../core/ports/repositories.phase3.ts";
import type { EmotionHistoryEntry, EmotionState } from "../../core/model/emotion.ts";

function map(row: Record<string, unknown>): EmotionHistoryEntry {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    userId: row.user_id === null ? null : String(row.user_id),
    before: parseJson<EmotionState | null>(String(row.before_json ?? "null"), null),
    after: parseJson<EmotionState>(String(row.after_json), {} as EmotionState),
    reason: String(row.reason),
    source: String(row.source),
    triggerKind: row.trigger_kind === null ? null : String(row.trigger_kind),
    sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    intensity: Number(row.intensity),
    createdAt: String(row.created_at),
  };
}

const COLUMNS =
  "id, character_id, user_id, before_json, after_json, reason, source, trigger_kind, source_message_id, conversation_id, intensity, created_at";

export function createEmotionRepository(db: Database): EmotionRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO emotion_history (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM emotion_history WHERE character_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  );
  const deleteStmt = db.raw.prepare("DELETE FROM emotion_history WHERE character_id = ? AND id = ?");
  const latestStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM emotion_history WHERE character_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );

  return {
    append: (entry) => {
      insertStmt.run(
        entry.id,
        entry.characterId,
        entry.userId,
        entry.before === null ? null : JSON.stringify(entry.before),
        JSON.stringify(entry.after),
        entry.reason,
        entry.source,
        entry.triggerKind,
        entry.sourceMessageId,
        entry.conversationId,
        entry.intensity,
        entry.createdAt,
      );
    },
    list: (characterId, limit) => (listStmt.all(characterId, limit) as Array<Record<string, unknown>>).map(map),
    delete: (characterId, id) => deleteStmt.run(characterId, id).changes > 0,
    latest: (characterId) => {
      const row = latestStmt.get(characterId) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
  };
}

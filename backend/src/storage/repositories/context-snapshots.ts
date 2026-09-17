import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { ContextSnapshotRecord } from "../../core/model/context.ts";
import type { ContextSnapshotRepository } from "../../core/ports/repositories.phase2.ts";

const COLUMNS =
  "id, conversation_id, character_id, message_id, task_type, provider_id, model, total_tokens, budget_tokens, sections_json, memory_ids_json, dropped_json, source, trigger_reason, created_at";

function map(row: Record<string, unknown>): ContextSnapshotRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    characterId: String(row.character_id),
    messageId: String(row.message_id),
    taskType: String(row.task_type),
    providerId: row.provider_id === null ? null : String(row.provider_id),
    model: row.model === null ? null : String(row.model),
    totalTokens: Number(row.total_tokens),
    budgetTokens: Number(row.budget_tokens),
    sections: parseJson<ContextSnapshotRecord["sections"]>(String(row.sections_json), []),
    memoryIds: parseJson<string[]>(String(row.memory_ids_json), []),
    dropped: parseJson<ContextSnapshotRecord["dropped"]>(String(row.dropped_json), []),
    source: String(row.source ?? "conversation"),
    triggerReason: row.trigger_reason === null || row.trigger_reason === undefined ? null : String(row.trigger_reason),
    createdAt: String(row.created_at),
  };
}

export function createContextSnapshotRepository(db: Database): ContextSnapshotRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO context_snapshots (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM context_snapshots WHERE id = ?`);
  const latestForMessageStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM context_snapshots WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`,
  );
  const listStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM context_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
  );
  const countStmt = db.raw.prepare("SELECT COUNT(*) AS n FROM context_snapshots");

  return {
    insert: (snapshot) => {
      insertStmt.run(
        snapshot.id,
        snapshot.conversationId,
        snapshot.characterId,
        snapshot.messageId,
        snapshot.taskType,
        snapshot.providerId,
        snapshot.model,
        snapshot.totalTokens,
        snapshot.budgetTokens,
        JSON.stringify(snapshot.sections),
        JSON.stringify(snapshot.memoryIds),
        JSON.stringify(snapshot.dropped),
        snapshot.source,
        snapshot.triggerReason,
        snapshot.createdAt,
      );
    },
    getById: (id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    latestForMessage: (messageId) => {
      const row = latestForMessageStmt.get(messageId) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    listByConversation: (conversationId, limit) =>
      (listStmt.all(conversationId, limit) as Array<Record<string, unknown>>).map(map),
    count: () => Number((countStmt.get() as { n: number }).n),
  };
}
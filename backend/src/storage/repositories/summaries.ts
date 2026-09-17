import type { Database } from "../db.ts";
import type { SummaryRecord, SummaryRepository } from "../../core/ports/repositories.phase2.ts";

const COLUMNS =
  "id, conversation_id, from_message_id, to_message_id, summary, token_estimate, model, provider_id, created_at";

function map(row: Record<string, unknown>): SummaryRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    fromMessageId: String(row.from_message_id),
    toMessageId: String(row.to_message_id),
    summary: String(row.summary),
    tokenEstimate: row.token_estimate === null ? null : Number(row.token_estimate),
    model: row.model === null ? null : String(row.model),
    providerId: row.provider_id === null ? null : String(row.provider_id),
    createdAt: String(row.created_at),
  };
}

export function createSummaryRepository(db: Database): SummaryRepository {
  const insertStmt = db.raw.prepare(
    `INSERT INTO conversation_summaries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const latestStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM conversation_summaries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`);
  const listStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM conversation_summaries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
  );
  const countStmt = db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id = ?");

  return {
    insert: (summary) => {
      insertStmt.run(
        summary.id,
        summary.conversationId,
        summary.fromMessageId,
        summary.toMessageId,
        summary.summary,
        summary.tokenEstimate,
        summary.model,
        summary.providerId,
        summary.createdAt,
      );
    },
    latest: (conversationId) => {
      const row = latestStmt.get(conversationId) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    list: (conversationId, limit) =>
      (listStmt.all(conversationId, limit) as Array<Record<string, unknown>>).map(map),
    count: (conversationId) => Number((countStmt.get(conversationId) as { n: number }).n),
  };
}

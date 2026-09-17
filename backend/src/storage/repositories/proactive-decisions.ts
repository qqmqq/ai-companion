import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { ProactiveDecisionRepository } from "../../core/ports/repositories.phase3.ts";
import type {
  AutonomyLevel,
  ProactiveBlockedReason,
  ProactiveDecision,
  ProactiveDecisionValue,
} from "../../core/model/proactive.ts";

const COLUMNS =
  "id, user_id, character_id, conversation_id, job_id, trigger_kind, trigger_reason, decision, blocked_reason, autonomy, provider_id, model, message_id, context_snapshot_id, latency_ms, detail_json, created_at";

function map(row: Record<string, unknown>): ProactiveDecision {
  const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: String(row.character_id),
    conversationId: nullable(row.conversation_id),
    jobId: nullable(row.job_id),
    triggerKind: String(row.trigger_kind),
    triggerReason: String(row.trigger_reason),
    decision: String(row.decision) as ProactiveDecisionValue,
    blockedReason: nullable(row.blocked_reason) as ProactiveBlockedReason | null,
    autonomy: nullable(row.autonomy) as AutonomyLevel | null,
    providerId: nullable(row.provider_id),
    model: nullable(row.model),
    messageId: nullable(row.message_id),
    contextSnapshotId: nullable(row.context_snapshot_id),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    detail: parseJson<Record<string, unknown>>(String(row.detail_json), {}),
    createdAt: String(row.created_at),
  };
}

export function createProactiveDecisionRepository(db: Database): ProactiveDecisionRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO proactive_decisions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM proactive_decisions WHERE (? IS NULL OR character_id = ?) AND (? IS NULL OR decision = ?) ORDER BY created_at DESC LIMIT ?`,
  );
  const countSinceStmt = db.raw.prepare(
    "SELECT COUNT(*) AS n FROM proactive_decisions WHERE character_id = ? AND decision = 'sent' AND created_at >= ?",
  );
  const lastSentStmt = db.raw.prepare(
    "SELECT created_at FROM proactive_decisions WHERE character_id = ? AND decision = 'sent' ORDER BY created_at DESC LIMIT 1",
  );

  return {
    insert: (decision) => {
      insertStmt.run(
        decision.id, decision.userId, decision.characterId, decision.conversationId, decision.jobId,
        decision.triggerKind, decision.triggerReason, decision.decision, decision.blockedReason,
        decision.autonomy, decision.providerId, decision.model, decision.messageId,
        decision.contextSnapshotId, decision.latencyMs, JSON.stringify(decision.detail), decision.createdAt,
      );
    },
    list: (filters) =>
      (listStmt.all(
        filters.characterId ?? null, filters.characterId ?? null,
        filters.decision ?? null, filters.decision ?? null,
        filters.limit,
      ) as Array<Record<string, unknown>>).map(map),
    countSince: (characterId, sinceIso) => Number((countSinceStmt.get(characterId, sinceIso) as { n: number }).n),
    lastSentAt: (characterId) => {
      const row = lastSentStmt.get(characterId) as { created_at: string } | undefined;
      return row === undefined ? null : row.created_at;
    },
  };
}

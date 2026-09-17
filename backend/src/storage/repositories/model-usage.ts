import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { ModelUsageInput, ModelUsageRecord } from "../../core/model/usage.ts";
import type { TaskType } from "../../core/model/task.ts";
import type { ModelUsageRepository } from "../../core/ports/repositories.phase2.ts";

const COLUMNS =
  "id, provider_id, model, task_type, conversation_id, message_id, input_tokens, output_tokens, total_tokens, estimated_cost, latency_ms, success, error_kind, created_at";

function map(row: Record<string, unknown>): ModelUsageRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    model: String(row.model),
    taskType: String(row.task_type) as TaskType,
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
    estimatedCost: row.estimated_cost === null ? null : Number(row.estimated_cost),
    latencyMs: Number(row.latency_ms),
    success: Number(row.success) === 1,
    errorKind: row.error_kind === null ? null : String(row.error_kind),
    createdAt: String(row.created_at),
  };
}

export function createModelUsageRepository(db: Database): ModelUsageRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO model_usage (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM model_usage ORDER BY created_at DESC LIMIT ?`);
  const summaryStmt = db.raw.prepare(
    `SELECT task_type,
            COUNT(*) AS calls,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            SUM(estimated_cost) AS cost,
            COALESCE(AVG(latency_ms), 0) AS avg_latency
     FROM model_usage WHERE created_at >= ? GROUP BY task_type ORDER BY calls DESC`,
  );

  return {
    insert: (id, usage: ModelUsageInput, createdAt) => {
      const total =
        usage.inputTokens === null && usage.outputTokens === null
          ? null
          : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      insertStmt.run(
        id,
        usage.providerId,
        usage.model,
        usage.taskType,
        usage.conversationId,
        usage.messageId,
        usage.inputTokens,
        usage.outputTokens,
        total,
        usage.estimatedCost,
        usage.latencyMs,
        usage.success ? 1 : 0,
        usage.errorKind,
        createdAt,
      );
      return {
        id,
        providerId: usage.providerId,
        model: usage.model,
        taskType: usage.taskType,
        conversationId: usage.conversationId,
        messageId: usage.messageId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: total,
        estimatedCost: usage.estimatedCost,
        latencyMs: usage.latencyMs,
        success: usage.success,
        errorKind: usage.errorKind,
        createdAt,
      };
    },
    listRecent: (limit) => (listStmt.all(limit) as Array<Record<string, unknown>>).map(map),
    summary: (sinceIso) =>
      (summaryStmt.all(sinceIso) as Array<Record<string, unknown>>).map((row) => ({
        taskType: String(row.task_type) as TaskType,
        calls: Number(row.calls),
        failures: Number(row.failures),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        estimatedCost: row.cost === null ? null : Number(row.cost),
        avgLatencyMs: Math.round(Number(row.avg_latency)),
      })),
  };
}

export function parseUsageJson(raw: string): ModelUsageInput[] {
  return parseJson<ModelUsageInput[]>(raw, []);
}

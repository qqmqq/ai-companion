import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { ScheduledJobRepository } from "../../core/ports/repositories.phase3.ts";
import type { JobStatus, JobTriggerType, MisfirePolicy, ScheduledJob } from "../../core/model/schedule.ts";

const COLUMNS =
  "id, user_id, character_id, kind, trigger_type, run_at, cron_expr, interval_ms, next_run_at, last_run_at, enabled, status, misfire_policy, payload_json, created_at, updated_at";

function map(row: Record<string, unknown>): ScheduledJob {
  const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: nullable(row.character_id),
    kind: String(row.kind),
    triggerType: String(row.trigger_type) as JobTriggerType,
    runAt: nullable(row.run_at),
    cronExpr: nullable(row.cron_expr),
    intervalMs: row.interval_ms === null || row.interval_ms === undefined ? null : Number(row.interval_ms),
    nextRunAt: String(row.next_run_at),
    lastRunAt: nullable(row.last_run_at),
    enabled: Number(row.enabled) === 1,
    status: String(row.status) as JobStatus,
    misfirePolicy: String(row.misfire_policy) as MisfirePolicy,
    payload: parseJson<Record<string, unknown>>(String(row.payload_json), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createScheduledJobRepository(db: Database): ScheduledJobRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO scheduled_jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE id = ?`);
  // character_id 也必须在更新里：否则"把没有角色的 job 绑到角色上"这类修正永远写不进去
  const updateStmt = db.raw.prepare(
    `UPDATE scheduled_jobs SET character_id = ?, kind = ?, trigger_type = ?, run_at = ?, cron_expr = ?, interval_ms = ?, next_run_at = ?, last_run_at = ?, enabled = ?, status = ?, misfire_policy = ?, payload_json = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteStmt = db.raw.prepare("DELETE FROM scheduled_jobs WHERE id = ?");
  const dueStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM scheduled_jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
  );

  return {
    insert: (job) => {
      insertStmt.run(
        job.id, job.userId, job.characterId, job.kind, job.triggerType, job.runAt, job.cronExpr,
        job.intervalMs, job.nextRunAt, job.lastRunAt, job.enabled ? 1 : 0, job.status,
        job.misfirePolicy, JSON.stringify(job.payload), job.createdAt, job.updatedAt,
      );
    },
    get: (id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    list: (filters = {}) => {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filters.characterId !== undefined && filters.characterId !== null) {
        where.push("character_id = ?");
        params.push(filters.characterId);
      }
      if (filters.enabledOnly === true) where.push("enabled = 1");
      const sql = `SELECT ${COLUMNS} FROM scheduled_jobs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY next_run_at LIMIT ?`;
      return (db.raw.prepare(sql).all(...params, filters.limit ?? 100) as Array<Record<string, unknown>>).map(map);
    },
    update: (job) => {
      updateStmt.run(
        job.characterId, job.kind, job.triggerType, job.runAt, job.cronExpr, job.intervalMs, job.nextRunAt,
        job.lastRunAt, job.enabled ? 1 : 0, job.status, job.misfirePolicy,
        JSON.stringify(job.payload), job.updatedAt, job.id,
      );
    },
    delete: (id) => {
      deleteStmt.run(id);
    },
    listDue: (nowIso, limit) => (dueStmt.all(nowIso, limit) as Array<Record<string, unknown>>).map(map),
  };
}

import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { WorkTaskRepository } from "../../core/ports/repositories.phase3.ts";
import type { WorkTask, WorkTaskKind, WorkTaskStatus } from "../../core/model/work.ts";

const COLUMNS =
  "id, user_id, character_id, kind, status, priority, payload_json, execute_at, attempts, max_attempts, started_at, finished_at, last_error, event_id, job_id, created_at, updated_at";

function map(row: Record<string, unknown>): WorkTask {
  const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: String(row.character_id),
    kind: String(row.kind) as WorkTaskKind,
    status: String(row.status) as WorkTaskStatus,
    priority: Number(row.priority),
    payload: parseJson<Record<string, unknown>>(String(row.payload_json), {}),
    executeAt: String(row.execute_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at),
    lastError: nullable(row.last_error),
    eventId: nullable(row.event_id),
    jobId: nullable(row.job_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createWorkTaskRepository(db: Database): WorkTaskRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO work_tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM work_tasks WHERE id = ?`);
  const updateStmt = db.raw.prepare(
    `UPDATE work_tasks SET kind = ?, status = ?, priority = ?, payload_json = ?, execute_at = ?, attempts = ?, max_attempts = ?, started_at = ?, finished_at = ?, last_error = ?, event_id = ?, job_id = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteStmt = db.raw.prepare("DELETE FROM work_tasks WHERE id = ?");
  const dueStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM work_tasks WHERE status IN ('pending','failed') AND attempts < max_attempts AND execute_at <= ? ORDER BY priority ASC, execute_at ASC LIMIT ?`,
  );

  return {
    insert: (task) => {
      insertStmt.run(
        task.id, task.userId, task.characterId, task.kind, task.status, task.priority,
        JSON.stringify(task.payload), task.executeAt, task.attempts, task.maxAttempts,
        task.startedAt, task.finishedAt, task.lastError, task.eventId, task.jobId,
        task.createdAt, task.updatedAt,
      );
    },
    get: (id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    list: (filters) => {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filters.characterId !== undefined && filters.characterId !== null) {
        where.push("character_id = ?");
        params.push(filters.characterId);
      }
      if (filters.status !== undefined) {
        where.push("status = ?");
        params.push(filters.status);
      }
      const sql = `SELECT ${COLUMNS} FROM work_tasks ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY execute_at DESC LIMIT ?`;
      return (db.raw.prepare(sql).all(...params, filters.limit) as Array<Record<string, unknown>>).map(map);
    },
    update: (task) => {
      updateStmt.run(
        task.kind, task.status, task.priority, JSON.stringify(task.payload), task.executeAt,
        task.attempts, task.maxAttempts, task.startedAt, task.finishedAt, task.lastError,
        task.eventId, task.jobId, task.updatedAt, task.id,
      );
    },
    delete: (id) => {
      deleteStmt.run(id);
    },
    listDue: (nowIso, limit) => (dueStmt.all(nowIso, limit) as Array<Record<string, unknown>>).map(map),
  };
}

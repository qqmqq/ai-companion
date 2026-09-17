import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { EventRepository } from "../../core/ports/repositories.phase3.ts";
import type { CompanionEvent, EventFilters, EventSource, EventStatus, EventType } from "../../core/model/event.ts";

const COLUMNS =
  "id, user_id, character_id, type, title, description, status, importance, occurred_at, scheduled_at, due_at, completed_at, recurrence, source, source_message_id, metadata_json, created_at, updated_at";

function map(row: Record<string, unknown>): CompanionEvent {
  const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: String(row.character_id),
    type: String(row.type) as EventType,
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as EventStatus,
    importance: Number(row.importance),
    occurredAt: nullable(row.occurred_at),
    scheduledAt: nullable(row.scheduled_at),
    dueAt: nullable(row.due_at),
    completedAt: nullable(row.completed_at),
    recurrence: nullable(row.recurrence),
    source: String(row.source) as EventSource,
    sourceMessageId: nullable(row.source_message_id),
    metadata: parseJson<Record<string, unknown>>(String(row.metadata_json), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createEventRepository(db: Database): EventRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM events WHERE id = ?`);
  const updateStmt = db.raw.prepare(
    `UPDATE events SET type = ?, title = ?, description = ?, status = ?, importance = ?, occurred_at = ?, scheduled_at = ?, due_at = ?, completed_at = ?, recurrence = ?, source = ?, source_message_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteStmt = db.raw.prepare("DELETE FROM events WHERE id = ?");
  const pendingStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM events WHERE status IN ('planned','active') AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT ?`,
  );

  return {
    insert: (event) => {
      insertStmt.run(
        event.id,
        event.userId,
        event.characterId,
        event.type,
        event.title,
        event.description,
        event.status,
        event.importance,
        event.occurredAt,
        event.scheduledAt,
        event.dueAt,
        event.completedAt,
        event.recurrence,
        event.source,
        event.sourceMessageId,
        JSON.stringify(event.metadata),
        event.createdAt,
        event.updatedAt,
      );
    },
    get: (id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    list: (filters: EventFilters) => {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filters.userId !== undefined && filters.userId !== null) {
        where.push("user_id = ?");
        params.push(filters.userId);
      }
      if (filters.characterId !== undefined && filters.characterId !== null) {
        where.push("character_id = ?");
        params.push(filters.characterId);
      }
      if (filters.status !== undefined) {
        where.push("status = ?");
        params.push(filters.status);
      }
      if (filters.type !== undefined) {
        where.push("type = ?");
        params.push(filters.type);
      }
      if (filters.dueFrom !== undefined && filters.dueFrom !== null) {
        where.push("due_at IS NOT NULL AND due_at >= ?");
        params.push(filters.dueFrom);
      }
      if (filters.dueTo !== undefined && filters.dueTo !== null) {
        where.push("due_at IS NOT NULL AND due_at <= ?");
        params.push(filters.dueTo);
      }
      const sql = `SELECT ${COLUMNS} FROM events ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(due_at, occurred_at, created_at) DESC LIMIT ?`;
      return (db.raw.prepare(sql).all(...params, filters.limit ?? 100) as Array<Record<string, unknown>>).map(map);
    },
    update: (event) => {
      updateStmt.run(
        event.type,
        event.title,
        event.description,
        event.status,
        event.importance,
        event.occurredAt,
        event.scheduledAt,
        event.dueAt,
        event.completedAt,
        event.recurrence,
        event.source,
        event.sourceMessageId,
        JSON.stringify(event.metadata),
        event.updatedAt,
        event.id,
      );
    },
    delete: (id) => {
      deleteStmt.run(id);
    },
    listPending: (nowIso, limit) => (pendingStmt.all(nowIso, limit) as Array<Record<string, unknown>>).map(map),
  };
}

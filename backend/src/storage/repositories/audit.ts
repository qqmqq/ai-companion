import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { AuditEntry, AuditRepository } from "../../core/ports/repositories.ts";
import { uuidv7 } from "../../util/ids.ts";


export function createAuditRepository(db: Database): AuditRepository {
  const insertStmt = db.raw.prepare(
    "INSERT INTO audit_log (id, actor, action, target_type, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const listStmt = db.raw.prepare(
    "SELECT id, actor, action, target_type, target_id, detail_json, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?",
  );

  return {
    append: (entry) => {
      const record: AuditEntry = {
        id: uuidv7(),
        actor: entry.actor,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        detail: entry.detail,
        createdAt: entry.createdAt ?? new Date().toISOString(),
      };
      insertStmt.run(
        record.id,
        record.actor,
        record.action,
        record.targetType,
        record.targetId,
        JSON.stringify(record.detail),
        record.createdAt,
      );
      return record;
    },
    list: (limit) =>
      (listStmt.all(limit) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        actor: String(row.actor) as AuditEntry["actor"],
        action: String(row.action),
        targetType: String(row.target_type),
        targetId: row.target_id === null ? null : String(row.target_id),
        detail: parseJson<Record<string, unknown>>(String(row.detail_json), {}),
        createdAt: String(row.created_at),
      })),
  };
}

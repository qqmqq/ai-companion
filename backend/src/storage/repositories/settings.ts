import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type { SettingsRepository } from "../../core/ports/repositories.ts";


export function createSettingsRepository(db: Database): SettingsRepository {
  const getStmt = db.raw.prepare("SELECT value_json FROM settings WHERE key = ?");
  const putStmt = db.raw.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  const allStmt = db.raw.prepare("SELECT key, value_json FROM settings");
  const deleteStmt = db.raw.prepare("DELETE FROM settings WHERE key = ?");

  return {
    get: <T,>(key: string, fallback: T): T => {
      const row = getStmt.get(key) as { value_json: string } | undefined;
      if (!row) return fallback;
      return parseJson<T>(row.value_json, fallback);
    },
    put: (key, value, at) => {
      putStmt.run(key, JSON.stringify(value), at);
    },
    all: () => {
      const out: Record<string, unknown> = {};
      for (const row of allStmt.all() as Array<{ key: string; value_json: string }>) {
        out[row.key] = parseJson<unknown>(row.value_json, null);
      }
      return out;
    },
    delete: (key) => {
      deleteStmt.run(key);
    },
  };
}

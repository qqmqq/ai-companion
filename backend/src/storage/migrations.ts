import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./db.ts";

export interface MigrationRecord {
  id: string;
  appliedAt: string;
}

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function ensureMigrationTable(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

export function appliedMigrations(db: Database): MigrationRecord[] {
  ensureMigrationTable(db);
  const rows = db.raw.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all() as Array<{
    id: string;
    applied_at: string;
  }>;
  return rows.map((row) => ({ id: row.id, appliedAt: row.applied_at }));
}

/** 前向迁移：每个文件在独立事务中执行，失败即回滚并中止后续迁移。 */
export function runMigrations(db: Database, dir: string = MIGRATIONS_DIR): string[] {
  ensureMigrationTable(db);
  const applied = new Set(appliedMigrations(db).map((m) => m.id));
  const executed: string[] = [];

  for (const file of listMigrationFiles(dir)) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      db.raw.exec(sql);
      db.raw.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      db.raw.exec("COMMIT");
      executed.push(file);
    } catch (error) {
      try {
        db.raw.exec("ROLLBACK");
      } catch {
        // 保留原始错误
      }
      throw new Error(`migration failed: ${file}: ${(error as Error).message}`, { cause: error });
    }
  }
  return executed;
}

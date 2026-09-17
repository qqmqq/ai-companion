import { openDatabase, type Database } from "../../src/storage/db.ts";
import { runMigrations } from "../../src/storage/migrations.ts";

export function createTestDatabase(): Database {
  const db = openDatabase({ path: ":memory:" });
  runMigrations(db);
  return db;
}

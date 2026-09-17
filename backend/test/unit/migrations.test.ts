import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/storage/db.ts";
import { appliedMigrations, listMigrationFiles, runMigrations } from "../../src/storage/migrations.ts";

test("migrations apply once and are recorded", () => {
  const db = openDatabase({ path: ":memory:" });
  const first = runMigrations(db);
  assert.ok(first.includes("001_init.sql"), "001_init.sql must be applied on a fresh database");
  assert.equal(runMigrations(db).length, 0, "second run must be a no-op");
  assert.deepEqual(
    appliedMigrations(db).map((m) => m.id),
    first,
  );
  db.close();
});

test("migration files are ordered and non-empty", () => {
  const files = listMigrationFiles();
  assert.ok(files.length >= 1);
  assert.deepEqual(files, [...files].sort());
});

test("core Phase 1 tables exist with expected columns", () => {
  const db = openDatabase({ path: ":memory:" });
  runMigrations(db);
  const expected: Record<string, string[]> = {
    users: ["id", "display_name", "timezone"],
    characters: ["id", "user_id", "slug", "current_version_id"],
    character_versions: ["id", "character_id", "definition_json"],
    character_states: ["character_id", "state_json"],
    conversations: ["id", "channel", "conversation_ref", "status"],
    messages: ["id", "conversation_id", "role", "content_json"],
    channels: ["kind", "enabled"],
    channel_accounts: ["id", "channel_kind", "external_account_id"],
    credentials: ["account_id", "ciphertext", "nonce", "tag", "key_ref"],
    settings: ["key", "value_json"],
    audit_log: ["id", "action", "created_at"],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const info = db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const names = info.map((row) => row.name);
    assert.ok(names.length > 0, `table ${table} must exist`);
    for (const column of columns) assert.ok(names.includes(column), `${table}.${column} missing`);
  }
  db.close();
});

test("foreign keys are enforced", () => {
  const db = openDatabase({ path: ":memory:" });
  runMigrations(db);
  assert.throws(
    () =>
      db.raw
        .prepare("INSERT INTO characters (id, user_id, name, slug, current_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("c1", "missing-user", "A", "a", "v1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    /FOREIGN KEY/i,
  );
  db.close();
});

test("deleting a character cascades to versions and states", () => {
  const db = openDatabase({ path: ":memory:" });
  runMigrations(db);
  const now = "2026-01-01T00:00:00.000Z";
  db.raw.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)").run("u1", "U", now);
  db.raw
    .prepare("INSERT INTO characters (id, user_id, name, slug, current_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("c1", "u1", "A", "a", "v1", now, now);
  db.raw
    .prepare("INSERT INTO character_versions (id, character_id, spec_version, definition_json, imported_from, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("v1", "c1", "tavern-v2", "{}", "test", now);
  db.raw.prepare("INSERT INTO character_states (character_id, user_id, state_json, updated_at) VALUES (?, ?, ?, ?)").run("c1", "u1", "{}", now);

  db.raw.prepare("DELETE FROM characters WHERE id = ?").run("c1");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM character_versions").get() as { n: number }).n, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM character_states").get() as { n: number }).n, 0);
  db.close();
});

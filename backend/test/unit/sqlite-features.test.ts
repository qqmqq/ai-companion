import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/storage/db.ts";
import { runMigrations } from "../../src/storage/migrations.ts";
import { buildFtsQuery, segmentText } from "../../src/storage/search/cjk.ts";

test("migration 002 applies and memories_fts works with segmented CJK", () => {
  const db = openDatabase({ path: ":memory:" });
  const applied = runMigrations(db);
  // 不写死清单：后续阶段会继续追加迁移，只要求按序应用
  assert.ok(applied.includes("001_init.sql"));
  assert.ok(applied.includes("002_memory_context_usage.sql"));
  assert.deepEqual(applied, [...applied].sort());

  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO memories (id, scope, type, content, content_hash, importance, confidence, occurred_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run("m1", "user", "preference", "用户喜欢喝手冲咖啡", "h1", 0.8, 0.9, now, now, now);
  const searchText = segmentText("用户喜欢喝手冲咖啡");
  db.raw.prepare("INSERT INTO memories_fts (search_text, memory_id) VALUES (?, ?)").run(searchText, "m1");

  const query = buildFtsQuery("咖啡")!;
  const rows = db.raw.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ?").all(query) as Array<{ memory_id: string }>;
  assert.deepEqual(rows.map((r) => r.memory_id), ["m1"]);

  const multi = buildFtsQuery("咖啡 手冲")!;
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(multi) as { n: number }).n, 1);
  db.close();
});

test("messages gained streaming status columns", () => {
  const db = openDatabase({ path: ":memory:" });
  runMigrations(db);
  const cols = (db.raw.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("status"));
  assert.ok(cols.includes("error_text"));
  db.close();
});
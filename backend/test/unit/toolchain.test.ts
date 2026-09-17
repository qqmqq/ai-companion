import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

test("toolchain: node:test + type stripping + node:sqlite are available", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
  db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("a", 1);
  const row = db.prepare("SELECT n FROM t WHERE id = ?").get("a") as { n: number };
  assert.equal(row.n, 1);
  db.close();
});
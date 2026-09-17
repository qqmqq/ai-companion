import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidv7, randomToken } from "../../src/util/ids.ts";

test("uuidv7 has version/variant bits and is time-ordered", () => {
  const early = uuidv7(1_700_000_000_000);
  const later = uuidv7(1_700_000_001_000);
  assert.match(early, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(early < later, "uuids generated later must sort after earlier ones");
  assert.equal(new Set([early, later, uuidv7()]).size, 3);
});

test("randomToken is url-safe and unique", () => {
  const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]+$/);
});

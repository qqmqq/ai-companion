import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, parseLogLevel } from "../../src/app/logger.ts";

function capture(level: "trace" | "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  return { logger, lines };
}

test("logger writes JSON lines and honours the level filter", () => {
  const { logger, lines } = capture("warn");
  logger.info("hidden");
  logger.warn("visible");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.msg, "visible");
});

test("logger redacts secrets even if the caller passes them raw", () => {
  const { logger, lines } = capture("info");
  logger.info("outbound request", {
    headers: { authorization: "Bearer super-secret-token-value", "content-type": "application/json" },
    note: "token=abcd1234efgh",
  });
  const line = lines[0]!;
  assert.doesNotMatch(line, /super-secret-token-value/);
  assert.doesNotMatch(line, /abcd1234efgh/);
  assert.match(line, /redacted/);
});

test("child logger carries a scoped name", () => {
  const { logger, lines } = capture("info");
  logger.child("channel").info("hello");
  assert.equal((JSON.parse(lines[0]!) as Record<string, unknown>).scope, "app:channel");
});

test("parseLogLevel falls back for unknown values", () => {
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel("nonsense"), "info");
  assert.equal(parseLogLevel(undefined), "info");
});

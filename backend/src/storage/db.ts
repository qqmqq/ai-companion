import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Database {
  readonly raw: DatabaseSync;
  readonly kind: "file" | "memory";
  close(): void;
}

export interface OpenDatabaseOptions {
  path: string;
  /** 测试用：事务包裹每个写操作并保持可回滚 */
  busyTimeoutMs?: number;
}

export function openDatabase(options: OpenDatabaseOptions): Database {
  const isMemory = options.path === ":memory:";
  if (!isMemory) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });

  const raw = new DatabaseSync(options.path);
  // WAL 与 busy_timeout：单进程多连接下的基本并发保障
  if (!isMemory) raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  raw.exec("PRAGMA foreign_keys = ON");

  return {
    raw,
    kind: isMemory ? "memory" : "file",
    close: () => raw.close(),
  };
}

/** 事务：失败回滚后重新抛出，调用方决定如何降级。 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.raw.exec("ROLLBACK");
    } catch {
      // rollback 失败时保留原始错误
    }
    throw error;
  }
}

export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

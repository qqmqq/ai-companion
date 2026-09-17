import type { LogLevel, Logger } from "../core/ports/logger.ts";
import { redactText, redactValue } from "../security/redact.ts";

const LEVELS: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface LoggerOptions {
  level: LogLevel;
  scope?: string;
  sink?: (line: string) => void;
}

/**
 * 结构化 JSON 行日志。
 * 脱敏在 logger 内部强制执行（不依赖调用点自觉），这是与参考实现的关键差异。
 */
export function createLogger(options: LoggerOptions): Logger {
  const min = LEVELS[options.level];
  const scope = options.scope ?? "app";
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < min) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: redactText(message),
    };
    if (fields !== undefined) entry.fields = redactValue(fields);
    sink(JSON.stringify(entry));
  };

  const logger: Logger = {
    trace: (m, f) => emit("trace", m, f),
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (childScope: string) => createLogger({ level: options.level, scope: `${scope}:${childScope}`, sink }),
  };
  return logger;
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const value = (raw ?? "").trim().toLowerCase();
  return value in LEVELS ? (value as LogLevel) : fallback;
}

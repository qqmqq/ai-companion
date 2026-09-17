import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "../core/ports/logger.ts";

const EnvSchema = z.object({
  COMPANION_HOST: z.string().default("127.0.0.1"),
  COMPANION_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  COMPANION_DATA_DIR: z.string().default("./data"),
  COMPANION_KEY_PROVIDER: z.enum(["file", "env"]).default("file"),
  COMPANION_MASTER_KEY: z.string().optional(),
  COMPANION_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  COMPANION_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  COMPANION_SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  keyProvider: { kind: "file" | "env"; masterKey?: string };
  logLevel: LogLevel;
  scheduler: { enabled: boolean; intervalMs: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid environment configuration: ${issues}`);
  }
  const value = parsed.data;
  const dataDir = resolve(value.COMPANION_DATA_DIR);

  if (value.COMPANION_KEY_PROVIDER === "env" && !value.COMPANION_MASTER_KEY) {
    throw new Error("COMPANION_KEY_PROVIDER=env requires COMPANION_MASTER_KEY");
  }

  return {
    host: value.COMPANION_HOST,
    port: value.COMPANION_PORT,
    dataDir,
    databasePath: resolve(dataDir, "companion.db"),
    keyProvider: {
      kind: value.COMPANION_KEY_PROVIDER,
      ...(value.COMPANION_MASTER_KEY === undefined ? {} : { masterKey: value.COMPANION_MASTER_KEY }),
    },
    logLevel: value.COMPANION_LOG_LEVEL,
    scheduler: { enabled: value.COMPANION_SCHEDULER_ENABLED, intervalMs: value.COMPANION_SCHEDULER_INTERVAL_MS },
  };
}
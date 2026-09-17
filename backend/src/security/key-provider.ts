import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKey, parseKey } from "./crypto.ts";

export interface KeyProvider {
  readonly kind: string;
  getMasterKey(): Promise<Buffer>;
}

/** 主密钥存文件（0600）。Phase 1 默认实现；OS keyring 见 Phase 2 计划。 */
export function fileKeyProvider(keyPath: string): KeyProvider {
  return {
    kind: "file",
    async getMasterKey(): Promise<Buffer> {
      if (!existsSync(keyPath)) {
        const key = generateKey();
        mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
        writeFileSync(keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
        try {
          chmodSync(keyPath, 0o600);
        } catch {
          // Windows 上 chmod 语义有限，尽力而为
        }
        return key;
      }
      return parseKey(readFileSync(keyPath, "utf8"));
    },
  };
}

export function envKeyProvider(rawKey: string): KeyProvider {
  return {
    kind: "env",
    async getMasterKey(): Promise<Buffer> {
      return parseKey(rawKey);
    },
  };
}

export function inMemoryKeyProvider(key: Buffer): KeyProvider {
  return {
    kind: "memory",
    async getMasterKey(): Promise<Buffer> {
      return key;
    },
  };
}

export function defaultKeyPath(dataDir: string): string {
  return join(dataDir, "keys", "master.key");
}

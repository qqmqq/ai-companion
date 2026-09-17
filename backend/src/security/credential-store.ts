import type { CredentialRecord, CredentialStore } from "../core/ports/credential-store.ts";
import type { CredentialRepository } from "../storage/repositories/credentials.ts";
import type { KeyProvider } from "./key-provider.ts";
import { openSecret, sealSecret } from "./crypto.ts";

export interface SqliteCredentialStoreDeps {
  repository: CredentialRepository;
  keyProvider: KeyProvider;
  nowIso: () => string;
}

/**
 * 凭据存储：只落密文；日志/审计里只允许出现 accountId 与 updatedAt。
 * 明文只在渠道层内部按需取出，且不得进入 Core 模型或 API DTO。
 */
export function createSqliteCredentialStore(deps: SqliteCredentialStoreDeps): CredentialStore {
  return {
    async putSecret(accountId: string, secret: Record<string, unknown>): Promise<void> {
      const key = await deps.keyProvider.getMasterKey();
      const sealed = sealSecret(JSON.stringify(secret), key, deps.keyProvider.kind);
      deps.repository.put(accountId, sealed, deps.nowIso());
    },
    async getSecret(accountId: string): Promise<Record<string, unknown> | null> {
      const row = deps.repository.get(accountId);
      if (!row) return null;
      const key = await deps.keyProvider.getMasterKey();
      const plaintext = openSecret(row, key);
      try {
        return JSON.parse(plaintext) as Record<string, unknown>;
      } catch {
        throw new Error(`credential payload for ${accountId} is not valid JSON`);
      }
    },
    async hasSecret(accountId: string): Promise<boolean> {
      return deps.repository.has(accountId);
    },
    async deleteSecret(accountId: string): Promise<void> {
      deps.repository.delete(accountId);
    },
    async listAccounts(): Promise<CredentialRecord[]> {
      return deps.repository.list().map((row) => ({ accountId: row.accountId, updatedAt: row.updatedAt }));
    },
  };
}

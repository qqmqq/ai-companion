import type { Database } from "../db.ts";
import type { SealedSecret } from "../../security/crypto.ts";

export interface CredentialRepository {
  put(accountId: string, sealed: SealedSecret, at: string): void;
  get(accountId: string): (SealedSecret & { updatedAt: string }) | null;
  has(accountId: string): boolean;
  delete(accountId: string): void;
  list(): Array<{ accountId: string; updatedAt: string }>;
}

export function createCredentialRepository(db: Database): CredentialRepository {
  const putStmt = db.raw.prepare(
    `INSERT INTO credentials (account_id, ciphertext, nonce, tag, key_ref, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, tag = excluded.tag, key_ref = excluded.key_ref, updated_at = excluded.updated_at`,
  );
  const getStmt = db.raw.prepare(
    "SELECT account_id, ciphertext, nonce, tag, key_ref, updated_at FROM credentials WHERE account_id = ?",
  );
  const hasStmt = db.raw.prepare("SELECT 1 AS present FROM credentials WHERE account_id = ?");
  const deleteStmt = db.raw.prepare("DELETE FROM credentials WHERE account_id = ?");
  const listStmt = db.raw.prepare("SELECT account_id, updated_at FROM credentials ORDER BY updated_at");

  return {
    put: (accountId, sealed, at) => {
      putStmt.run(accountId, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyRef, at);
    },
    get: (accountId) => {
      const row = getStmt.get(accountId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        ciphertext: String(row.ciphertext),
        nonce: String(row.nonce),
        tag: String(row.tag),
        keyRef: String(row.key_ref),
        updatedAt: String(row.updated_at),
      };
    },
    has: (accountId) => hasStmt.get(accountId) !== undefined,
    delete: (accountId) => {
      deleteStmt.run(accountId);
    },
    list: () =>
      (listStmt.all() as Array<{ account_id: string; updated_at: string }>).map((row) => ({
        accountId: row.account_id,
        updatedAt: row.updated_at,
      })),
  };
}

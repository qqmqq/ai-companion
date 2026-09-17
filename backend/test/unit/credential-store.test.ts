import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../helpers/db.ts";
import { createCredentialRepository } from "../../src/storage/repositories/credentials.ts";
import { createSqliteCredentialStore } from "../../src/security/credential-store.ts";
import { generateKey } from "../../src/security/crypto.ts";
import { inMemoryKeyProvider } from "../../src/security/key-provider.ts";
import { nowIso } from "../../src/util/time.ts";

function makeStore() {
  const db = createTestDatabase();
  const repository = createCredentialRepository(db);
  const store = createSqliteCredentialStore({
    repository,
    keyProvider: inMemoryKeyProvider(generateKey()),
    nowIso,
  });
  return { db, repository, store };
}

test("credentials round-trip through the store", async () => {
  const { db, store } = makeStore();
  assert.equal(await store.hasSecret("acc-1"), false);
  await store.putSecret("acc-1", { botToken: "secret-token-value", userId: "u1" });
  assert.equal(await store.hasSecret("acc-1"), true);
  assert.deepEqual(await store.getSecret("acc-1"), { botToken: "secret-token-value", userId: "u1" });
  assert.deepEqual(await store.listAccounts(), [{ accountId: "acc-1", updatedAt: (await store.listAccounts())[0]!.updatedAt }]);
  await store.deleteSecret("acc-1");
  assert.equal(await store.hasSecret("acc-1"), false);
  db.close();
});

test("plaintext never reaches the database row", async () => {
  const { db, repository, store } = makeStore();
  await store.putSecret("acc-1", { botToken: "PLAINTEXT-CANARY-1234" });
  const row = repository.get("acc-1");
  assert.ok(row !== null);
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /PLAINTEXT-CANARY-1234/, "存储层不得出现明文凭据");
  db.close();
});

test("a different master key cannot decrypt the secret", async () => {
  const db = createTestDatabase();
  const repository = createCredentialRepository(db);
  const first = createSqliteCredentialStore({ repository, keyProvider: inMemoryKeyProvider(generateKey()), nowIso });
  await first.putSecret("acc-1", { botToken: "abc" });
  const second = createSqliteCredentialStore({ repository, keyProvider: inMemoryKeyProvider(generateKey()), nowIso });
  await assert.rejects(() => second.getSecret("acc-1"));
  db.close();
});

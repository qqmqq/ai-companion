import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKey, openSecret, parseKey, sealSecret, constantTimeEquals } from "../../src/security/crypto.ts";

test("seal/open round-trips and rejects tampered ciphertext", () => {
  const key = generateKey();
  const sealed = sealSecret("bot-token-abc123", key, "test");
  assert.equal(openSecret(sealed, key), "bot-token-abc123");
  assert.notEqual(sealed.ciphertext, "bot-token-abc123");

  const tampered = { ...sealed, ciphertext: Buffer.from("evil-payload").toString("base64") };
  assert.throws(() => openSecret(tampered, key));

  const otherKey = generateKey();
  assert.throws(() => openSecret(sealed, otherKey));
});

test("nonce differs per seal (no key reuse leak)", () => {
  const key = generateKey();
  const a = sealSecret("same", key);
  const b = sealSecret("same", key);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("parseKey accepts hex and base64, rejects wrong size", () => {
  const key = generateKey();
  assert.deepEqual(parseKey(key.toString("hex")), key);
  assert.deepEqual(parseKey(key.toString("base64")), key);
  assert.throws(() => parseKey("deadbeef"), /32 bytes/);
});

test("constantTimeEquals compares safely", () => {
  assert.equal(constantTimeEquals("abc", "abc"), true);
  assert.equal(constantTimeEquals("abc", "abd"), false);
  assert.equal(constantTimeEquals("abc", "abcd"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactHeaders, redactText, redactToken, redactUrl, redactValue } from "../../src/security/redact.ts";

test("redactValue masks sensitive keys at any depth", () => {
  const out = redactValue({
    headers: { Authorization: "Bearer abcdef123456", "x-trace": "ok" },
    body: { context_token: "ctx-123456", nested: { api_key: "sk-live-999" } },
  }) as Record<string, any>;
  assert.equal(out.headers.Authorization, "«redacted»");
  assert.equal(out.headers["x-trace"], "ok");
  assert.equal(out.body.context_token, "«redacted»");
  assert.equal(out.body.nested.api_key, "«redacted»");
});

test("redactText catches inline credentials even without field names", () => {
  assert.match(redactText("sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"), /redacted/);
  assert.doesNotMatch(redactText("sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"), /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(redactText("api_key=sk-live-abcdef123456"), /redacted/);
});

test("redactUrl drops query string, redactToken keeps prefix only", () => {
  assert.equal(redactUrl("https://api.example.com/v1/x?token=secret&a=1"), "https://api.example.com/v1/x?«redacted»");
  assert.equal(redactToken("abcdef123456"), "abcdef…(len=12)");
  assert.equal(redactToken(null), "(none)");
});

test("redactHeaders never leaks a token value", () => {
  const out = redactHeaders({ authorization: "Bearer 0123456789abcdef", cookie: "sid=xyz" });
  assert.equal(out.authorization, "«redacted»");
  assert.equal(out.cookie, "«redacted»");
});

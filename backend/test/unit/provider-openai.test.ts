import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatibleProvider } from "../../src/providers/llm/openai-compatible.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";
import { createHangingFetch, createMockFetch, jsonResponse, streamResponse, textResponse } from "../helpers/mock-fetch.ts";

const CHAT_URL = "https://api.example.com/v1/chat/completions";

function provider(fetchImpl: typeof fetch, overrides: Partial<{ timeoutMs: number; apiKey: string | null }> = {}) {
  return createOpenAICompatibleProvider({
    id: "oa",
    baseUrl: "https://api.example.com",
    model: "gpt-test",
    apiKey: overrides.apiKey === undefined ? "sk-test-key" : overrides.apiKey,
    timeoutMs: overrides.timeoutMs ?? 5000,
    fetchImpl,
  });
}

test("openai-compatible chat returns text and usage", async () => {
  const mock = createMockFetch([
    {
      match: (url) => url.endsWith("/v1/chat/completions"),
      respond: () =>
        jsonResponse({
          choices: [{ message: { content: "你好呀" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
    },
  ]);
  const response = await provider(mock.fetchImpl).chat({
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(response.text, "你好呀");
  assert.equal(response.usage.promptTokens, 12);
  assert.equal(response.usage.completionTokens, 7);
  assert.equal(mock.calls[0]?.headers.authorization, "Bearer sk-test-key");
  assert.equal((mock.calls[0]?.body as { stream: boolean }).stream, false);
});

test("openai-compatible chat reports null usage when upstream omits it", async () => {
  const mock = createMockFetch([
    { match: () => true, respond: () => jsonResponse({ choices: [{ message: { content: "x" } }] }) },
  ]);
  const response = await provider(mock.fetchImpl).chat({ model: "m", messages: [] });
  assert.equal(response.usage.promptTokens, null);
  assert.equal(response.usage.completionTokens, null);
});

test("openai-compatible streams deltas and stops at [DONE]", async () => {
  const mock = createMockFetch([
    {
      match: () => true,
      respond: () =>
        streamResponse([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    },
  ]);
  const chunks: string[] = [];
  let done = false;
  for await (const chunk of provider(mock.fetchImpl).stream({ model: "m", messages: [] })) {
    if (chunk.done) done = true;
    else chunks.push(chunk.text);
  }
  assert.deepEqual(chunks, ["你", "好"]);
  assert.equal(done, true);
  assert.equal((mock.calls[0]?.body as { stream: boolean }).stream, true);
});

test("openai-compatible surfaces usage from the final stream chunk", async () => {
  const mock = createMockFetch([
    {
      match: () => true,
      respond: () =>
        streamResponse([
          'data: {"choices":[{"delta":{"content":"嗨"}}]}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n',
          "data: [DONE]\n\n",
        ]),
    },
  ]);
  let usage: { promptTokens: number | null; completionTokens: number | null } | null | undefined;
  for await (const chunk of provider(mock.fetchImpl).stream({ model: "m", messages: [] })) {
    if (chunk.done) usage = chunk.usage;
  }
  assert.equal(usage?.promptTokens, 9);
  assert.equal(usage?.completionTokens, 3);
});

test("openai-compatible reports unknown costs as null instead of zero", async () => {
  const mock = createMockFetch([{ match: () => true, respond: () => jsonResponse({ data: [{ id: "mystery-model" }] }) }]);
  const models = await provider(mock.fetchImpl).listModels();
  assert.equal(models[0]?.capabilities.costPer1kInput, null, "未知价格必须是 null，不能假装免费");
});

test("openai-compatible maps upstream errors to ProviderError", async () => {
  const cases: Array<[number, string]> = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [404, "model_unavailable"],
    [500, "server_error"],
    [400, "invalid_response"],
  ];
  for (const [status, kind] of cases) {
    const mock = createMockFetch([{ match: () => true, respond: () => textResponse("boom", status) }]);
    await assert.rejects(
      () => provider(mock.fetchImpl).chat({ model: "m", messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.providerKind, kind, `status ${status} should map to ${kind}`);
        return true;
      },
    );
  }
});

test("openai-compatible times out and aborts distinctly", async () => {
  await assert.rejects(
    () => provider(createHangingFetch("AbortError"), { timeoutMs: 60 }).chat({ model: "m", messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.providerKind, "timeout");
      assert.equal(error.retryable, true);
      return true;
    },
  );

  const controller = new AbortController();
  const pending = provider(createHangingFetch("AbortError"), { timeoutMs: 5000 }).chat({
    model: "m",
    messages: [],
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.providerKind, "aborted");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("openai-compatible rejects invalid JSON and missing content", async () => {
  const badJson = createMockFetch([{ match: () => true, respond: () => textResponse("not-json") }]);
  await assert.rejects(
    () => provider(badJson.fetchImpl).chat({ model: "m", messages: [] }),
    (error: unknown) => error instanceof ProviderError && error.providerKind === "invalid_response",
  );

  const noContent = createMockFetch([{ match: () => true, respond: () => jsonResponse({ choices: [{}] }) }]);
  await assert.rejects(
    () => provider(noContent.fetchImpl).chat({ model: "m", messages: [] }),
    (error: unknown) => error instanceof ProviderError && error.providerKind === "invalid_response",
  );
});

test("openai-compatible omits the auth header for keyless local servers", async () => {
  const mock = createMockFetch([{ match: () => true, respond: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) }]);
  await provider(mock.fetchImpl, { apiKey: null }).chat({ model: "m", messages: [] });
  assert.equal(mock.calls[0]?.headers.authorization, undefined);
});

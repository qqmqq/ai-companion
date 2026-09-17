import { test } from "node:test";
import assert from "node:assert/strict";
import { OLLAMA_DEFAULT_BASE_URL, createOllamaProvider } from "../../src/providers/llm/ollama.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";
import { createMockFetch, jsonResponse, streamResponse, textResponse } from "../helpers/mock-fetch.ts";

test("ollama default base url is the local 11434 endpoint but可配置", async () => {
  const mock = createMockFetch([{ match: () => true, respond: () => jsonResponse({ message: { content: "hi" }, prompt_eval_count: 3, eval_count: 2 }) }]);
  const provider = createOllamaProvider({ id: "ollama", model: "llama3", timeoutMs: 3000, fetchImpl: mock.fetchImpl });
  await provider.chat({ model: "llama3", messages: [{ role: "user", content: "hi" }] });
  assert.equal(mock.calls[0]?.url, `${OLLAMA_DEFAULT_BASE_URL}/api/chat`);

  const custom = createMockFetch([{ match: () => true, respond: () => jsonResponse({ message: { content: "hi" } }) }]);
  const other = createOllamaProvider({
    id: "ollama",
    baseUrl: "http://10.0.0.5:11434",
    model: "llama3",
    timeoutMs: 3000,
    fetchImpl: custom.fetchImpl,
  });
  await other.chat({ model: "llama3", messages: [] });
  assert.equal(custom.calls[0]?.url, "http://10.0.0.5:11434/api/chat");
});

test("ollama chat returns text and usage counters", async () => {
  const mock = createMockFetch([
    { match: () => true, respond: () => jsonResponse({ message: { role: "assistant", content: "早" }, done: true, prompt_eval_count: 11, eval_count: 4 }) },
  ]);
  const response = await createOllamaProvider({ id: "ollama", model: "llama3", timeoutMs: 3000, fetchImpl: mock.fetchImpl }).chat({
    model: "llama3",
    messages: [],
  });
  assert.equal(response.text, "早");
  assert.equal(response.usage.promptTokens, 11);
  assert.equal(response.usage.completionTokens, 4);
});

test("ollama streams NDJSON chunks into deltas", async () => {
  const mock = createMockFetch([
    {
      match: () => true,
      respond: () =>
        streamResponse([
          '{"message":{"content":"你"},"done":false}\n',
          '{"message":{"content":"好"},"done":false}\n',
          '{"done":true,"prompt_eval_count":5,"eval_count":2}\n',
        ]),
    },
  ]);
  const chunks: string[] = [];
  let done = false;
  let usage: { promptTokens: number | null; completionTokens: number | null } | null | undefined;
  for await (const chunk of createOllamaProvider({ id: "ollama", model: "llama3", timeoutMs: 3000, fetchImpl: mock.fetchImpl }).stream({
    model: "llama3",
    messages: [],
  })) {
    if (chunk.done) {
      done = true;
      usage = chunk.usage;
    } else chunks.push(chunk.text);
  }
  assert.deepEqual(chunks, ["你", "好"]);
  assert.equal(done, true);
  assert.equal(usage?.promptTokens, 5, "Ollama 的 done 帧计数必须被记录下来");
  assert.equal(usage?.completionTokens, 2);
});

test("ollama surfaces upstream errors as ProviderError", async () => {
  const mock = createMockFetch([{ match: () => true, respond: () => textResponse("model not found", 404) }]);
  await assert.rejects(
    () => createOllamaProvider({ id: "ollama", model: "nope", timeoutMs: 3000, fetchImpl: mock.fetchImpl }).chat({ model: "nope", messages: [] }),
    (error: unknown) => error instanceof ProviderError && error.providerKind === "model_unavailable",
  );
});

test("ollama reports an in-stream error object", async () => {
  const mock = createMockFetch([
    { match: () => true, respond: () => streamResponse(['{"error":"model runner crashed"}\n']) },
  ]);
  await assert.rejects(async () => {
    for await (const _chunk of createOllamaProvider({ id: "ollama", model: "llama3", timeoutMs: 3000, fetchImpl: mock.fetchImpl }).stream({
      model: "llama3",
      messages: [],
    })) {
      // 只关心抛错
    }
  }, (error: unknown) => error instanceof ProviderError && error.providerKind === "invalid_response");
});

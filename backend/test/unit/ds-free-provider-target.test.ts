import assert from "node:assert/strict";
import { test } from "node:test";
import { DS_FREE_PROVIDER_ID, pickProviderTarget } from "../../src/integrations/ds-free/service.ts";

const PROXY = "http://127.0.0.1:22217";

test("已经有指向同一个反代的 provider 就复用它（先手动加过预设再点一键写入不该变成两条）", () => {
  const existing = [
    { id: "echo", kind: "echo", baseUrl: "internal://echo" },
    { id: "openai-compatible-01a0b6c9", kind: "openai-compatible", baseUrl: PROXY },
  ];
  assert.equal(pickProviderTarget(existing, { id: DS_FREE_PROVIDER_ID, baseUrl: PROXY }), "openai-compatible-01a0b6c9");
  // 末尾斜杠不该让人以为是两个地址
  assert.equal(pickProviderTarget(existing, { id: DS_FREE_PROVIDER_ID, baseUrl: PROXY + "/" }), "openai-compatible-01a0b6c9");
});

test("没有同地址的就用我们自己的 id", () => {
  assert.equal(pickProviderTarget([], { id: DS_FREE_PROVIDER_ID, baseUrl: PROXY }), DS_FREE_PROVIDER_ID);
  assert.equal(
    pickProviderTarget([{ id: "openai-compatible-other", kind: "openai-compatible", baseUrl: "https://api.openai.com" }], {
      id: DS_FREE_PROVIDER_ID,
      baseUrl: PROXY,
    }),
    DS_FREE_PROVIDER_ID,
  );
});

test("地址一样但类型不是 OpenAI 兼容的，不去动它", () => {
  const existing = [{ id: "ollama-local", kind: "ollama", baseUrl: PROXY }];
  assert.equal(pickProviderTarget(existing, { id: DS_FREE_PROVIDER_ID, baseUrl: PROXY }), DS_FREE_PROVIDER_ID);
});

test("我们自己那条已经存在时，永远优先它（不会因为地址被改过就跑偏）", () => {
  const existing = [
    { id: "openai-compatible-01a0b6c9", kind: "openai-compatible", baseUrl: "http://127.0.0.1:22218" },
    { id: DS_FREE_PROVIDER_ID, kind: "openai-compatible", baseUrl: "http://127.0.0.1:22219" },
  ];
  assert.equal(pickProviderTarget(existing, { id: DS_FREE_PROVIDER_ID, baseUrl: PROXY }), DS_FREE_PROVIDER_ID);
});

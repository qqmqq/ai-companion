import assert from "node:assert/strict";
import { test } from "node:test";
import { DS_FREE_DEFAULT_BASE_URL, DS_FREE_MODEL, DS_FREE_PROVIDER_ID, pickProviderTarget, providerEnabledAfterRegister } from "../../src/integrations/ds-free/service.ts";
import { DS_FREE_PROJECT_URL } from "../../src/integrations/ds-free/proxy-process.ts";

const PROXY = "http://127.0.0.1:22217";

test("自动登记模型时还没有密钥就先停用：否则任务会被路由到一条打不通的 provider 上", () => {
  // 新建 + 没密钥 → 停用（一键写入补上密钥后才打开）
  assert.equal(providerEnabledAfterRegister({ existingEnabled: null, hasKey: false }), false);
  assert.equal(providerEnabledAfterRegister({ existingEnabled: false, hasKey: false }), false);
  // 已经有密钥 → 打开
  assert.equal(providerEnabledAfterRegister({ existingEnabled: null, hasKey: true }), true);
  assert.equal(providerEnabledAfterRegister({ existingEnabled: false, hasKey: true }), true);
  // 用户原本就打开着、这次只是重新登记模型 → 不要擅自把它关掉
  assert.equal(providerEnabledAfterRegister({ existingEnabled: true, hasKey: false }), true);
});

test("反代地址与模型名：baseUrl 不带 /v1（我们自己的 provider 会拼 /v1/...）", () => {
  assert.equal(DS_FREE_DEFAULT_BASE_URL, PROXY);
  assert.equal(DS_FREE_DEFAULT_BASE_URL.endsWith("/v1"), false, "带上 /v1 会拼成 /v1/v1/chat/completions");
  assert.equal(DS_FREE_DEFAULT_BASE_URL.includes("/v1/"), false);
  assert.equal(DS_FREE_MODEL, "deepseek-default");
});

test("反代来源必须指向那个开源项目（界面要标明，不能让人以为是我们写的）", () => {
  assert.equal(DS_FREE_PROJECT_URL, "https://github.com/NIyueeE/ds-free-api");
});

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

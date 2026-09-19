import assert from "node:assert/strict";
import { test } from "node:test";
import { DS_FREE_DEFAULT_BASE_URL, DS_FREE_MODEL, DS_FREE_PROVIDER_ID, pickProviderTarget, providerEnabledAfterRegister } from "../../src/integrations/ds-free/service.ts";
import { createDsFreeAdminClient, toAccountIdentity, type DsFreeConfig } from "../../src/integrations/ds-free/admin-client.ts";
import { DS_FREE_PROJECT_URL } from "../../src/integrations/ds-free/proxy-process.ts";

const PROXY = "http://127.0.0.1:22217";

test("账号认人：手机号账号会把「手机号曾被错写进 email」的那条就地改掉，不留僵尸账号", () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never;
  const client = createDsFreeAdminClient({ baseUrl: "http://127.0.0.1:1", logger });
  // 旧状态：手机号被当成邮箱写进去了（真实踩过，反代一直登录失败）
  const broken: DsFreeConfig = {
    ds_core: { accounts: [{ email: "13800138000", mobile: "", area_code: "", password: "old", device_id: "d1" }] },
    api_keys: [],
  };
  const identity = toAccountIdentity("13800138000");
  const fixed = client.addAccount(broken, { ...identity, password: "new", device_id: "d2" });
  assert.equal(fixed.added, false, "应认出是同一个人，而不是再加一条");
  assert.equal(fixed.config.ds_core?.accounts?.length, 1);
  const account = fixed.config.ds_core?.accounts?.[0];
  assert.equal(account?.email, "");
  assert.equal(account?.mobile, "13800138000");
  assert.equal(account?.area_code, "86");
  assert.equal(account?.password, "new");
  assert.equal(account?.device_id, "d2");
});

test("账号认人：不同邮箱/不同手机号各自是一条", () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never;
  const client = createDsFreeAdminClient({ baseUrl: "http://127.0.0.1:1", logger });
  const start: DsFreeConfig = { ds_core: { accounts: [] }, api_keys: [] };
  const one = client.addAccount(start, { email: "a@example.com", mobile: "", area_code: "", password: "p", device_id: "d" });
  const two = client.addAccount(one.config, { email: "", mobile: "13900139000", area_code: "86", password: "p", device_id: "d" });
  assert.equal(two.added, true);
  assert.equal(two.config.ds_core?.accounts?.length, 2);
});

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

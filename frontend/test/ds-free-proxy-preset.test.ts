import { test } from "node:test";
import assert from "node:assert/strict";
import { DS_FREE_PROXY_PRESET } from "../src/lib/provider-presets.ts";

test("DeepSeek 反代预设：baseUrl 不带 /v1（provider 自己会拼 /v1/...）", () => {
  assert.equal(DS_FREE_PROXY_PRESET.baseUrl, "http://127.0.0.1:22217");
  assert.equal(DS_FREE_PROXY_PRESET.baseUrl.endsWith("/v1"), false, "带上 /v1 会拼成 /v1/v1/chat/completions");
  assert.equal(DS_FREE_PROXY_PRESET.baseUrl.includes("/v1/"), false);
  assert.equal(DS_FREE_PROXY_PRESET.kind, "openai-compatible", "反代暴露的是 OpenAI 兼容接口");
  assert.equal(DS_FREE_PROXY_PRESET.defaultModel, "deepseek-default");
});

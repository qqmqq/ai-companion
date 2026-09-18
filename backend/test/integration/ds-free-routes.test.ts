import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunningServer } from "../helpers/container.ts";
import { DS_FREE_DEFAULT_BASE_URL, DS_FREE_SIGN_IN_URL } from "../../src/integrations/ds-free/service.ts";

/** 只回答 /health 的假 fetch：接口层测的就是"反代在不在"这一点 */
const healthOnlyFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
};

test("接入助手接口：状态查询只给该给的，一个密钥字段都不回", async () => {
  const server = await createRunningServer({ fetchImpl: healthOnlyFetch });
  try {
    const response = await fetch(server.baseUrl + "/api/integrations/ds-free/status");
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.phase, "idle");
    assert.equal(body.deviceId, null);
    assert.equal(body.signInUrl, DS_FREE_SIGN_IN_URL);
    assert.equal(body.proxyBaseUrl, DS_FREE_DEFAULT_BASE_URL);
    assert.equal(body.proxyReachable, true);
    assert.ok(typeof body.pageHint === "string" && (body.pageHint as string).length > 0);
    const text = JSON.stringify(body);
    assert.ok(!/password|apiKey|token/i.test(text), "状态里不该出现任何密码/密钥字段：" + text);
  } finally {
    await server.close();
  }
});

test("接入助手接口：还没拿到设备指纹就一键写入 → 明确告诉用户先点哪个按钮", async () => {
  const server = await createRunningServer({ fetchImpl: healthOnlyFetch });
  try {
    const response = await fetch(server.baseUrl + "/api/integrations/ds-free/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.ok((body.error?.message ?? "").includes("设备指纹"), "要告诉用户先点「打开登录页并自动获取」：" + JSON.stringify(body));
  } finally {
    await server.close();
  }
});

test("接入助手接口：管理密码太短在入口就被拦住", async () => {
  const server = await createRunningServer({ fetchImpl: healthOnlyFetch });
  try {
    const response = await fetch(server.baseUrl + "/api/integrations/ds-free/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "123" }),
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test("接入助手接口：停止之后状态回到干净起点", async () => {
  const server = await createRunningServer({ fetchImpl: healthOnlyFetch });
  try {
    const stopped = await fetch(server.baseUrl + "/api/integrations/ds-free/stop", { method: "POST" });
    assert.equal(stopped.status, 200);
    const body = (await stopped.json()) as Record<string, unknown>;
    assert.equal(body.phase, "idle");
    assert.equal(body.deviceId, null);
    assert.equal(body.lastError, null);
  } finally {
    await server.close();
  }
});


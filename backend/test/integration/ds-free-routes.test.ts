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
    assert.equal(body.preparing, false);
    assert.equal(body.providerId, null);
    assert.equal(body.proxyStarted, null);
    assert.equal(body.proxyProjectUrl, "https://github.com/NIyueeE/ds-free-api", "界面要能标明反代是哪个开源项目");
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

test("接入助手接口：start 能接收用户填的反代程序路径（找不到时才需要）", async () => {
  // 测试里绝不真开浏览器：把覆盖路径指到一个不存在的地方，找不到就如实报错
  const previous = process.env["COMPANION_BROWSER_PATH"];
  process.env["COMPANION_BROWSER_PATH"] = "C:/definitely/not/here/chrome.exe";
  const server = await createRunningServer({ fetchImpl: healthOnlyFetch });
  try {
    const response = await fetch(server.baseUrl + "/api/integrations/ds-free/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ binaryPath: "D:/tools/ds-free-api.exe" }),
    });
    // 没装浏览器时这一步会如实报错，但路径必须已经被记下来
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.binaryPath, "D:/tools/ds-free-api.exe");
    assert.equal(body.phase, "error", "找不到浏览器就该如实报错，而不是去开系统里的 Chrome");
  } finally {
    await server.close();
    if (previous === undefined) delete process.env["COMPANION_BROWSER_PATH"];
    else process.env["COMPANION_BROWSER_PATH"] = previous;
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


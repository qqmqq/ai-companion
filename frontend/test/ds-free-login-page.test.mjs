import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement], ["HTMLInputElement", dom.window.HTMLInputElement],
  ["Event", dom.window.Event], ["MouseEvent", dom.window.MouseEvent],
]) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { DsFreeLoginPanel } = await import("../src/pages/ds-free-login.tsx");

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function statusBody(overrides = {}) {
  return {
    phase: "idle",
    deviceId: null,
    pageState: null,
    pageHint: "还没读到页面（浏览器可能还在启动）",
    browser: null,
    debugPort: null,
    signInUrl: "https://chat.deepseek.com/sign_in",
    proxyBaseUrl: "http://127.0.0.1:22217",
    proxyReachable: true,
    lastError: null,
    ...overrides,
  };
}

function installApi(initial) {
  const state = { status: initial, starts: 0, applies: [], stops: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/integrations/ds-free/status")) return json(state.status);
    if (path.endsWith("/api/integrations/ds-free/start") && method === "POST") {
      state.starts += 1;
      state.status = statusBody({ phase: "captured", deviceId: "0123456789abcdef0123456789abcdef", browser: "Google Chrome", debugPort: 9222, pageHint: "已读到页面，设备指纹 SDK 就绪" });
      return json(state.status);
    }
    if (path.endsWith("/api/integrations/ds-free/stop") && method === "POST") {
      state.stops += 1;
      state.status = statusBody();
      return json(state.status);
    }
    if (path.endsWith("/api/integrations/ds-free/apply") && method === "POST") {
      const body = JSON.parse(String(init.body));
      state.applies.push(body);
      return json({
        ok: true,
        providerId: "ds-free-proxy",
        proxyBaseUrl: "http://127.0.0.1:22217",
        apiKeyMasked: "sk-dsfree-01…cdef",
        accountAdded: true,
        deviceIdAttached: true,
        adminPasswordCreated: true,
        steps: ["已把 DeepSeek 账号加入反代账号池", "已在反代里创建本程序专用的 API Key"],
      });
    }
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

async function mount() {
  const errors = [];
  let applied = 0;
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(DsFreeLoginPanel, { onError: (message) => errors.push(message), onApplied: () => { applied += 1; } }));
  });
  await settle();
  return { root, errors, appliedCount: () => applied };
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function inputByPlaceholder(fragment) {
  return [...dom.window.document.querySelectorAll("input")].find((node) => (node.placeholder ?? "").includes(fragment));
}

function setValue(node, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function button(label) {
  const found = [...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes(label));
  assert.ok(found !== undefined, "应该有按钮：" + label);
  return found;
}

test("还没开始时：状态是中文，没拿到设备指纹就不让写入", async () => {
  installApi(statusBody());
  const { root, errors } = await mount();
  assert.match(text(), /还没开始/);
  assert.match(text(), /设备指纹：还没拿到/);
  assert.equal(button("一键写入并配好 provider").disabled, true, "没拿到设备指纹不该能写");
  assert.match(text(), /先点上面的按钮拿到设备指纹/);
  assert.equal(text().includes("undefined"), false, "界面不能出现 undefined");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("点「打开登录页并自动获取」：拿回设备指纹，写入按钮才可用", async () => {
  const state = installApi(statusBody());
  const { root } = await mount();
  await act(async () => { button("打开登录页并自动获取").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
  assert.equal(state.starts, 1);
  assert.match(text(), /已拿到所需信息/);
  assert.match(text(), /设备指纹：已获取/);
  assert.match(text(), /浏览器：Google Chrome/);

  // 三个字段都填齐之前仍然不允许提交
  assert.equal(button("一键写入并配好 provider").disabled, true);
  await act(async () => {
    setValue(inputByPlaceholder("DeepSeek 登录邮箱"), "someone@example.com");
    setValue(inputByPlaceholder("只用于这一次写入"), "deepseek-password");
  });
  await settle(2);
  assert.equal(button("一键写入并配好 provider").disabled, true, "管理密码还空着");
  await act(async () => { setValue(inputByPlaceholder("管理面板的密码"), "admin-password"); });
  await settle(2);
  assert.equal(button("一键写入并配好 provider").disabled, false);
  await act(async () => { root.unmount(); });
});

test("一键写入：密码原样交给后端，用完立刻清空，界面只显示掩码", async () => {
  const state = installApi(statusBody({ phase: "captured", deviceId: "0123456789abcdef0123456789abcdef" }));
  const { root, appliedCount } = await mount();
  await act(async () => {
    setValue(inputByPlaceholder("DeepSeek 登录邮箱"), "someone@example.com");
    setValue(inputByPlaceholder("只用于这一次写入"), "deepseek-password");
    setValue(inputByPlaceholder("管理面板的密码"), "admin-password");
  });
  await settle(2);
  await act(async () => { button("一键写入并配好 provider").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();

  assert.deepEqual(state.applies, [{ email: "someone@example.com", deepseekPassword: "deepseek-password", adminPassword: "admin-password" }]);
  assert.equal(inputByPlaceholder("只用于这一次写入")?.value, "", "密码提交后要清空");
  assert.equal(inputByPlaceholder("管理面板的密码")?.value, "", "管理密码提交后要清空");
  assert.equal(text().includes("deepseek-password"), false, "页面上不该出现密码");
  assert.equal(text().includes("admin-password"), false, "页面上不该出现管理密码");
  assert.match(text(), /sk-dsfree-01…cdef/, "只显示掩码");
  assert.match(text(), /已在反代里创建本程序专用的 API Key/);
  assert.equal(appliedCount(), 1, "配好之后要让模型列表刷新一次");
  await act(async () => { root.unmount(); });
});

test("出错时：把后端给的实话显示出来，并且不冒充已完成", async () => {
  installApi(statusBody({ phase: "error", lastError: "没找到 Chrome 或 Edge。装一个浏览器，或用环境变量 COMPANION_BROWSER_PATH 指定可执行文件路径。" }));
  const { root } = await mount();
  assert.match(text(), /出错了/);
  assert.match(text(), /COMPANION_BROWSER_PATH/);
  assert.match(text(), /设备指纹：还没拿到/);
  await act(async () => { root.unmount(); });
});

test("未知阶段也不给用户看 undefined", async () => {
  installApi(statusBody({ phase: "something_new_from_backend" }));
  const { root } = await mount();
  assert.match(text(), /状态未知/);
  assert.equal(text().includes("undefined"), false);
  await act(async () => { root.unmount(); });
});


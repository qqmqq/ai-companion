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

const PROJECT_URL = "https://github.com/NIyueeE/ds-free-api";

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
    preparing: false,
    deviceId: null,
    pageState: null,
    pageHint: "还没读到页面（浏览器可能还在启动）",
    browser: null,
    debugPort: null,
    browserClosed: null,
    signInUrl: "https://chat.deepseek.com/sign_in",
    proxyBaseUrl: "http://127.0.0.1:22217",
    proxyReachable: true,
    proxyStarted: null,
    proxyNote: "",
    proxyProjectUrl: PROJECT_URL,
    binaryPath: null,
    providerId: null,
    providerNote: "",
    lastError: null,
    ...overrides,
  };
}

/** 抓完自动收尾之后的样子：关窗 + 起反代 + 加模型 */
function capturedBody(overrides = {}) {
  return statusBody({
    phase: "captured",
    deviceId: "0123456789abcdef0123456789abcdef",
    browser: "Google Chrome",
    debugPort: 9222,
    browserClosed: true,
    proxyStarted: true,
    proxyNote: "已自动启动反代（http://127.0.0.1:22217）",
    binaryPath: "D:/tools/ds-free-api.exe",
    providerId: "ds-free-proxy",
    providerNote: "已把模型 deepseek-default 加入「已配置的模型」；密钥在你点一键写入时补齐",
    pageHint: "已读到页面，设备指纹 SDK 就绪",
    ...overrides,
  });
}

function installApi(initial, options = {}) {
  const state = { status: initial, starts: [], applies: [], stops: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/integrations/ds-free/status")) return json(state.status);
    if (path.endsWith("/api/integrations/ds-free/start") && method === "POST") {
      state.starts.push(JSON.parse(String(init.body ?? "{}")));
      state.status = capturedBody();
      return json(state.status);
    }
    if (path.endsWith("/api/integrations/ds-free/stop") && method === "POST") {
      state.stops += 1;
      state.status = statusBody();
      return json(state.status);
    }
    if (path.endsWith("/api/integrations/ds-free/apply") && method === "POST") {
      state.applies.push(JSON.parse(String(init.body)));
      return json({
        ok: true,
        providerId: "ds-free-proxy",
        proxyBaseUrl: "http://127.0.0.1:22217",
        apiKeyMasked: "sk-dsfree-01…cdef",
        accountAdded: true,
        deviceIdAttached: true,
        adminPasswordCreated: true,
        verify: options.verify ?? { ok: true, reason: "" },
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

test("面板上标明反代是别人的开源项目，并在没拿到指纹时不让写入", async () => {
  installApi(statusBody());
  const { root, errors } = await mount();
  assert.match(text(), /还没开始/);
  assert.match(text(), /设备指纹：还没拿到/);
  assert.equal(button("一键写入并配好 provider").disabled, true, "没拿到设备指纹不该能写");
  assert.match(text(), /先点上面的按钮拿到设备指纹/);
  assert.equal(text().includes("undefined"), false, "界面不能出现 undefined");
  // 来源必须写清楚：这是别人的 GPL 项目，我们只调用它
  assert.match(text(), /ds-free-api/);
  assert.match(text(), /GPL-3.0/);
  const link = [...dom.window.document.querySelectorAll("a")].find((node) => node.getAttribute("href") === PROJECT_URL);
  assert.ok(link !== undefined, "要给出来源链接：" + PROJECT_URL);
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("点「打开登录页并自动获取」：抓到后显示已自动关窗、已自动启动反代、模型已加入", async () => {
  const state = installApi(statusBody());
  const { root, appliedCount } = await mount();
  await act(async () => { button("打开登录页并自动获取").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
  assert.deepEqual(state.starts, [{}]);
  assert.match(text(), /已拿到所需信息/);
  assert.match(text(), /设备指纹：已获取/);
  assert.match(text(), /登录页：已自动关闭/);
  assert.match(text(), /反代：已自动启动/);
  assert.match(text(), /模型：ds-free-proxy/);
  assert.match(text(), /已把模型 deepseek-default 加入「已配置的模型」/);
  assert.equal(appliedCount(), 1, "模型加进「已配置的模型」后要让设置页刷新一次");
  // 反代已经在跑：就不该再追着用户要程序路径
  assert.equal(inputByPlaceholder("ds-free-api.exe"), undefined);
  await act(async () => { root.unmount(); });
});

test("反代没起来时：提示去哪儿下这个开源项目，并给出路径输入框", async () => {
  installApi(statusBody({
    phase: "captured",
    deviceId: "0123456789abcdef0123456789abcdef",
    browserClosed: true,
    proxyReachable: false,
    proxyNote: "没找到反代程序。它是开源项目 ds-free-api（https://github.com/NIyueeE/ds-free-api），需要你自己下载。",
    providerId: "ds-free-proxy",
  }));
  const { root } = await mount();
  assert.match(text(), /反代：没连上/);
  assert.match(text(), /github\.com\/NIyueeE\/ds-free-api/);
  assert.ok(inputByPlaceholder("ds-free-api.exe") !== undefined, "找不到程序时应该让用户填一次路径");
  await act(async () => { root.unmount(); });
});

test("填了反代路径：原样交给后端（它会记住）", async () => {
  const state = installApi(statusBody({ phase: "captured", deviceId: "0123456789abcdef0123456789abcdef", proxyReachable: false }));
  const { root } = await mount();
  await act(async () => { setValue(inputByPlaceholder("ds-free-api.exe"), "D:/tools/ds-free-api.exe"); });
  await act(async () => { button("重新打开登录页并获取").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
  assert.deepEqual(state.starts, [{ binaryPath: "D:/tools/ds-free-api.exe" }]);
  await act(async () => { root.unmount(); });
});

test("一键写入：密码原样交给后端，用完立刻清空，界面只显示掩码", async () => {
  const state = installApi(capturedBody());
  const { root } = await mount();
  await act(async () => {
    setValue(inputByPlaceholder("登录邮箱"), "someone@example.com");
    setValue(inputByPlaceholder("只用于这一次写入"), "deepseek-password");
    setValue(inputByPlaceholder("管理面板的密码"), "admin-password");
  });
  await settle(2);
  await act(async () => { button("一键写入并配好 provider").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();

  assert.deepEqual(state.applies, [{ email: "someone@example.com", deepseekPassword: "deepseek-password", adminPassword: "admin-password" }]);
  assert.match(text(), /已实测一次真实请求：通/, "当场验过才敢说可用");
  assert.equal(inputByPlaceholder("只用于这一次写入")?.value, "", "密码提交后要清空");
  assert.equal(inputByPlaceholder("管理面板的密码")?.value, "", "管理密码提交后要清空");
  assert.equal(text().includes("deepseek-password"), false, "页面上不该出现密码");
  assert.equal(text().includes("admin-password"), false, "页面上不该出现管理密码");
  assert.match(text(), /sk-dsfree-01…cdef/, "只显示掩码");
  assert.match(text(), /已在反代里创建本程序专用的 API Key/);
  await act(async () => { root.unmount(); });
});

test("账号那一栏要收手机号；验不通时把原因写在页面上，而不是让你聊天时看超时", async () => {
  installApi(capturedBody(), { verify: { ok: false, reason: "HTTP 503 账号池无可用账号" } });
  const { root } = await mount();
  await act(async () => {
    setValue(inputByPlaceholder("11 位手机号"), "13800138000");
    setValue(inputByPlaceholder("只用于这一次写入"), "p");
    setValue(inputByPlaceholder("管理面板的密码"), "admin-password");
  });
  await settle(2);
  await act(async () => { button("一键写入并配好 provider").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
  assert.match(text(), /已实测一次真实请求：不通/);
  assert.match(text(), /账号池无可用账号/);
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

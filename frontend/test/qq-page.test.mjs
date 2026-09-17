import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement], ["HTMLInputElement", dom.window.HTMLInputElement],
  ["HTMLSelectElement", dom.window.HTMLSelectElement], ["Event", dom.window.Event], ["MouseEvent", dom.window.MouseEvent],
]) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource { constructor() {} addEventListener() {} removeEventListener() {} close() {} }
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};
dom.window.confirm = () => true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QqPage } = await import("../src/pages/qq.tsx");

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function installApi(initial) {
  const state = { status: initial, configs: [], cleared: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/channels/qq/status")) return json(state.status);
    if (path.endsWith("/api/channels/qq/config") && method === "PUT") {
      state.configs.push(JSON.parse(String(init.body)));
      state.status = { ...state.status, configured: true, appId: "102000001", credentialsSaved: true, session: { ...state.status.session, state: "connecting" } };
      return json({ ok: true });
    }
    if (path.endsWith("/api/channels/qq/credentials") && method === "DELETE") {
      state.cleared += 1;
      state.status = { ...state.status, credentialsSaved: false };
      return json({ ok: true });
    }
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

const EMPTY_STATUS = {
  configured: false,
  appId: null,
  sandbox: null,
  baseUrl: null,
  credentialsSaved: false,
  session: { state: "not_configured", lastError: null, lastEventAt: null, consecutiveFailures: 0, gatewaySessions: 0 },
  token: { state: "none", expiresAt: null },
  health: { state: "stopped", accounts: 0, message: null },
  accounts: [],
};

async function mount() {
  const errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(QqPage, { onError: (message) => errors.push(message) })); });
  await settle();
  return { root, errors };
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

test("没配置时：显示「还没配置」，没填密钥不能保存", async () => {
  installApi(EMPTY_STATUS);
  const { root, errors } = await mount();
  assert.match(text(), /还没配置/);
  assert.match(text(), /AppID：—/);
  assert.match(text(), /密钥：未保存/);
  assert.equal(button("保存并连接").disabled, true, "没填 AppID/密钥时不能提交");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("填好 AppID 与 ClientSecret：保存后原样发给后端，输入框立刻清空、页面不回显密钥", async () => {
  const state = installApi(EMPTY_STATUS);
  const { root } = await mount();

  setValue(inputByPlaceholder("102000001"), "102000001");
  setValue(inputByPlaceholder("粘贴机器人"), "SECRET-abc-123");
  await settle(2);
  await act(async () => { button("保存并连接").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();

  assert.deepEqual(state.configs, [{ appId: "102000001", clientSecret: "SECRET-abc-123", sandbox: false }]);
  const secretInput = inputByPlaceholder("已保存");
  assert.equal(secretInput?.value, "", "密钥提交后输入框要清空");
  assert.equal(text().includes("SECRET-abc-123"), false, "页面上任何地方都不该回显密钥");
  assert.match(text(), /已保存并开始连接/);
  await act(async () => { root.unmount(); });
});

test("已连接时：显示中文状态与凭证有效期说明，可以清密钥", async () => {
  const state = installApi({
    ...EMPTY_STATUS,
    configured: true,
    appId: "102000001",
    sandbox: true,
    baseUrl: "https://sandbox.api.sgroup.qq.com",
    credentialsSaved: true,
    session: { state: "connected", lastError: null, lastEventAt: "2026-09-17T10:00:00.000Z", consecutiveFailures: 0, gatewaySessions: 2 },
    token: { state: "valid", expiresAt: "2026-09-17T12:00:00.000Z" },
  });
  const { root } = await mount();
  assert.match(text(), /已连接/);
  assert.match(text(), /环境：沙箱/);
  assert.match(text(), /密钥：已保存/);
  assert.match(text(), /访问凭证：有效/);
  await act(async () => { button("清除密钥").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
  assert.equal(state.cleared, 1);
  assert.match(text(), /密钥已清除/);
  await act(async () => { root.unmount(); });
});


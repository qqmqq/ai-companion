import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ---- jsdom 环境必须在 React / ReactDOM 之前就绪 ----
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement],
  ["HTMLInputElement", dom.window.HTMLInputElement],
  ["Event", dom.window.Event],
  ["MouseEvent", dom.window.MouseEvent],
]) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { SettingsPage } = await import("../src/pages/settings.tsx");

const TASKS = ["chat", "memory_extraction", "summarization", "context_compression"];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function provider(id, defaultModel) {
  return { id, kind: "openai-compatible", displayName: "Provider " + id, baseUrl: "http://" + id, defaultModel, requiresCredential: false, hasCredential: false, timeoutMs: 60000, enabled: true };
}

/** 假后端：形状与真实 API 一致（providers / model-routing / usage / providers/:id/test / PUT model-routing） */
function installApi(options = {}) {
  const state = {
    putBodies: [],
    modelLists: options.modelLists ?? {
      p1: [{ id: "model-A", displayName: "Model A" }, { id: "model-B", displayName: "Model B" }, { id: "model-C", displayName: "Model C" }],
      p2: [{ id: "p2-model-1", displayName: "P2 One" }, { id: "p2-model-2", displayName: "P2 Two" }],
    },
    discoveryFails: options.discoveryFails ?? [],
    configured: options.configured ?? null,
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const path = url.split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/providers") && method === "GET") return json({ items: [provider("p1", "p1-default"), provider("p2", "p2-default")] });
    if (path.endsWith("/api/usage")) return json({ since: "x", summary: [], recent: [] });
    if (path.endsWith("/api/model-routing") && method === "GET") {
      return json({
        items: TASKS.map((taskType) => ({
          taskType,
          configured: taskType === "chat" ? state.configured : null,
          resolved: { providerId: "p1", model: state.configured?.model ?? "p1-default" },
          updatedAt: null,
        })),
      });
    }
    if (path.endsWith("/api/model-routing") && method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      state.putBodies.push(body);
      state.configured = { providerId: body.providerId, model: body.model };
      return json({ taskType: body.taskType, resolved: { providerId: body.providerId, model: body.model ?? "" } });
    }
    const testMatch = /\/api\/providers\/([^/]+)\/test$/.exec(path);
    if (testMatch !== null) {
      const id = decodeURIComponent(testMatch[1]);
      if (state.discoveryFails.includes(id)) return json({ ok: false, error: { kind: "network", message: "列表接口挂了" }, models: [] });
      return json({ ok: true, models: state.modelLists[id] ?? [] });
    }
    throw new Error("unexpected request: " + method + " " + url);
  };
  return state;
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

let errors = [];

async function mount() {
  errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(SettingsPage, { onError: (message) => errors.push(message) }));
  });
  await settle();
  return root;
}

function chatRow() {
  const row = [...dom.window.document.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes("日常聊天"));
  assert.ok(row !== undefined, "应该渲染出「日常聊天」这一行");
  return row;
}

function providerSelect(row) {
  const select = row.querySelector("select");
  assert.ok(select !== null);
  return select;
}

function modelSelect(row) {
  return row.querySelector("select.model-select");
}

function currentModelLine(row) {
  const line = [...row.querySelectorAll("p.hint")].find((p) => (p.textContent ?? "").startsWith("当前模型："));
  return line?.textContent ?? "";
}

async function choose(select, value) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

async function click(node) {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

async function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function applyButton(row) {
  const button = [...row.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "应用");
  assert.ok(button !== undefined, "应该有「应用」按钮");
  return button;
}

function refreshButton() {
  const button = [...dom.window.document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("刷新模型列表"));
  assert.ok(button !== undefined, "应该有「刷新模型列表」按钮");
  return button;
}

test("Test 1：取到 3 个模型时，下拉里出现 3 个可选项", async () => {
  installApi();
  const root = await mount();
  const select = modelSelect(chatRow());
  assert.ok(select !== null, "有候选时必须渲染真正的 <select>（而不是只能靠输入框）");
  const values = [...select.querySelectorAll("option")].map((option) => option.value);
  for (const id of ["model-A", "model-B", "model-C"]) assert.ok(values.includes(id), "缺少可选项 " + id);
  await act(async () => { root.unmount(); });
});

test("Test 2 + Test 3：选中第二个模型后立刻显示，并在「应用」时原样发给后端", async () => {
  const api = installApi();
  const root = await mount();
  const row = chatRow();
  await choose(modelSelect(row), "model-B");
  assert.match(currentModelLine(row), /当前模型：model-B/, "界面上必须立刻显示选中值");
  await click(applyButton(row));
  assert.equal(api.putBodies.length, 1);
  assert.deepEqual(api.putBodies[0], { taskType: "chat", providerId: "p1", model: "model-B" }, "发出去的 model 必须是所选 ID，而不是显示名或默认值");
  await act(async () => { root.unmount(); });
});

test("Test 4：刷新页面后，之前保存的模型仍然被选中", async () => {
  installApi({ configured: { providerId: "p1", model: "model-B" } });
  const root = await mount();
  const row = chatRow();
  assert.equal(modelSelect(row)?.value, "model-B", "下拉必须显示已保存的模型");
  assert.match(currentModelLine(row), /当前模型：model-B/);
  await act(async () => { root.unmount(); });
});

test("Test 6：点「刷新模型列表」不会把用户选的模型冲掉", async () => {
  installApi();
  const root = await mount();
  const row = chatRow();
  await choose(modelSelect(row), "model-B");
  await click(refreshButton());
  assert.equal(modelSelect(row)?.value, "model-B", "刷新后仍然是 model-B，不能跳回第一项");
  assert.match(currentModelLine(row), /当前模型：model-B/);
  await act(async () => { root.unmount(); });
});

test("Test 7：切换 Provider 时，旧 Provider 的模型不会被错误保留", async () => {
  installApi();
  const root = await mount();
  const row = chatRow();
  await choose(modelSelect(row), "model-B");
  await choose(providerSelect(row), "p2");
  await settle();
  const value = modelSelect(row)?.value ?? "";
  assert.notEqual(value, "model-B", "换成 p2 之后绝不能还留着 p1 的 model-B");
  assert.ok(value === "p2-model-1" || value === "p2-default", "应当切到 p2 的候选/默认模型，实际 " + value);
  await act(async () => { root.unmount(); });
});

test("Test 8：模型列表获取失败时，手填模型仍然可用并且真的会被保存", async () => {
  const api = installApi({ discoveryFails: ["p1"] });
  const root = await mount();
  const row = chatRow();
  assert.equal(modelSelect(row), null, "没有候选时不应该出现空下拉");
  const input = row.querySelector("input");
  assert.ok(input !== null, "必须仍然有可用的模型输入框");
  assert.equal(input.disabled, false, "列表失败不能禁用模型输入框");
  await typeInto(input, "my-custom-model");
  await click(applyButton(row));
  assert.equal(api.putBodies.length, 1);
  assert.equal(api.putBodies[0].model, "my-custom-model");
  await act(async () => { root.unmount(); });
});

import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement],
  ["HTMLInputElement", dom.window.HTMLInputElement],
  ["Event", dom.window.Event],
  ["MouseEvent", dom.window.MouseEvent],
  ["confirm", () => true],
]) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom 没有 EventSource：给 app 一个假的事件源，什么都不推送 */
class FakeEventSource {
  constructor() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
// jsdom 没有实现 scrollTo（聊天区用了它来滚到底部）
dom.window.Element.prototype.scrollTo = () => {};
// jsdom 的 window.confirm 默认返回 false；测试里统一点"确定"
dom.window.confirm = () => true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { App } = await import("../src/app.tsx");

const CHARACTER = {
  id: "char-1",
  name: "Aria",
  slug: "aria",
  avatarMediaId: null,
  versionCount: 1,
  definition: { name: "Aria", description: "测试角色", personality: "安静", scenario: "书房", systemPrompt: "", firstMessage: "在的。" },
  state: { emotion: { primary: "neutral", intensity: 0.2 }, activity: { label: "待机" }, location: { label: "房间" }, energy: 0.8, autonomyLevel: "normal" },
};

function conversation(id, source, text, at) {
  return { id, characterId: "char-1", title: "", lastMessageAt: at, source, channel: source, lastMessageText: text, characterVersionId: "v1" };
}

const WEB = conversation("conv-web", "web", "网页这边的最后一句", "2026-09-16T06:00:00.000Z");
const WEIXIN = conversation("conv-weixin", "weixin", "今天怎么样……", "2026-09-16T06:30:00.000Z");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function installApi() {
  const state = { conversations: [WEB, WEIXIN], deleted: [], deleteCalls: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/characters")) return json({ items: [CHARACTER] });
    // 角色页（默认页签）挂载时会读这两处提示词
    if (path.endsWith("/api/context/prompt")) return json({ custom: "", appliesTo: "系统约束（对所有角色生效）" });
    if (path.endsWith("/api/characters/" + CHARACTER.id + "/prompt")) return json({ prompt: "", fallback: "" });
    if (path.endsWith("/api/conversations") && method === "GET") return json({ items: state.conversations });
    if (path.endsWith("/api/system/health")) return json({ status: "ok", channels: [] });
    if (path.endsWith("/api/messages") || /\/api\/conversations\/[^/]+\/messages$/.test(path)) return json({ items: [] });
    const deleteMatch = /\/api\/conversations\/([^/]+)$/.exec(path);
    if (deleteMatch !== null && method === "DELETE") {
      state.deleteCalls += 1;
      const id = decodeURIComponent(deleteMatch[1]);
      const existed = state.conversations.some((entry) => entry.id === id);
      state.conversations = state.conversations.filter((entry) => entry.id !== id);
      state.deleted.push(id);
      if (!existed) return json({ error: { code: "not_found", message: "conversation not found: " + id, details: {} } }, 404);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mountApp() {
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(App)); });
  await settle();
  return root;
}

async function click(node) {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

function byText(selector, text) {
  return [...dom.window.document.querySelectorAll(selector)].filter((node) => (node.textContent ?? "").includes(text));
}

async function openChatTab() {
  const tab = byText("nav button", "聊天")[0];
  assert.ok(tab !== undefined, "应该有「聊天」页签");
  await click(tab);
}

function conversationItems() {
  return [...dom.window.document.querySelectorAll(".conversation-item")];
}

test("Test 3：会话列表同时显示 网页 / 微信 两个来源标签", async () => {
  installApi();
  const root = await mountApp();
  await openChatTab();
  const items = conversationItems();
  assert.equal(items.length, 2, "两个会话都要出现在列表里");
  const text = items.map((item) => item.textContent ?? "").join(" | ");
  assert.match(text, /网页/, "必须显示网页来源");
  assert.match(text, /微信/, "必须显示微信来源");
  assert.match(text, /Aria/, "两个会话都要显示角色名（来源不能混进角色名）");
  assert.match(text, /网页这边的最后一句/, "要显示最后一条消息");
  assert.ok(items.every((item) => /\d{2}:\d{2}/.test(item.textContent ?? "")), "要显示时间");
  await act(async () => { root.unmount(); });
});

test("Test 4 + Test 5：打开会话后标题显示「网页聊天」/「微信聊天」", async () => {
  installApi();
  const root = await mountApp();
  await openChatTab();
  const main = (index) => conversationItems()[index].querySelector(".conversation-main");
  await click(main(0));
  assert.match(dom.window.document.querySelector("h2")?.textContent ?? "", /网页聊天/, "网页会话标题要标明来源");
  await click(main(1));
  assert.match(dom.window.document.querySelector("h2")?.textContent ?? "", /微信聊天/, "微信会话标题要标明来源");
  await act(async () => { root.unmount(); });
});

test("Test 8：删除当前打开的会话后，页面离开该会话并从列表移除", async () => {
  const api = installApi();
  const root = await mountApp();
  await openChatTab();
  const items = conversationItems();
  await click(items[0].querySelector(".conversation-main"));
  assert.match(dom.window.document.querySelector("h2")?.textContent ?? "", /网页聊天/);

  await click(conversationItems()[0].querySelector(".conversation-delete"));
  assert.deepEqual(api.deleted, ["conv-web"]);
  const heading = dom.window.document.querySelector("h2")?.textContent ?? "";
  assert.match(heading, /未选择角色/, "不能停留在已经删除的会话里");
  assert.equal(conversationItems().length, 1, "被删的会话必须从列表消失");
  assert.match(conversationItems()[0].textContent ?? "", /微信/);
  await act(async () => { root.unmount(); });
});

test("Test 9（前端）：连点两次删除不会崩，且第二次不会报错给用户", async () => {
  const api = installApi();
  const root = await mountApp();
  await openChatTab();
  const button = conversationItems()[1].querySelector(".conversation-delete");
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await settle(10);
  const sent = api.deleted.filter((id) => id === "conv-weixin").length;
  assert.ok(sent >= 1, "至少要真的发出删除请求");
  assert.ok(sent <= 2, "连点最多发两次请求（按钮会被禁用）");
  assert.equal(dom.window.document.querySelector(".error"), null, "重复删除不能让界面报错（404 只当作已删除）");
  assert.equal(conversationItems().length, 1, "会话只消失一次，列表状态正常");
  await act(async () => { root.unmount(); });
});

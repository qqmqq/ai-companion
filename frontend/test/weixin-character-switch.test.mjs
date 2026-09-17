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
  ["HTMLSelectElement", dom.window.HTMLSelectElement],
  ["Event", dom.window.Event],
  ["MouseEvent", dom.window.MouseEvent],
]) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource {
  constructor() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { WeixinPage } = await import("../src/pages/weixin.tsx");

const ARIA = { id: "char-xm", name: "Aria", slug: "aria", avatarMediaId: null, versionCount: 1 };
const KAI = { id: "char-gy", name: "Kai", slug: "kai", avatarMediaId: null, versionCount: 2 };

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function installApi() {
  const state = {
    activeCharacterId: null,
    switchCalls: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/channels/weixin/status")) {
      return json({
        enabled: true,
        health: { state: "healthy", message: null },
        accounts: [{ accountId: "acct-1", displayName: "我的微信", state: "connected", loggedIn: true, requiresRelogin: false, lastError: null, consecutiveFailures: 0, lastEventAt: "2026-09-17T04:00:00.000Z" }],
      });
    }
    if (path.endsWith("/api/conversations") && method === "GET") {
      return json({
        items: [
          {
            id: "conv-wx-1",
            characterId: ARIA.id,
            title: "微信会话",
            lastMessageAt: "2026-09-17T04:00:00.000Z",
            source: "weixin",
            channel: "weixin",
            lastMessageText: "你好",
            activeCharacterId: state.activeCharacterId,
          },
          { id: "conv-web-1", characterId: ARIA.id, title: "网页会话", lastMessageAt: null, source: "web", channel: "web", lastMessageText: null, activeCharacterId: null },
        ],
      });
    }
    if (/\/api\/conversations\/[^/]+\/active-character$/.test(path) && method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      state.switchCalls.push(body);
      state.activeCharacterId = body.characterId;
      return json({
        conversationId: "conv-wx-2",
        characterId: body.characterId,
        characterName: "Kai",
        newConversation: true,
        text: "……说吧。",
        delivered: true,
        deliveryError: null,
      });
    }
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

async function mount() {
  const errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(WeixinPage, { characters: [ARIA, KAI], onError: (message) => errors.push(message) }));
  });
  await settle();
  return { root, errors };
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function setValue(node, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function button(label) {
  const found = [...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes(label));
  assert.ok(found !== undefined, "应该有按钮：" + label);
  return found;
}

test("微信页能直接换角色：选人 → 点按钮 → 开场白发出去并提示结果", async () => {
  const state = installApi();
  const { root, errors } = await mount();

  // 只列微信侧的聊天（网页会话不在这里）
  assert.match(text(), /在跟谁聊/);
  assert.match(text(), /Aria/);
  assert.match(text(), /未指定（按第一个角色回复）/, "没切过的聊天要说清默认按谁回复");
  assert.equal(text().includes("网页会话"), false, "网页会话不该出现在微信页");

  const switchButton = button("切换到这个角色");
  assert.equal(switchButton.disabled, true, "没选人之前不能点");

  const select = dom.window.document.querySelector("select");
  assert.ok(select !== undefined, "要有角色下拉框");
  setValue(select, KAI.id);
  await settle(2);
  assert.equal(button("切换到这个角色").disabled, false);

  await act(async () => { button("切换到这个角色").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();

  assert.deepEqual(state.switchCalls, [{ characterId: KAI.id }], "要把选中的角色发给后端");
  assert.match(text(), /已切换到「Kai」/, "要说清切成了谁");
  assert.match(text(), /开场白已发到微信：「……说吧。」/, "要说清开场白真的发出去了");
  assert.match(text(), /现在在聊/, "刷新后要标出现在在聊谁");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("微信页：一个角色都没有时提示先去建角色", async () => {
  installApi();
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(WeixinPage, { characters: [], onError: () => {} }));
  });
  await settle();
  assert.match(text(), /先在「角色」页建一个/);
  assert.equal(button("切换到这个角色").disabled, true);
  await act(async () => { root.unmount(); });
});

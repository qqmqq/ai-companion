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
const { MemoriesPage } = await import("../src/pages/memories.tsx");

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

/** 三天前发生的一条记忆：用来验证页面上「记于 …（3 天前）」看得见 */
const OCCURRED = new Date(Date.now() - 3 * 86_400_000).toISOString();

function installApi() {
  globalThis.fetch = async (input) => {
    const path = String(input).split("?")[0];
    if (path.endsWith("/api/memories")) {
      return json({
        total: 1,
        items: [
          {
            id: "m1",
            scope: "user",
            type: "preference",
            content: "用户喜欢手冲咖啡",
            importance: 0.8,
            confidence: 0.9,
            tags: ["咖啡"],
            characterId: null,
            conversationId: null,
            sourceMessageId: null,
            reinforcement: 0,
            accessCount: 0,
            status: "active",
            occurredAt: OCCURRED,
            createdAt: OCCURRED,
          },
        ],
      });
    }
    throw new Error("unexpected request: " + path);
  };
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

test("记忆列表显示现实时间戳：记于 某天某时（多久以前）", async () => {
  installApi();
  const errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MemoriesPage, { characterId: null, onError: (message) => errors.push(message) }));
  });
  await settle();

  assert.match(text(), /记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（3 天前）/, text());
  assert.equal(text().includes("undefined"), false, "界面不能出现 undefined");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

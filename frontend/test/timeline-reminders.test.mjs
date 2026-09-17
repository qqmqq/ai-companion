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
const confirmations = [];
dom.window.confirm = (message) => { confirmations.push(String(message)); return true; };
Object.defineProperty(globalThis, "confirm", { value: dom.window.confirm, configurable: true, writable: true });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { TimelinePage } = await import("../src/pages/timeline.tsx");

const CHARACTER = { id: "char-1", name: "Aria", slug: "aria", avatarMediaId: null, versionCount: 1 };

function reminder(id, message, overrides = {}) {
  return {
    id,
    characterId: "char-1",
    kind: "scheduled_message",
    triggerType: "once",
    cronExpr: null,
    intervalMs: null,
    nextRunAt: "2026-09-17T04:00:00.000Z",
    lastRunAt: null,
    enabled: true,
    status: "idle",
    payload: { message, channel: "weixin" },
    ...overrides,
  };
}

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
function noContent() {
  return new Response(null, { status: 204 });
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function click(node) {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function installApi() {
  const state = {
    reminders: [
      reminder("job:m1", "明天中午12点提醒我去开会"),
      reminder("job:m2", "提醒我带伞", { enabled: false, status: "disabled", triggerType: "cron_like", cronExpr: "22:00" }),
      reminder("job:m3", "（没有原文的提醒）", { payload: { channel: "some-new-channel" } }),
    ],
    systemJobs: [reminder("job:sys1", "系统主动消息", { kind: "proactive_message", payload: {} })],
    deletes: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "DELETE" && /\/api\/scheduler\/jobs\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/").pop());
      state.deletes.push(id);
      state.reminders = state.reminders.filter((job) => job.id !== id);
      return noContent();
    }
    if (path.endsWith("/api/events")) return json({ items: [] });
    if (path.endsWith("/api/tasks")) return json({ items: [] });
    if (path.endsWith("/api/scheduler/jobs")) return json({ items: [...state.reminders, ...state.systemJobs] });
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

async function mount(state) {
  const errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(TimelinePage, { characters: [CHARACTER], onError: (message) => errors.push(message) }));
  });
  await settle();
  return { root, errors };
}

test("事件与任务页：定时提醒出现在这里，中文说明齐全，系统任务不混进来", async () => {
  const state = installApi();
  const { root, errors } = await mount(state);

  assert.match(text(), /定时提醒（3）/, "要有定时提醒分区，并且数对得上");
  assert.match(text(), /明天中午12点提醒我去开会/, "提醒原文要显示");
  assert.match(text(), /发到：微信/, "要说清发到哪个渠道");
  assert.match(text(), /原本每天 22:00 执行/, "cron 类的要翻成中文，停用的也要说清原本安排");
  assert.equal(text().includes("已停用已停用"), false, "状态徽标和说明不要重复同一个词");
  assert.match(text(), /已停用/, "停用的提醒要标出来");
  assert.match(text(), /聊天里/, "认不出的渠道要有中文兜底，不能显示英文枚举");
  assert.equal(text().includes("proactive_message"), false, "系统自己的调度任务不该出现在这页");
  assert.equal(text().includes("undefined"), false);
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("定时提醒可以停用 / 启用 / 删除，删除前有确认", async () => {
  const state = installApi();
  confirmations.length = 0;
  const { root, errors } = await mount(state);

  const card = [...dom.window.document.querySelectorAll(".cards li")].find((node) => (node.textContent ?? "").includes("明天中午12点提醒我去开会"));
  assert.ok(card !== undefined, "要找到那条提醒的卡片");
  const labels = [...card.querySelectorAll("button")].map((node) => node.textContent ?? "");
  assert.ok(labels.includes("停用"), "启用的提醒要能停用");
  assert.ok(labels.includes("删除"), "要能删除");

  await click([...card.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("删除")));
  assert.deepEqual(state.deletes, ["job:m1"]);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /确定删除这条提醒/);
  assert.equal(text().includes("明天中午12点提醒我去开会"), false, "删掉之后卡片要消失");
  assert.match(text(), /定时提醒（2）/, "计数要跟着变");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("一条提醒都没有时给出怎么加提醒的提示", async () => {
  const state = installApi();
  state.reminders = [];
  const { root } = await mount(state);
  assert.match(text(), /还没有定时提醒/);
  assert.match(text(), /明天中午12点提醒我去开会/, "空状态要告诉用户怎么加");
  await act(async () => { root.unmount(); });
});

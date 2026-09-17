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
const { RelationshipPage } = await import("../src/pages/relationship.tsx");
const { TimelinePage } = await import("../src/pages/timeline.tsx");

const CHARACTER = { id: "char-1", name: "Aria", slug: "aria", avatarMediaId: null, versionCount: 1 };

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
function noContent() {
  return new Response(null, { status: 204 });
}

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(element) {
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
  return root;
}

async function click(node) {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function buttons() {
  return [...dom.window.document.querySelectorAll(".cards li button")];
}

function installRelationshipApi() {
  const state = {
    changes: [{ id: "change-1", dimension: "trust", delta: 0.05, reason: "一起把事情做完了", source: "user_manual", createdAt: "2026-09-16T06:00:00.000Z" }],
    milestones: [{ id: "mile-1", label: "关系进入「friend」阶段", at: "2026-09-16T06:00:00.000Z" }],
    history: [{ id: "emo-1", before: { primary: "neutral" }, after: { primary: "happy" }, intensity: 0.6, reason: "被夸了一句", source: "deterministic", createdAt: "2026-09-16T06:00:00.000Z" }],
    deletes: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "DELETE") {
      state.deletes.push(path);
      const change = /\/api\/relationships\/([^/]+)\/changes\/([^/]+)$/.exec(path);
      const milestone = /\/api\/relationships\/([^/]+)\/milestones\/([^/]+)$/.exec(path);
      const emotion = /\/api\/emotions\/([^/]+)\/history\/([^/]+)$/.exec(path);
      if (change !== null) state.changes = state.changes.filter((item) => item.id !== decodeURIComponent(change[2]));
      else if (milestone !== null) state.milestones = state.milestones.filter((item) => item.id !== decodeURIComponent(milestone[2]));
      else if (emotion !== null) state.history = state.history.filter((item) => item.id !== decodeURIComponent(emotion[2]));
      else throw new Error("unexpected delete: " + path);
      return noContent();
    }
    if (path.endsWith("/api/relationships")) {
      return json({ items: [{ characterId: "char-1", characterName: "Aria", stage: "friend", dimensions: { familiarity: 0.3, trust: 0.4, affection: 0.3, intimacy: 0.1, respect: 0.2, dependence: 0.1 }, updatedAt: "2026-09-16T06:00:00.000Z" }] });
    }
    if (/\/api\/relationships\/[^/]+$/.test(path)) {
      return json({ relationship: { stage: "friend", updatedAt: "2026-09-16T06:00:00.000Z" }, milestones: state.milestones, changes: state.changes });
    }
    if (/\/api\/emotions\/[^/]+$/.test(path)) {
      return json({
        emotion: { primary: "happy", intensity: 0.6, reason: "刚刚聊得很开心" },
        mood: "愉快",
        activity: { label: "看书" },
        location: { label: "书房" },
        energy: 0.8,
        lastInteractionAt: "2026-09-16T06:00:00.000Z",
        history: state.history,
      });
    }
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

function installTimelineApi() {
  const state = {
    events: [{ id: "event-1", characterId: "char-1", title: "周末一起去书店", type: "promise", status: "planned", importance: 0.5, dueAt: null, description: "" }],
    tasks: [{ id: "task-1", characterId: "char-1", kind: "custom", status: "pending", executeAt: "2026-09-16T09:00:00.000Z", attempts: 0, maxAttempts: 3, lastError: null, eventId: null, payload: { title: "给他带一杯咖啡" } }],
    deletes: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "DELETE") {
      state.deletes.push(path);
      const task = /\/api\/tasks\/([^/]+)$/.exec(path);
      const event = /\/api\/events\/([^/]+)$/.exec(path);
      if (task !== null) state.tasks = state.tasks.filter((item) => item.id !== decodeURIComponent(task[1]));
      else if (event !== null) state.events = state.events.filter((item) => item.id !== decodeURIComponent(event[1]));
      else throw new Error("unexpected delete: " + path);
      return noContent();
    }
    if (path.endsWith("/api/events")) return json({ items: state.events });
    if (path.endsWith("/api/tasks")) return json({ items: state.tasks });
    // 「事件与任务」页现在也会列定时提醒（scheduled_jobs）；这个用例不关心它，返回空即可
    if (path.endsWith("/api/scheduler/jobs")) return json({ items: [] });
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

test("关系与情绪页：每条记录都有删除按钮，点了会真的发 DELETE 并从页面消失", async () => {
  const state = installRelationshipApi();
  confirmations.length = 0;
  const errors = [];
  const root = await mount(React.createElement(RelationshipPage, { characters: [CHARACTER], onError: (message) => errors.push(message) }));

  assert.match(text(), /最近的变化/);
  assert.match(text(), /里程碑/);
  assert.match(text(), /最近的情绪变化/);
  assert.equal(text().includes("一起把事情做完了"), true);

  const deleteButtons = buttons();
  assert.equal(deleteButtons.length, 3, "变化记录 / 里程碑 / 情绪记录 各有一个删除按钮");
  assert.ok(deleteButtons.every((node) => (node.textContent ?? "").includes("删除")));

  // 删关系变化记录
  await click(deleteButtons[0]);
  assert.ok(state.deletes.some((path) => path.endsWith("/api/relationships/char-1/changes/change-1")), "要发 DELETE 关系变化记录");
  assert.equal(text().includes("一起把事情做完了"), false, "删掉的记录要从页面上消失");
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /确定删除/);
  assert.match(confirmations[0], /不会恢复/);

  // 删里程碑
  await click(buttons()[0]);
  assert.ok(state.deletes.some((path) => path.endsWith("/api/relationships/char-1/milestones/mile-1")), "要发 DELETE 里程碑");
  assert.equal(text().includes("关系进入「friend」阶段"), false);

  // 删情绪记录
  await click(buttons()[0]);
  assert.ok(state.deletes.some((path) => path.endsWith("/api/emotions/char-1/history/emo-1")), "要发 DELETE 情绪记录");
  assert.equal(text().includes("被夸了一句"), false);

  assert.match(text(), /还没有变化记录/, "删空后显示空状态");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("取消确认时不会删除任何东西", async () => {
  const state = installRelationshipApi();
  dom.window.confirm = () => false;
  Object.defineProperty(globalThis, "confirm", { value: dom.window.confirm, configurable: true, writable: true });
  const root = await mount(React.createElement(RelationshipPage, { characters: [CHARACTER], onError: () => {} }));
  await click(buttons()[0]);
  assert.deepEqual(state.deletes, [], "点了取消就不该发请求");
  assert.equal(text().includes("一起把事情做完了"), true, "记录还在");
  await act(async () => { root.unmount(); });
  dom.window.confirm = () => true;
  Object.defineProperty(globalThis, "confirm", { value: dom.window.confirm, configurable: true, writable: true });
});

test("事件与任务页：任务也有删除按钮，事件删除照旧", async () => {
  const state = installTimelineApi();
  confirmations.length = 0;
  const errors = [];
  const root = await mount(React.createElement(TimelinePage, { characters: [CHARACTER], onError: (message) => errors.push(message) }));

  assert.match(text(), /周末一起去书店/);
  assert.match(text(), /给他带一杯咖啡/);
  const names = buttons().map((node) => node.textContent ?? "");
  assert.ok(names.some((label) => label.includes("删除")), "任务卡要有删除按钮");

  // 先删任务
  const taskCard = [...dom.window.document.querySelectorAll(".cards li")].find((node) => (node.textContent ?? "").includes("给他带一杯咖啡"));
  assert.ok(taskCard !== undefined);
  const taskDelete = [...taskCard.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("删除"));
  await click(taskDelete);
  assert.ok(state.deletes.some((path) => path.endsWith("/api/tasks/task-1")), "要发 DELETE 任务");
  assert.equal(text().includes("给他带一杯咖啡"), false, "删掉的任务要从页面消失");

  // 再删事件
  const eventCard = [...dom.window.document.querySelectorAll(".cards li")].find((node) => (node.textContent ?? "").includes("周末一起去书店"));
  assert.ok(eventCard !== undefined);
  const eventDelete = [...eventCard.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("删除"));
  await click(eventDelete);
  assert.ok(state.deletes.some((path) => path.endsWith("/api/events/event-1")), "要发 DELETE 事件");
  assert.equal(text().includes("周末一起去书店"), false);
  assert.match(text(), /还没有事件/);
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

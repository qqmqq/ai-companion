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
const { TimelinePage } = await import("../src/pages/timeline.tsx");

const ARIA = { id: "char-1", name: "Aria", slug: "aria", avatarMediaId: null, versionCount: 1 };
const KAI = { id: "char-2", name: "Kai", slug: "kai", avatarMediaId: null, versionCount: 2 };

function event(id, characterId, title, type) {
  return { id, characterId, type, title, description: "", status: "planned", importance: 0.5, dueAt: null, occurredAt: null, createdAt: "2026-09-17T00:00:00.000Z" };
}

function task(id, characterId, title) {
  return { id, characterId, kind: "custom", payload: { title }, status: "pending", priority: 5, executeAt: "2026-09-17T04:00:00.000Z", attempts: 0, maxAttempts: 3, lastError: null, eventId: null };
}

function reminder(id, characterId, message) {
  return {
    id,
    characterId,
    kind: "scheduled_message",
    triggerType: "once",
    cronExpr: null,
    intervalMs: null,
    nextRunAt: "2026-09-17T04:00:00.000Z",
    lastRunAt: null,
    enabled: true,
    status: "idle",
    payload: { message, channel: "weixin" },
  };
}

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function installApi() {
  globalThis.fetch = async (input) => {
    const path = String(input).split("?")[0];
    if (path.endsWith("/api/events")) {
      return json({
        items: [
          event("e1", ARIA.id, "和Aria约好去书店", "promise"),
          event("e2", KAI.id, "Kai的体检", "future_plan"),
          event("e3", "char-deleted", "某个已删除角色的事", "custom"),
        ],
      });
    }
    if (path.endsWith("/api/tasks")) {
      return json({ items: [task("t1", ARIA.id, "完成论文"), task("t2", KAI.id, "到点主动问候")] });
    }
    if (path.endsWith("/api/scheduler/jobs")) {
      return json({ items: [reminder("r1", ARIA.id, "提醒我带伞"), reminder("r2", KAI.id, "提醒我去开会")] });
    }
    throw new Error("unexpected request: " + path);
  };
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount() {
  const errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(TimelinePage, { characters: [ARIA, KAI], onError: (message) => errors.push(message) }));
  });
  await settle();
  return { root, errors };
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function filterSelect() {
  return [...dom.window.document.querySelectorAll("select")].find((node) => (node.textContent ?? "").includes("全部角色"));
}

async function setFilter(value) {
  const select = filterSelect();
  assert.ok(select !== undefined, "要有按角色筛选的下拉框");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set;
  setter.call(select, value);
  await act(async () => { select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await settle();
}

test("事件、任务、提醒都按角色分开：一个角色一组，每条都标了是谁的事", async () => {
  installApi();
  const { root, errors } = await mount();

  // 三段都按角色分了组（Aria 1 条、Kai 1 条、已删除的角色 1 条）
  assert.match(text(), /Aria（1）/);
  assert.match(text(), /Kai（1）/);
  assert.match(text(), /已删除的角色（1）/, "角色被删掉的记录不能消失，要单独列出来");

  // 每条卡都写清了属于谁
  assert.match(text(), /属于：Aria/);
  assert.match(text(), /属于：Kai/);
  assert.match(text(), /属于：已删除的角色/);

  // 筛选框里给了每个角色的条数
  assert.match(text(), /全部角色（事件 3・任务 2・提醒 2）/);
  assert.match(text(), /Aria（3）/);
  assert.equal(text().includes("char-deleted"), false, "界面上不出现角色 id");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("只看某个角色：别人的条目消失，新建事件也默认记在他名下", async () => {
  installApi();
  const { root } = await mount();

  await setFilter(KAI.id);
  assert.match(text(), /Kai的体检/);
  assert.match(text(), /到点主动问候/);
  assert.match(text(), /提醒我去开会/);
  assert.equal(text().includes("和Aria约好去书店"), false, "Aria的事件不该出现");
  assert.equal(text().includes("提醒我带伞"), false, "Aria的提醒不该出现");
  assert.equal(text().includes("Aria（1）"), false, "分组标题里也不该有Aria");
  assert.match(text(), /事件（1）/);
  assert.match(text(), /任务（1）/);
  assert.match(text(), /定时提醒（1）/);

  // 新建事件的默认角色跟着筛选走
  const formCharacter = [...dom.window.document.querySelectorAll("select")].find((node) => (node.textContent ?? "").includes("默认第一个角色"));
  assert.ok(formCharacter !== undefined);
  assert.equal(formCharacter.value, KAI.id);
  await act(async () => { root.unmount(); });
});

test("只看通用：说得清是「通用」这一组没有东西，而不是页面坏了", async () => {
  installApi();
  const { root } = await mount();
  await setFilter("__none__");
  assert.match(text(), /还没有事件/);
  assert.match(text(), /通用/, "空状态要说明是通用这一组为空");
  assert.equal(text().includes("和Aria约好去书店"), false);
  await act(async () => { root.unmount(); });
});

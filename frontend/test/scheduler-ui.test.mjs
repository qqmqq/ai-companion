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
class FakeEventSource {
  constructor() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};
dom.window.confirm = () => true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ProactivePage } = await import("../src/pages/proactive.tsx");

const CHARACTER = { id: "char-1", name: "Aria", slug: "aria", avatarMediaId: null, versionCount: 1 };

const POLICY = {
  enabled: true,
  autonomy: "normal",
  quietHours: { enabled: true, start: "23:00", end: "08:00" },
  dailyLimit: 3,
  cooldownMs: 1800000,
  inactivityThresholdMs: 10800000,
};

// 全部取真实库里的取值，再故意混入一个未来才会出现的新枚举
const JOBS = [
  { id: "job-1", characterId: "char-1", kind: "proactive_message", triggerType: "cron_like", cronExpr: "22:00", intervalMs: null, nextRunAt: "2026-09-17T14:00:00.000Z", lastRunAt: "2026-09-16T14:00:00.000Z", enabled: true, status: "idle" },
  { id: "job-2", characterId: null, kind: "event_maintenance", triggerType: "interval", cronExpr: null, intervalMs: 1800000, nextRunAt: "2026-09-17T14:30:00.000Z", lastRunAt: "2026-09-17T14:00:00.000Z", enabled: true, status: "failed" },
  { id: "job-3", characterId: "char-1", kind: "scheduled_message", triggerType: "once", cronExpr: null, intervalMs: null, nextRunAt: "2026-09-17T15:00:00.000Z", lastRunAt: null, enabled: false, status: "disabled" },
  { id: "job-4", characterId: "char-1", kind: "brand_new_kind", triggerType: "brand_new_trigger", cronExpr: null, intervalMs: null, nextRunAt: "2026-09-17T16:00:00.000Z", lastRunAt: null, enabled: true, status: "brand_new_status" },
];

const DECISIONS = [
  { id: "d1", triggerKind: "manual", triggerReason: "手动触发", decision: "sent", blockedReason: null, autonomy: "normal", model: "deepseek-flash", messageId: "m1", createdAt: "2026-09-17T06:00:00.000Z", detail: {} },
  { id: "d2", triggerKind: "idle_check", triggerReason: "用户才安静了 15 分钟", decision: "skipped", blockedReason: "not_eligible", autonomy: "normal", model: null, messageId: null, createdAt: "2026-09-17T06:10:00.000Z", detail: {} },
  { id: "d3", triggerKind: "scheduled_window", triggerReason: "到了约定时间", decision: "blocked", blockedReason: "quiet_hours", autonomy: "normal", model: null, messageId: null, createdAt: "2026-09-17T06:20:00.000Z", detail: {} },
  { id: "d4", triggerKind: "brand_new_trigger", triggerReason: "未来才有的原因", decision: "brand_new_decision", blockedReason: "brand_new_reason", autonomy: null, model: null, messageId: null, createdAt: "2026-09-17T06:30:00.000Z", detail: {} },
];

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function installApi() {
  globalThis.fetch = async (input) => {
    const path = String(input).split("?")[0];
    if (path.endsWith("/api/proactive/settings")) return json({ policy: POLICY, eligibility: [{ characterId: "char-1", characterName: "Aria", decision: { allowed: false, blockedReason: "quiet_hours" } }] });
    if (path.endsWith("/api/proactive/decisions")) return json({ items: DECISIONS });
    if (path.endsWith("/api/scheduler/status"))
      return json({
        runner: { running: true, intervalMs: 60000, ticks: 42, lastTickAt: "2026-09-17T06:31:00.000Z", lastError: null },
        jobs: JOBS.length,
        enabled: 3,
        failing: 1,
        nextJobs: JOBS.map((job) => ({ id: job.id, kind: job.kind, nextRunAt: job.nextRunAt, triggerType: job.triggerType, enabled: job.enabled })),
        lastExecution: null,
        pendingTasks: 2,
        failedTasks: 0,
      });
    if (path.endsWith("/api/scheduler/jobs")) return json({ items: JOBS });
    throw new Error("unexpected request: " + path);
  };
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mountPage(errors) {
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(ProactivePage, { characters: [CHARACTER], onError: (message) => errors.push(message) })); });
  await settle();
  return root;
}

function pageText() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

async function openAdvanced() {
  const box = [...dom.window.document.querySelectorAll("input[type=checkbox]")].find((node) => {
    const label = node.closest("label");
    return label !== null && (label.textContent ?? "").includes("高级");
  });
  assert.ok(box !== undefined, "应该有「高级：任务与执行记录」开关");
  await act(async () => { box.click(); });
  await settle();
}

test("普通界面（默认展开层）：调度相关文字全部是中文，内部枚举一个都不出现", async () => {
  installApi();
  const errors = [];
  const root = await mountPage(errors);
  assert.deepEqual(errors, [], "加载不应该报错");
  const text = pageText();
  assert.match(text, /调度器状态/);
  assert.match(text, /运行中/);
  assert.match(text, /任务总数：4/);
  // 中文任务名
  for (const chinese of ["定时消息", "主动消息", "事件维护", "未知任务类型"]) {
    assert.ok(text.includes(chinese), "普通界面要出现「" + chinese + "」");
  }
  // 中文触发方式
  for (const chinese of ["每天固定时间", "间隔重复", "一次性", "未知触发方式"]) {
    assert.ok(text.includes(chinese), "普通界面要出现「" + chinese + "」");
  }
  // 内部枚举绝不出现
  for (const raw of ["proactive_message", "scheduled_message", "event_maintenance", "brand_new_kind", "cron_like", "interval", "once", "idle", "not_eligible", "quiet_hours", "trigger_type", "undefined"]) {
    assert.equal(text.includes(raw), false, "普通界面不该出现内部值 " + raw);
  }
  await act(async () => { root.unmount(); });
});

test("未知枚举不崩、不出 undefined，只降级成中文占位", async () => {
  installApi();
  const errors = [];
  const root = await mountPage(errors);
  const text = pageText();
  assert.match(text, /未知任务类型/);
  assert.match(text, /未知触发方式/);
  assert.equal(text.includes("undefined"), false, "界面不能出现 undefined");
  assert.equal(text.includes("null"), false, "界面不能出现 null");
  assert.deepEqual(errors, [], "遇到不认识的枚举也不能报错");
  await act(async () => { root.unmount(); });
});

test("高级区：中文为主，原始值只出现在「开发者信息」里", async () => {
  installApi();
  const errors = [];
  const root = await mountPage(errors);
  await openAdvanced();
  const text = pageText();
  assert.match(text, /高级：任务与执行记录/);
  assert.match(text, /类型：每天固定时间/);
  assert.match(text, /每天 22:00 执行/);
  assert.match(text, /上次执行：/);
  assert.match(text, /启用|停用/);
  assert.match(text, /立即执行一次/);
  assert.match(text, /开发者信息：任务类型 proactive_message/);
  assert.match(text, /执行记录/);
  assert.match(text, /已发送/);
  assert.match(text, /现在没有合适的理由/);
  assert.match(text, /处于静音时段/);
  assert.match(text, /隔了一段时间没说话/);
  assert.match(text, /未知结果/);
  // 原始值只允许出现在「开发者信息」段落里：把那段挖掉后再查一遍
  const withoutDevInfo = [...dom.window.document.querySelectorAll("p.hint")]
    .filter((node) => (node.textContent ?? "").startsWith("开发者信息"))
    .reduce((acc, node) => acc.replace(node.textContent ?? "", ""), text);
  for (const raw of ["proactive_message", "scheduled_message", "event_maintenance", "cron_like", "not_eligible", "quiet_hours"]) {
    assert.equal(withoutDevInfo.includes(raw), false, "除开发者信息外不该出现 " + raw);
  }
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

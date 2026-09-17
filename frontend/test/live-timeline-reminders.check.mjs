// 真机检查：用运行中的后端真实数据渲染「事件与任务」页，确认定时提醒在里面。只允许 GET。
import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { JSDOM } from "jsdom";

const BASE = process.env.COMPANION_API ?? "http://127.0.0.1:8787";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement], ["HTMLInputElement", dom.window.HTMLInputElement],
  ["HTMLSelectElement", dom.window.HTMLSelectElement], ["Event", dom.window.Event], ["MouseEvent", dom.window.MouseEvent],
  ["confirm", () => { throw new Error("真机检查不允许点删除"); }],
]) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource { constructor() {} addEventListener() {} removeEventListener() {} close() {} }
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};
dom.window.confirm = () => { throw new Error("真机检查不允许点删除"); };

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const method = ((init ?? {}).method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("真机检查只允许 GET，收到了 " + method);
  return realFetch(String(input).startsWith("http") ? String(input) : BASE + String(input), init);
};

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { TimelinePage } = await import("../src/pages/timeline.tsx");

const characters = (await (await realFetch(BASE + "/api/characters")).json()).items;
const jobs = (await (await realFetch(BASE + "/api/scheduler/jobs")).json()).items;
console.log("后端实际调度任务：" + jobs.length + " 条（其中定时提醒 " + jobs.filter((j) => j.kind === "scheduled_message").length + " 条）");

const container = dom.window.document.getElementById("root");
const errors = [];
const root = createRoot(container);
await act(async () => { root.render(React.createElement(TimelinePage, { characters, onError: (m) => errors.push(m) })); });
for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();
const cards = [...container.querySelectorAll(".cards li")];
console.log("页面分区：" + ["事件（", "任务（", "定时提醒（"].map((k) => k + (text.includes(k) ? "有" : "无")).join("  "));
const reminderCards = cards.filter((card) => [...card.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("删除")));
console.log("卡片总数=" + cards.length);
console.log("页面文字节选：");
console.log("  " + text.slice(text.indexOf("定时提醒（"), text.indexOf("定时提醒（") + 700));
for (const raw of ["scheduled_message", "proactive_message", "event_maintenance", "cron_like", "interval", "once", "idle", "undefined"]) {
  if (text.includes(raw)) console.log("  ⚠ 页面出现内部值：" + raw);
}
console.log("页面报错：" + (errors.length === 0 ? "无" : errors.join(" | ")));
await act(async () => { root.unmount(); });
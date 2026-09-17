// 真机检查：用运行中的后端真实数据渲染「事件与任务」页，看按角色分组是否正确。只允许 GET。
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

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const method = ((init ?? {}).method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("真机检查只允许 GET");
  return realFetch(String(input).startsWith("http") ? String(input) : BASE + String(input), init);
};

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { TimelinePage } = await import("../src/pages/timeline.tsx");

const characters = (await (await realFetch(BASE + "/api/characters")).json()).items;
const events = (await (await realFetch(BASE + "/api/events")).json()).items;
const tasks = (await (await realFetch(BASE + "/api/tasks")).json()).items;
const jobs = (await (await realFetch(BASE + "/api/scheduler/jobs")).json()).items.filter((job) => job.kind === "scheduled_message");

const nameOf = (id) => id === null || id === undefined ? "（无角色）" : (characters.find((c) => c.id === id)?.name ?? "已删除的角色");
console.log("后端真实数据：");
console.log("  角色：" + characters.map((c) => c.name).join(" / "));
console.log("  事件 " + events.length + " 条 → " + events.map((e) => nameOf(e.characterId)).join(", "));
console.log("  任务 " + tasks.length + " 条 → " + tasks.map((t) => nameOf(t.characterId)).join(", "));
console.log("  定时提醒 " + jobs.length + " 条 → 角色 " + [...new Set(jobs.map((j) => nameOf(j.characterId)))].join(", "));

const container = dom.window.document.getElementById("root");
const errors = [];
const root = createRoot(container);
await act(async () => { root.render(React.createElement(TimelinePage, { characters, onError: (m) => errors.push(m) })); });
for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

console.log("页面上出现的分组标题：");
for (const heading of [...container.querySelectorAll("h3")]) console.log("  " + (heading.textContent ?? "").trim());
const text = (container.textContent ?? "").replace(/\s+/g, " ");
console.log("筛选框：" + (text.match(/看谁的事[^）]*）/) ?? ["?"])[0]);
console.log("页面报错：" + (errors.length === 0 ? "无" : errors.join(" | ")));
await act(async () => { root.unmount(); });

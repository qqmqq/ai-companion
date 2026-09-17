// 真机检查：用**正在运行的后端**真实数据渲染「调度状态」页，扫描页面上出现的文字。
// 不属于 pnpm test（文件名不含 .test.），需要后端在 127.0.0.1:8787 上跑着。
import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { JSDOM } from "jsdom";

const BASE = process.env.COMPANION_API ?? "http://127.0.0.1:8787";

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
class FakeEventSource { constructor() {} addEventListener() {} removeEventListener() {} close() {} }
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};
dom.window.confirm = () => true;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(String(input).startsWith("http") ? String(input) : BASE + String(input), init);

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ProactivePage } = await import("../src/pages/proactive.tsx");

const characters = await (await realFetch(BASE + "/api/characters")).json();
const jobs = (await (await realFetch(BASE + "/api/scheduler/jobs")).json()).items;
console.log("真实任务：");
for (const job of jobs) console.log("  " + job.id + "  kind=" + job.kind + " trigger=" + job.triggerType + " enabled=" + job.enabled + " status=" + job.status);

const errors = [];
const container = dom.window.document.getElementById("root");
const root = createRoot(container);
await act(async () => { root.render(React.createElement(ProactivePage, { characters: characters.items ?? [], onError: (message) => errors.push(message) })); });
for (let index = 0; index < 12; index += 1) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const normalText = container.textContent ?? "";
console.log("=== 普通界面（未展开高级）实际文字 ===");
console.log(normalText.replace(/\s+/g, " ").trim());

const box = [...container.querySelectorAll("input[type=checkbox]")].find((node) => ((node.closest("label")?.textContent) ?? "").includes("高级"));
await act(async () => { box.click(); });
for (let index = 0; index < 8; index += 1) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const advancedText = container.textContent ?? "";
console.log("=== 高级区实际文字 ===");
console.log(advancedText.replace(/\s+/g, " ").trim());

const RAW = ["scheduled_message", "proactive_message", "event_maintenance", "task_runner", "cron_like", "interval", "once", "idle_check", "scheduled_window", "not_eligible", "quiet_hours", "daily_limit", "cooldown", "undefined"];
const leakedNormal = RAW.filter((raw) => normalText.includes(raw));
const rest = [...container.querySelectorAll("p.hint")]
  .filter((node) => (node.textContent ?? "").startsWith("开发者信息"))
  .reduce((acc, node) => acc.replace(node.textContent ?? "", ""), advancedText);
const leakedAdvanced = RAW.filter((raw) => rest.includes(raw));

console.log("=== 结论 ===");
console.log("普通界面里的内部枚举：" + (leakedNormal.length === 0 ? "无" : leakedNormal.join(", ")));
console.log("高级区（去掉开发者信息行）里的内部枚举：" + (leakedAdvanced.length === 0 ? "无" : leakedAdvanced.join(", ")));
console.log("页面报错：" + (errors.length === 0 ? "无" : errors.join(" | ")));
console.log("页面出现 undefined：" + (normalText.includes("undefined") || advancedText.includes("undefined")));
await act(async () => { root.unmount(); });
if (leakedNormal.length > 0 || leakedAdvanced.length > 0 || errors.length > 0) process.exitCode = 1;

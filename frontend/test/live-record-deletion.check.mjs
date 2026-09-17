// 真机检查：用运行中的后端真实数据渲染「关系与情绪」「事件与任务」两页，
// 检查每条记录是否都有删除按钮。**不点击**任何删除按钮（那是真实数据）。
import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { JSDOM } from "jsdom";

const BASE = process.env.COMPANION_API ?? "http://127.0.0.1:8787";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement], ["HTMLInputElement", dom.window.HTMLInputElement],
  ["Event", dom.window.Event], ["MouseEvent", dom.window.MouseEvent], ["confirm", () => true],
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
const { RelationshipPage } = await import("../src/pages/relationship.tsx");
const { TimelinePage } = await import("../src/pages/timeline.tsx");

const characters = (await (await realFetch(BASE + "/api/characters")).json()).items;
const container = dom.window.document.getElementById("root");

async function mount(element) {
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  for (let index = 0; index < 12; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return root;
}

function report(pageName) {
  const cards = [...container.querySelectorAll(".cards li")];
  console.log("=== " + pageName + "：共 " + cards.length + " 张记录卡 ===");
  let withDelete = 0;
  for (const card of cards) {
    const label = (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const del = [...card.querySelectorAll("button")].filter((node) => (node.textContent ?? "").includes("删除"));
    if (del.length > 0) withDelete += 1;
    console.log("  " + (del.length > 0 ? "[有删除]" : "[无删除]") + " " + label);
  }
  console.log("  -> " + withDelete + " / " + cards.length + " 张卡有删除按钮");
  return { cards: cards.length, withDelete };
}

const errors = [];
const relationshipRoot = await mount(React.createElement(RelationshipPage, { characters, onError: (message) => errors.push(message) }));
const relationship = report("关系与情绪");
await act(async () => { relationshipRoot.unmount(); });

const timelineRoot = await mount(React.createElement(TimelinePage, { characters, onError: (message) => errors.push(message) }));
const timeline = report("事件与任务");
await act(async () => { timelineRoot.unmount(); });

console.log("页面报错：" + (errors.length === 0 ? "无" : errors.join(" | ")));
if (relationship.cards !== relationship.withDelete || timeline.cards !== timeline.withDelete || errors.length > 0) process.exitCode = 1;

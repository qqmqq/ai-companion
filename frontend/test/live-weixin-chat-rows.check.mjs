// 真机检查：用运行中的后端真实数据渲染「微信」页，看同一个联系人是不是只出现一行。只允许 GET。
import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { JSDOM } from "jsdom";

const BASE = process.env.COMPANION_API ?? "http://127.0.0.1:8787";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement], ["HTMLInputElement", dom.window.HTMLInputElement],
  ["HTMLSelectElement", dom.window.HTMLSelectElement], ["Event", dom.window.Event], ["MouseEvent", dom.window.MouseEvent],
  ["confirm", () => { throw new Error("真机检查不允许点任何写操作"); }],
]) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource { constructor() {} addEventListener() {} removeEventListener() {} close() {} }
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const method = ((init ?? {}).method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("真机检查只允许 GET，收到 " + method);
  return realFetch(String(input).startsWith("http") ? String(input) : BASE + String(input), init);
};

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { WeixinPage } = await import("../src/pages/weixin.tsx");

const characters = (await (await realFetch(BASE + "/api/characters")).json()).items;
const conversations = (await (await realFetch(BASE + "/api/conversations")).json()).items.filter((item) => item.channel === "weixin");
console.log("后端真实数据：微信会话 " + conversations.length + " 条");
const byRef = new Map();
for (const conversation of conversations) byRef.set(conversation.conversationRef, (byRef.get(conversation.conversationRef) ?? 0) + 1);
console.log("  按会话引用分组：" + [...byRef.entries()].map(([ref, count]) => String(ref).slice(0, 10) + "…×" + count).join(", "));

const container = dom.window.document.getElementById("root");
const errors = [];
const root = createRoot(container);
await act(async () => { root.render(React.createElement(WeixinPage, { characters, onError: (m) => errors.push(m) })); });
for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const rows = [...container.querySelectorAll(".cards li")].filter((li) => li.querySelector("select") !== null);
console.log("页面上「在跟谁聊」的行数：" + rows.length + "（会话 " + conversations.length + " 条，行数应 = 去重后的聊天数 " + byRef.size + "）");
for (const row of rows) console.log("  " + (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120));
console.log("页面报错：" + (errors.length === 0 ? "无" : errors.join(" | ")));
await act(async () => { root.unmount(); });
if (rows.length !== byRef.size) process.exitCode = 1;

// 真机检查：用运行中的后端真实数据渲染「角色」页，确认对话提示词的编辑器
// 确实在角色页、且读得到这个角色自己那份与全局默认那份。**只读**：不发 PUT。
import { register } from "node:module";
register("./tsx-hooks.mjs", import.meta.url);
import { JSDOM } from "jsdom";

const BASE = process.env.COMPANION_API ?? "http://127.0.0.1:8787";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:5173/" });
for (const [key, value] of [
  ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
  ["HTMLElement", dom.window.HTMLElement], ["HTMLInputElement", dom.window.HTMLInputElement],
  ["HTMLTextAreaElement", dom.window.HTMLTextAreaElement], ["HTMLSelectElement", dom.window.HTMLSelectElement],
  ["Event", dom.window.Event], ["MouseEvent", dom.window.MouseEvent],
]) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource { constructor() {} addEventListener() {} removeEventListener() {} close() {} }
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
dom.window.Element.prototype.scrollTo = () => {};
dom.window.confirm = () => { throw new Error("真机检查不允许删除任何东西"); };

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const method = ((init ?? {}).method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("真机检查只允许 GET，收到了 " + method);
  return realFetch(String(input).startsWith("http") ? String(input) : BASE + String(input), init);
};

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { CharactersPage } = await import("../src/pages/characters.tsx");
const { SettingsPage } = await import("../src/pages/settings.tsx");

const characters = (await (await realFetch(BASE + "/api/characters")).json()).items;
const globalPrompt = (await (await realFetch(BASE + "/api/context/prompt")).json()).custom;
const container = dom.window.document.getElementById("root");
const errors = [];

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function mount(element) {
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
  return root;
}

async function clickCard(node, label) {
  const button = [...node.querySelectorAll("button")].find((entry) => (entry.textContent ?? "").includes(label));
  if (button === undefined) throw new Error("找不到按钮：" + label);
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

let failures = 0;
function check(ok, label) {
  console.log((ok ? "  [通过] " : "  [失败] ") + label);
  if (!ok) failures += 1;
}

console.log("=== 角色页：对话提示词编辑器 ===");
const page = await mount(React.createElement(CharactersPage, {
  characters,
  onChanged: async () => {},
  onStartChat: async () => {},
  onError: (message) => errors.push(message),
}));

const defaultBox = container.querySelector(".prompt-default");
check(defaultBox !== null, "页面上有「默认对话提示词（所有角色通用）」");
if (defaultBox !== null) {
  const textarea = defaultBox.querySelector("textarea");
  check(textarea !== null && textarea.value === globalPrompt, "默认那份与后端一致（当前：" + JSON.stringify(globalPrompt) + "）");
}

for (const character of characters) {
  const card = [...container.querySelectorAll(".cards li")].find((entry) => (entry.textContent ?? "").includes(character.name));
  if (card === undefined) { check(false, "找不到角色卡：" + character.name); continue; }
  await clickCard(card, "编辑");
  const editor = card.querySelector(".prompt-editor");
  check(editor !== null, "「" + character.name + "」的编辑区里有对话提示词输入框");
  if (editor === null) continue;
  const own = (await (await realFetch(BASE + "/api/characters/" + character.id + "/prompt")).json()).prompt;
  const textarea = editor.querySelector("textarea");
  check(textarea.value === own, "读出来的内容与接口一致（当前：" + JSON.stringify(own) + "）");
  const shown = (editor.textContent ?? "").replace(/\s+/g, " ");
  if (own.length === 0 && globalPrompt.length > 0) check(shown.includes("当前用的是默认"), "留空时明说现在用的是默认那份");
  if (own.length === 0 && globalPrompt.length === 0) check(textarea.placeholder.length > 0, "两份都空时给出示例占位文字，不留一个空框");
  console.log("     页面上写着：" + shown.slice(0, 120));
  await clickCard(card, "收起编辑");
}

await act(async () => { page.unmount(); });

console.log("=== 模型设置页：编辑器确实搬走了 ===");
const settings = await mount(React.createElement(SettingsPage, { onError: (message) => errors.push(message) }));
check(container.querySelector("textarea") === null, "设置页不再有提示词输入框");
check((container.textContent ?? "").includes("已经挪到「角色」页"), "并写清它去哪了");
await act(async () => { settings.unmount(); });

console.log("页面报错：" + (errors.length === 0 ? "无" : errors.join(" | ")));
if (failures > 0 || errors.length > 0) process.exitCode = 1;

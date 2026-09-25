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
  ["HTMLTextAreaElement", dom.window.HTMLTextAreaElement],
  ["HTMLSelectElement", dom.window.HTMLSelectElement],
  ["Event", dom.window.Event],
  ["MouseEvent", dom.window.MouseEvent],
  ["FocusEvent", dom.window.FocusEvent],
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
const { CharactersPage } = await import("../src/pages/characters.tsx");

/**
 * 界面改动的真实检查：角色表单里「名字为空」这一条规则。
 * 断言的是行为（先碰过再报错、报错连到字段、填上就消失），不是文案本身。
 */

const EXISTING = {
  id: "char-1",
  name: "Aria",
  slug: "aria",
  avatarMediaId: null,
  versionCount: 1,
  definition: { name: "Aria", description: "旧书店的店主", personality: "话少", scenario: "小城", systemPrompt: "", firstMessage: "来了。" },
  state: { emotion: { primary: "neutral", intensity: 0.2 }, activity: { label: "待机" }, location: { label: "房间" }, energy: 0.8, autonomyLevel: "normal" },
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function installApi() {
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/context/prompt") && method === "GET") return json({ prompt: "", fallback: "" });
    if (path.endsWith("/prompt") && method === "GET") return json({ prompt: "", fallback: "" });
    if (path.endsWith("/api/characters") && method === "GET") return json({ characters: [EXISTING] });
    throw new Error("unexpected request: " + method + " " + path);
  };
}

let sharedRoot = null;
async function mount() {
  const container = dom.window.document.getElementById("root");
  // 同一个容器只能 createRoot 一次，否则 React 会警告并丢掉旧的树
  sharedRoot = sharedRoot ?? createRoot(container);
  const root = sharedRoot;
  await act(async () => {
    root.render(
      React.createElement(CharactersPage, {
        characters: [EXISTING],
        onChanged: async () => {},
        onStartChat: async () => {},
        onError: () => {},
      }),
    );
  });
  return container;
}

function findButton(container, label) {
  return [...container.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === label) ?? null;
}

test("名字为空时：不是一打开就报错，离开字段后才提示，并且提示连在字段上", async () => {
  installApi();
  const container = await mount();

  await act(async () => {
    findButton(container, "新建角色")?.click();
  });
  const nameInput = [...container.querySelectorAll("input")].find((node) => node.placeholder === "例如：Aria");
  assert.ok(nameInput, "表单里应该有角色名称输入框");
  assert.equal(container.querySelector(".field-error"), null, "还没碰过就不该红");

  // React 的 onBlur 走 focusout 委托：直接派发 blur 是抓不到的
  await act(async () => {
    nameInput.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
  const error = container.querySelector(".field-error");
  assert.ok(error, "碰过且为空应该给出错误");
  assert.equal(nameInput.getAttribute("aria-invalid"), "true");
  assert.equal(nameInput.getAttribute("aria-describedby"), error.id, "错误文字要能被读屏器关联到字段");
  assert.equal(error.id, "character-name-error");
});

test("填上名字后：错误消失，提交按钮恢复可用", async () => {
  installApi();
  const container = await mount();
  await act(async () => {
    findButton(container, "新建角色")?.click();
  });
  const nameInput = [...container.querySelectorAll("input")].find((node) => node.placeholder === "例如：Aria");
  // React 的 onBlur 走 focusout 委托：直接派发 blur 是抓不到的
  await act(async () => {
    nameInput.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
  assert.ok(container.querySelector(".field-error"), "先确认错误出现过");

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(nameInput, "小满");
    nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(container.querySelector(".field-error"), null, "填上名字后错误应该消失");
  assert.equal(nameInput.getAttribute("aria-invalid"), "false");

  const submit = findButton(container, "创建角色");
  assert.ok(submit, "应该有提交按钮");
  assert.equal(submit.disabled, false, "名字有了就允许提交");
});

test("样式表里：可操作控件的边框有专门令牌，不是靠装饰线凑", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /--line-control:\s*#[0-9a-f]{6}/i, "控件边框要有自己的令牌");
  assert.match(css, /border: 1px solid var\(--line-control\)/, "表单控件用控件令牌");
  assert.match(css, /\.field-error/, "表单错误要有样式");
  assert.match(css, /prefers-reduced-motion/, "要尊重系统的减少动效设置");
  assert.match(css, /:focus-visible/, "键盘焦点要看得见");
});

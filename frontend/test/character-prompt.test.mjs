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
Object.defineProperty(globalThis, "confirm", { value: dom.window.confirm, configurable: true, writable: true });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { CharactersPage } = await import("../src/pages/characters.tsx");

const CHARACTER = {
  id: "char-1",
  name: "小满",
  slug: "xiaoman",
  avatarMediaId: null,
  versionCount: 1,
  definition: {
    name: "小满",
    description: "住在隔壁的人",
    personality: "话多，爱笑",
    scenario: "老城区的出租屋",
    systemPrompt: "",
    firstMessage: "回来啦？",
  },
  state: { emotion: { primary: "neutral", intensity: 0.2 }, activity: { label: "待机" }, location: { label: "房间" }, energy: 0.8, autonomyLevel: "normal" },
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 假后端：只管两处提示词（全局默认 + 某个角色的），别的请求一律当作 bug */
function installApi(options = {}) {
  const state = {
    defaultPrompt: options.defaultPrompt ?? "",
    characterPrompt: options.characterPrompt ?? "",
    defaultSaved: null,
    characterSaved: null,
    calls: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? null : JSON.parse(String(init.body));
    state.calls.push(method + " " + path);
    if (path.endsWith("/api/context/prompt")) {
      if (method === "PUT") {
        state.defaultSaved = body.custom;
        state.defaultPrompt = String(body.custom).trim();
        return json({ custom: state.defaultPrompt });
      }
      return json({ custom: state.defaultPrompt, appliesTo: "系统约束（对所有角色生效）" });
    }
    if (path.endsWith("/api/characters/" + CHARACTER.id + "/prompt")) {
      if (method === "PUT") {
        state.characterSaved = body.prompt;
        state.characterPrompt = String(body.prompt).trim();
        return json({ prompt: state.characterPrompt });
      }
      return json({ prompt: state.characterPrompt, fallback: state.defaultPrompt });
    }
    throw new Error("unexpected request: " + method + " " + path);
  };
  return state;
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function setValue(node, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

async function click(node) {
  assert.ok(node !== undefined && node !== null, "要点的东西不存在");
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function scopedButton(scope, label) {
  const found = [...scope.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes(label));
  assert.ok(found !== undefined, "在这个区域里应该有按钮：" + label);
  return found;
}

async function mount() {
  const errors = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(CharactersPage, {
        characters: [CHARACTER],
        onChanged: async () => {},
        onStartChat: async () => {},
        onError: (message) => errors.push(message),
      }),
    );
  });
  await settle();
  return { root, errors };
}

/** 展开某个角色的「编辑」区，拿到那块提示词编辑器 */
async function openCharacterEditor() {
  const card = dom.window.document.querySelector(".cards li");
  assert.ok(card !== null, "应该有角色卡片");
  await click(scopedButton(card, "编辑"));
  const editor = dom.window.document.querySelector(".prompt-editor");
  assert.ok(editor !== null, "角色编辑区里应该有对话提示词");
  return editor;
}

test("默认对话提示词：挂载时读出来，改完保存有确认", async () => {
  const state = installApi({ defaultPrompt: "别用感叹号。" });
  const { root, errors } = await mount();

  const box = dom.window.document.querySelector(".prompt-default");
  assert.ok(box !== null, "角色页上应该有「默认对话提示词」");
  assert.match(text(), /默认对话提示词（所有角色通用）/);

  const textarea = box.querySelector("textarea");
  assert.equal(textarea.value, "别用感叹号。", "挂载时要把已保存的默认读出来");

  setValue(textarea, "说话短一点。");
  await settle(2);
  await click(scopedButton(box, "保存默认"));

  assert.equal(state.defaultSaved, "说话短一点。", "保存要把内容发给后端");
  assert.match(text(), /已保存，下一句起生效/);
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("角色专属提示词：读出来能改，保存后下一句起生效", async () => {
  const state = installApi({ defaultPrompt: "默认：短句。", characterPrompt: "小满会叫我名字。" });
  const { root, errors } = await mount();
  const editor = await openCharacterEditor();

  const textarea = editor.querySelector("textarea");
  assert.equal(textarea.value, "小满会叫我名字。", "挂载时要把这个角色自己那份读出来");

  setValue(textarea, "叫我名字，别叫先生。");
  await settle(2);
  await click(scopedButton(editor, "保存对话提示词"));

  assert.equal(state.characterSaved, "叫我名字，别叫先生。", "保存要发给这个角色的接口");
  assert.match(text(), /已保存，后一句起生效/);
  assert.equal(state.defaultSaved, null, "改角色那份不该动到默认那份");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("角色没写自己的那份时：界面说清现在用的是默认，清空等于改回用默认", async () => {
  const state = installApi({ defaultPrompt: "默认：短句。", characterPrompt: "" });
  const { root, errors } = await mount();
  const editor = await openCharacterEditor();

  const textarea = editor.querySelector("textarea");
  assert.equal(textarea.value, "", "没写过就是空的");
  assert.match(editor.textContent ?? "", /当前用的是默认：默认：短句。/);

  setValue(textarea, "先写一句。");
  await settle(2);
  await click(scopedButton(editor, "保存对话提示词"));
  assert.equal(state.characterSaved, "先写一句。");

  await click(scopedButton(editor, "清空，改回用默认"));
  assert.equal(state.characterSaved, "", "清空就是把覆盖取消（发空串）");
  assert.match(text(), /已清空，改回用默认。/);
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

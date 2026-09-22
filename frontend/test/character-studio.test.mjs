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

const V1 = {
  name: "沈砚",
  description: "旧书店的店主",
  personality: "话不多，句子短",
  scenario: "南方小城的旧书店",
  systemPrompt: "保持克制的语气。",
  firstMessage: "来了。",
};
const V2 = { ...V1, personality: "冷淡，回应极短，很少主动开口" };
const V3 = { ...V2, scenario: "现代都市，深夜的连锁便利店" };

const EXISTING = {
  id: "char-1",
  name: "Aria",
  slug: "aria",
  avatarMediaId: null,
  versionCount: 2,
  definition: { ...V1, name: "Aria" },
  state: { emotion: { primary: "neutral", intensity: 0.2 }, activity: { label: "待机" }, location: { label: "房间" }, energy: 0.8, autonomyLevel: "normal" },
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function installApi() {
  const state = { calls: [], savedBody: null, patched: null, conversations: [] };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? null : JSON.parse(String(init.body));
    state.calls.push(method + " " + path);
    if (path.endsWith("/api/characters/draft") && method === "POST") {
      state.draftBody = body;
      return json({ definition: V1, reply: "我把性格写成了话少、句子短。", changes: [] });
    }
    if (path.endsWith("/api/characters/revise") && method === "POST") {
      state.reviseBody = body;
      state.reviseCalls = (state.reviseCalls ?? 0) + 1;
      // 按用户这句话决定改哪一处，而不是按下标：工坊支持来回改很多轮
      const wantsCity = String(body.instruction).includes("现代都市");
      const next = wantsCity ? V3 : V2;
      const changes = wantsCity
        ? [{ field: "scenario", label: "背景 / 场景", before: V2.scenario, after: V3.scenario }]
        : [{ field: "personality", label: "性格", before: V1.personality, after: V2.personality }];
      return json({ definition: next, reply: wantsCity ? "背景换成了现代都市。" : "我把性格改冷了。", changes });
    }
    if (path.endsWith("/api/characters") && method === "POST") {
      state.savedBody = body;
      return json({ ...EXISTING, id: "char-new", name: body.name, versionCount: 1 }, 201);
    }
    if (/\/api\/characters\/[^/]+$/.test(path) && method === "PATCH") {
      state.patched = { id: path.split("/").pop(), body };
      return json({ ...EXISTING, definition: body, versionCount: 3 });
    }
    if (path.endsWith("/api/conversations") && method === "POST") {
      state.conversations.push(body);
      return json({ id: "conv-new", characterId: body.characterId, title: "新会话", source: "web", channel: "web", lastMessageAt: null, lastMessageText: "", characterVersionId: "v3" }, 201);
    }
    // 角色页现在一挂载就读「默认提示词」与该角色的提示词（编辑器搬过来了）
    if (path.endsWith("/api/context/prompt")) return json({ custom: state.defaultPrompt ?? "", appliesTo: "系统约束（对所有角色生效）" });
    if (path.endsWith("/api/characters/" + EXISTING.id + "/prompt")) {
      return json({ prompt: state.characterPrompt ?? "", fallback: state.defaultPrompt ?? "" });
    }
    if (path.endsWith("/api/characters") && method === "GET") return json({ items: [EXISTING] });
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
  const proto = node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}

async function click(node) {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
}

function text() {
  return dom.window.document.getElementById("root").textContent ?? "";
}

function button(label) {
  const found = [...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes(label));
  assert.ok(found !== undefined, "应该有按钮：" + label);
  return found;
}

function textAreaValue() {
  return [...dom.window.document.querySelectorAll("textarea")].map((node) => node.value).join(" | ");
}

async function mount(state) {
  const errors = [];
  const started = [];
  const container = dom.window.document.getElementById("root");
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(CharactersPage, {
        characters: [EXISTING],
        onChanged: async () => {},
        onStartChat: async (character, options) => { started.push({ id: character.id, options: options ?? null }); },
        onError: (message) => errors.push(message),
      }),
    );
  });
  await settle();
  return { root, errors, started };
}

test("角色工坊：设想 → AI 补全 → 一句人话修改 → 确认才落库", async () => {
  const state = installApi();
  const { root, errors } = await mount(state);

  await click(button("角色工坊"));
  const ideas = [...dom.window.document.querySelectorAll("textarea")][0];
  setValue(ideas, "一个开旧书店的人，说话很少");
  await settle(2);
  await click(button("让 AI 补全"));

  assert.equal(state.draftBody.ideas, "一个开旧书店的人，说话很少", "设想要原样发给后端");
  assert.match(text(), /我把性格写成了话少、句子短/, "AI 的说明要显示出来");
  assert.match(textAreaValue(), /话不多，句子短/, "补全出来的完整设定要出现在可编辑的表单里");
  assert.equal(state.savedBody, null, "AI 补全还不该存库");

  // 用户看了之后提要求
  const instruction = [...dom.window.document.querySelectorAll("input")].find((node) => (node.placeholder ?? "").includes("接着说要求"));
  assert.ok(instruction !== undefined, "要有说要求的输入框");
  setValue(instruction, "性格再冷一点");
  await settle(2);
  await click(button("让 AI 改"));

  assert.equal(state.reviseBody.instruction, "性格再冷一点");
  assert.equal(state.reviseBody.definition.personality, V1.personality, "改的时候要带上现在这一版");
  assert.match(text(), /这次改了什么/);
  assert.match(text(), /改前：话不多，句子短/);
  assert.match(text(), /改后：冷淡，回应极短，很少主动开口/);
  assert.equal(state.savedBody, null, "AI 提出修改结果还是不该存库");
  assert.match(textAreaValue(), /冷淡，回应极短/, "表单里已经换成改完的设定");

  // 确认
  await click(button("确认，存成新角色"));
  assert.equal(state.savedBody.personality, V2.personality, "确认时存的是改完的设定");
  assert.equal(state.savedBody.name, "沈砚");
  assert.match(text(), /已存成新角色/);
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("改已有角色：确认走 PATCH（新版本），并说明旧会话继续用旧版本", async () => {
  const state = installApi();
  const { root, errors } = await mount(state);

  await click(button("角色工坊"));
  const select = dom.window.document.querySelector("select");
  assert.ok(select !== undefined, "要有保存目标选择框");
  setValue(select, "char-1");
  await settle(3);

  assert.match(textAreaValue(), /话不多，句子短/, "选了已有角色就先载入他现在的设定");

  const instruction = [...dom.window.document.querySelectorAll("input")].find((node) => (node.placeholder ?? "").includes("接着说要求"));
  setValue(instruction, "把背景改成现代都市");
  await settle(2);
  await click(button("让 AI 改"));
  await click(button("确认，保存为新版本"));

  assert.equal(state.patched.id, "char-1");
  assert.equal(state.patched.body.scenario, V3.scenario);
  assert.match(text(), /已有的会话继续用旧版本/, "要明确告诉用户旧会话不变");
  assert.match(text(), /想用新版请开一个新会话/, "并且告诉他怎么才能用上新版本");
  assert.deepEqual(errors, []);
  await act(async () => { root.unmount(); });
});

test("参数被后端拒绝时，界面把真实原因说出来（不再只显示「请求参数不合法」）", async () => {
  const state = installApi();
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path.endsWith("/api/characters/draft") && method === "POST") {
      return new Response(
        JSON.stringify({ error: { code: "invalid_input", message: "请求参数不合法：ideas 最多 2000 个字", details: { issues: [{ path: "ideas", message: "ideas 最多 2000 个字" }] } } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    // 角色页现在一挂载就读「默认提示词」与该角色的提示词（编辑器搬过来了）
    if (path.endsWith("/api/context/prompt")) return json({ custom: state.defaultPrompt ?? "", appliesTo: "系统约束（对所有角色生效）" });
    if (path.endsWith("/api/characters/" + EXISTING.id + "/prompt")) {
      return json({ prompt: state.characterPrompt ?? "", fallback: state.defaultPrompt ?? "" });
    }
    if (path.endsWith("/api/characters") && method === "GET") return json({ items: [EXISTING] });
    throw new Error("unexpected request: " + method + " " + path);
  };
  void state;

  const { root, errors } = await mount(state);
  await click(button("角色工坊"));
  const ideas = [...dom.window.document.querySelectorAll("textarea")][0];
  setValue(ideas, "一个开旧书店的人");
  await settle(2);
  await click(button("让 AI 补全"));

  assert.equal(errors.length, 1, "要把后端的拒绝告诉他");
  assert.match(errors[0], /设想最多 2000 个字/, "必须带上真正的原因，而且要是人话");
  assert.equal(errors[0].includes("ideas"), false, "界面上不该出现字段代码名");
  assert.notEqual(errors[0], "请求参数不合法", "不能只说一句请求参数不合法");
  await act(async () => { root.unmount(); });
});

test("输入框有上限、名字为空时不让 AI 改（从源头避免那次报错）", async () => {
  const state = installApi();
  const { root } = await mount(state);
  await click(button("角色工坊"));

  const ideas = [...dom.window.document.querySelectorAll("textarea")][0];
  assert.equal(ideas.maxLength, 2000, "设想框要有长度上限");
  assert.match(text(), /0 \/ 2000 字/, "要让用户看得到还能写多少");

  setValue(ideas, "一个开旧书店的人");
  await settle(2);
  await click(button("让 AI 补全"));

  // 把名字清空：定义里名字是必填，空名字提交必然被接口层拒，所以按钮要直接不可用
  const nameInput = [...dom.window.document.querySelectorAll("input")].find((node) => (node.placeholder ?? "").includes("Aria"));
  assert.ok(nameInput !== undefined, "要有角色名称输入框");
  setValue(nameInput, "");
  await settle(2);

  const reviseButton = button("让 AI 改");
  assert.equal(reviseButton.disabled, true, "名字为空时不能提交");
  assert.match(text(), /角色名称不能为空/, "并且要说明为什么");

  const instruction = [...dom.window.document.querySelectorAll("input")].find((node) => (node.placeholder ?? "").includes("接着说要求"));
  assert.equal(instruction.maxLength, 1000, "要求输入框也要有上限");
  await act(async () => { root.unmount(); });
});

test("改过版本的角色可以开一个用最新版本的新会话", async () => {
  const state = installApi();
  const { root, started } = await mount(state);

  // 页面把"开新会话"交给上层（app.tsx 调 api.createConversation），这里断言它转达得对
  const newSessionButton = button("用最新版本开新会话");
  await click(newSessionButton);
  assert.deepEqual(started, [{ id: "char-1", options: { newSession: true } }], "必须显式要求新会话，否则会回到旧会话继续用旧版本");
  assert.equal(state.conversations.length, 0, "页面本身不该直接建会话");
  await act(async () => { root.unmount(); });
});

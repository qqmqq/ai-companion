import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";

interface Ctx {
  baseUrl: string;
  container: Container;
  close: () => Promise<void>;
}

async function setup(fetchImpl?: typeof fetch): Promise<Ctx> {
  const server = await createRunningServer(fetchImpl === undefined ? {} : { fetchImpl });
  return { baseUrl: server.baseUrl, container: server.container, close: server.close };
}

function post(ctx: Ctx, path: string, body: unknown): Promise<Response> {
  return fetch(ctx.baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function put(ctx: Ctx, path: string, body: unknown): Promise<Response> {
  return fetch(ctx.baseUrl + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function addProvider(ctx: Ctx, input: { id: string; kind: string; baseUrl: string; defaultModel: string }): Promise<void> {
  const response = await post(ctx, "/api/providers", {
    id: input.id,
    kind: input.kind,
    displayName: input.id,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    requiresCredential: false,
  });
  assert.ok(response.status === 201 || response.status === 200, "provider 配置应写入成功");
}

async function sendOneMessage(ctx: Ctx): Promise<void> {
  const character = await post(ctx, "/api/characters", {
    name: "模型测试角色",
    description: "只用来验证模型选择",
    personality: "简短",
    scenario: "测试",
    systemPrompt: "",
    firstMessage: "在的。",
  });
  assert.equal(character.status, 201);
  const characterId = ((await character.json()) as { id: string }).id;
  const conversation = await post(ctx, "/api/conversations", { characterId });
  assert.equal(conversation.status, 201);
  const conversationId = ((await conversation.json()) as { id: string }).id;
  const sent = await post(ctx, "/api/conversations/" + conversationId + "/messages", { text: "你好" });
  assert.ok(sent.status === 200 || sent.status === 201, "消息应发送成功，实际 " + String(sent.status));
}

async function chatRequests(mock: { requests: Array<{ url: string; body: Record<string, unknown> }> }): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const chat = mock.requests.filter((request) => request.url.endsWith("/v1/chat/completions"));
    if (chat.length > 0) return chat.map((request) => request.body);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

interface RoutingItem {
  taskType: string;
  configured: { providerId: string | null; model: string | null } | null;
  resolved: { providerId: string; model: string };
}

async function routing(ctx: Ctx): Promise<RoutingItem[]> {
  const response = await fetch(ctx.baseUrl + "/api/model-routing");
  return ((await response.json()) as { items: RoutingItem[] }).items;
}

test("用户在界面上选的模型真的发给 Provider：A → B 两次请求，body.model 随之变化", async () => {
  const ctx = await setup();
  const mock = await startMockOpenAIServer();
  try {
    await addProvider(ctx, { id: "picker", kind: "openai-compatible", baseUrl: mock.baseUrl, defaultModel: "provider-default" });

    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "picker", model: "model-a" });
    await sendOneMessage(ctx);
    const first = await chatRequests(mock);
    assert.ok(first.length > 0, "应该真的发出了 chat 请求");
    assert.equal(first[first.length - 1]?.model, "model-a", "Provider 必须收到用户选的 model-a");

    mock.requests.length = 0;
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "picker", model: "model-b" });
    await sendOneMessage(ctx);
    const second = await chatRequests(mock);
    assert.ok(second.length > 0);
    assert.equal(second[second.length - 1]?.model, "model-b", "切换后 Provider 必须收到 model-b，而不是继续用旧值/默认值");
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("陈旧路由（指向已删除的 provider）不能劫持真实 Provider 的模型", async () => {
  const ctx = await setup();
  const mock = await startMockOpenAIServer();
  try {
    await addProvider(ctx, { id: "real", kind: "openai-compatible", baseUrl: mock.baseUrl, defaultModel: "deepseek-V4-flash" });
    // 真实事故现场：路由还指着已经不存在的 echo/echo-1
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "ghost", model: "echo-1" });

    const items = await routing(ctx);
    const chat = items.find((item) => item.taskType === "chat");
    assert.equal(chat?.resolved.providerId, "real");
    assert.equal(chat?.resolved.model, "deepseek-V4-flash", "解析结果必须是真实 provider 的模型");

    await sendOneMessage(ctx);
    const bodies = await chatRequests(mock);
    assert.ok(bodies.length > 0);
    assert.equal(bodies[bodies.length - 1]?.model, "deepseek-V4-flash", "绝不能把 echo-1 发给真实 API");
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("删除 Provider 会同时删掉指向它的路由（不再留下悬空路由）", async () => {
  const ctx = await setup();
  try {
    await addProvider(ctx, { id: "temp", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9", defaultModel: "temp-model" });
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "temp", model: "temp-model" });
    assert.equal((await routing(ctx)).find((item) => item.taskType === "chat")?.configured?.providerId, "temp");

    const removed = await fetch(ctx.baseUrl + "/api/providers/temp", { method: "DELETE" });
    assert.equal(removed.status, 204);
    const after = (await routing(ctx)).find((item) => item.taskType === "chat");
    assert.equal(after?.configured, null, "指向被删 provider 的路由必须一起消失");
    assert.notEqual(after?.resolved.providerId, "temp");
  } finally {
    await ctx.close();
  }
});

test("Ollama 模型发现：/api/tags 返回什么就展示什么，且不写死模型名", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "llama3" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const ctx = await setup(fetchImpl);
  try {
    await addProvider(ctx, { id: "local-ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", defaultModel: "qwen3:8b" });
    const response = await fetch(ctx.baseUrl + "/api/models");
    const items = ((await response.json()) as { items: Array<{ providerId: string; models: Array<{ id: string }>; error: string | null }> }).items;
    const ollama = items.find((item) => item.providerId === "local-ollama");
    assert.ok(ollama !== undefined);
    assert.equal(ollama.error, null);
    assert.deepEqual(ollama.models.map((model) => model.id), ["qwen3:8b", "llama3"]);
    assert.ok(seen.some((url) => url.endsWith("/api/tags")), "必须打的是 Ollama 的 /api/tags");
  } finally {
    await ctx.close();
  }
});

test("模型发现失败时仍然可以手填模型，并且手填的值会真的发给 Provider", async () => {
  const mock = await startMockOpenAIServer();
  const realFetch = globalThis.fetch;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/models")) return new Response("models endpoint down", { status: 500 });
    return await realFetch(input, init);
  }) as typeof fetch;
  const ctx = await setup(fetchImpl);
  try {
    await addProvider(ctx, { id: "no-discovery", kind: "openai-compatible", baseUrl: mock.baseUrl, defaultModel: "provider-default" });

    const discovery = await fetch(ctx.baseUrl + "/api/models");
    const items = ((await discovery.json()) as { items: Array<{ providerId: string; models: unknown[]; error: string | null }> }).items;
    const entry = items.find((item) => item.providerId === "no-discovery");
    assert.ok(entry !== undefined);
    assert.equal(entry.models.length, 0);
    assert.ok(entry.error !== null, "发现失败要如实报告，而不是假装成功");

    // 列表取不到，但用户照样能手填模型
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "no-discovery", model: "hand-typed-model" });
    const persisted = (await routing(ctx)).find((item) => item.taskType === "chat");
    assert.equal(persisted?.configured?.model, "hand-typed-model");
    assert.equal(persisted?.resolved.model, "hand-typed-model");

    await sendOneMessage(ctx);
    const bodies = await chatRequests(mock);
    assert.ok(bodies.length > 0);
    assert.equal(bodies[bodies.length - 1]?.model, "hand-typed-model");
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("Provider 没密钥 / 被停用时，模型列表接口要说清怎么解决，而不是丢一句术语", async () => {
  const ctx = await setup();
  try {
    // 没密钥
    await post(ctx, "/api/providers", {
      id: "needs-key",
      kind: "openai-compatible",
      displayName: "需要密钥的",
      baseUrl: "http://127.0.0.1:22217",
      defaultModel: "m",
      requiresCredential: true,
    });
    const noKey = await (await post(ctx, "/api/providers/needs-key/test", {})).json() as { ok: boolean; error?: { kind?: string; message?: string } };
    assert.equal(noKey.ok, false);
    assert.match(noKey.error?.message ?? "", /还没有密钥/, "要告诉用户去哪儿补密钥：" + JSON.stringify(noKey));

    // 有密钥但被停用
    await post(ctx, "/api/providers", {
      id: "disabled-one",
      kind: "openai-compatible",
      displayName: "被停用的",
      baseUrl: "http://127.0.0.1:9",
      defaultModel: "m",
      requiresCredential: false,
      enabled: false,
    });
    const off = await (await post(ctx, "/api/providers/disabled-one/test", {})).json() as { ok: boolean; error?: { message?: string } };
    assert.equal(off.ok, false);
    assert.match(off.error?.message ?? "", /停用/, "要告诉用户它是停用的：" + JSON.stringify(off));

    // 不存在的 provider 也要说人话
    const missing = await (await post(ctx, "/api/providers/never-existed/test", {})).json() as { ok: boolean; error?: { message?: string } };
    assert.equal(missing.ok, false);
    assert.match(missing.error?.message ?? "", /没有这条 Provider/);
  } finally {
    await ctx.close();
  }
});

test("一个能用的模型都没有时：路由列表不报错，而是给出原因（真实踩过：整页 500）", async () => {
  const ctx = await setup();
  try {
    // 把内置占位模型也删掉，模拟"用户把 provider 全删了"
    const providers = ((await (await fetch(ctx.baseUrl + "/api/providers")).json()) as { items: Array<{ id: string }> }).items;
    assert.ok(providers.length > 0, "新库里应该有内置占位模型");
    for (const provider of providers) {
      const removed = await fetch(ctx.baseUrl + "/api/providers/" + provider.id, { method: "DELETE" });
      assert.equal(removed.status, 204);
    }

    const response = await fetch(ctx.baseUrl + "/api/model-routing");
    assert.equal(response.status, 200, "没有可用模型是可预期的状态，不该 500");
    const items = ((await response.json()) as { items: Array<{ taskType: string; resolved: unknown; unavailableReason: string | null }> }).items;
    const chat = items.find((item) => item.taskType === "chat");
    assert.equal(chat?.resolved, null);
    assert.match(chat?.unavailableReason ?? "", /还没有可用的模型/, "要告诉用户去配模型，而不是丢一句英文错误");
    for (const item of items) assert.equal(item.resolved, null);
  } finally {
    await ctx.close();
  }
});

test("配置是持久的：重新读一遍 API，Provider 与 Model 仍然是用户选的那套", async () => {
  const ctx = await setup();
  try {
    await addProvider(ctx, { id: "persisted", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9", defaultModel: "persisted-default" });
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "persisted", model: "persisted-model" });

    // 模拟"刷新页面"：重新从后端读配置（前端不做任何本地保存）
    const providersResponse = await fetch(ctx.baseUrl + "/api/providers");
    const providers = ((await providersResponse.json()) as { items: Array<{ id: string; defaultModel: string }> }).items;
    assert.equal(providers.find((provider) => provider.id === "persisted")?.defaultModel, "persisted-default");

    const chat = (await routing(ctx)).find((item) => item.taskType === "chat");
    assert.deepEqual(chat?.configured, { providerId: "persisted", model: "persisted-model" });
    assert.deepEqual(chat?.resolved, { providerId: "persisted", model: "persisted-model" });
  } finally {
    await ctx.close();
  }
});

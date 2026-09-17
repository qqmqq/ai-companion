import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";

const SECRET = "sk-secret-must-never-leak-123";

interface Ctx {
  baseUrl: string;
  container: Container;
  close: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const server = await createRunningServer();
  return { baseUrl: server.baseUrl, container: server.container, close: server.close };
}

async function post(ctx: Ctx, path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(ctx: Ctx, path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createCharacter(ctx: Ctx): Promise<string> {
  const response = await post(ctx, "/api/characters", {
    name: "Aria",
    description: "温柔的咖啡师",
    personality: "耐心",
    scenario: "小镇咖啡馆",
    systemPrompt: "",
    firstMessage: "欢迎回来。",
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}

async function createConversation(ctx: Ctx, characterId: string): Promise<string> {
  const response = await post(ctx, "/api/conversations", { characterId });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

test("provider config stores the key in the credential store and never leaks it", async () => {
  const ctx = await setup();
  const mock = await startMockOpenAIServer({ apiKey: SECRET });
  try {
    const created = await post(ctx, "/api/providers", {
      id: "mock-openai",
      kind: "openai-compatible",
      displayName: "Mock OpenAI",
      baseUrl: mock.baseUrl,
      defaultModel: "mock-chat",
      requiresCredential: true,
      apiKey: SECRET,
    });
    assert.equal(created.status, 201);
    const createdText = await created.text();
    assert.doesNotMatch(createdText, new RegExp(SECRET), "API Key 绝不能出现在响应里");
    assert.equal((JSON.parse(createdText) as { hasCredential: boolean }).hasCredential, true);

    const list = await fetch(`${ctx.baseUrl}/api/providers`);
    const listText = await list.text();
    assert.doesNotMatch(listText, new RegExp(SECRET));
    assert.match(listText, /mock-openai/);

    // 数据库里只有密文
    const row = ctx.container.repos.credentials.get("mock-openai");
    assert.ok(row !== null);
    assert.doesNotMatch(JSON.stringify(row), new RegExp(SECRET));

    // 真实 HTTP 连通性测试（走凭证解密 + /v1/models）
    const testResult = await post(ctx, "/api/providers/mock-openai/test", {});
    const tested = (await testResult.json()) as { ok: boolean; models: Array<{ id: string }> };
    assert.equal(tested.ok, true);
    assert.ok(tested.models.some((model) => model.id === "mock-chat"));
    const modelsCall = mock.requests.find((r) => r.url.endsWith("/v1/models"));
    assert.equal(modelsCall?.authorization, `Bearer ${SECRET}`, "真实 provider 必须带上解密后的密钥");
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("model routing decides which provider+model serves each task", async () => {
  const ctx = await setup();
  const mock = await startMockOpenAIServer();
  try {
    await post(ctx, "/api/providers", {
      id: "routed",
      kind: "openai-compatible",
      displayName: "Routed",
      baseUrl: mock.baseUrl,
      defaultModel: "mock-chat",
      requiresCredential: false,
    });
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "routed", model: "mock-chat" });
    await put(ctx, "/api/model-routing", { taskType: "memory_extraction", providerId: "routed", model: "mock-cheap" });
    await put(ctx, "/api/model-routing", { taskType: "summarization", providerId: "echo", model: "echo-1" });

    const response = await fetch(`${ctx.baseUrl}/api/model-routing`);
    const items = ((await response.json()) as { items: Array<{ taskType: string; resolved: { providerId: string; model: string } }> }).items;
    const chat = items.find((item) => item.taskType === "chat");
    const memory = items.find((item) => item.taskType === "memory_extraction");
    const summary = items.find((item) => item.taskType === "summarization");
    assert.deepEqual(chat?.resolved, { providerId: "routed", model: "mock-chat" });
    assert.deepEqual(memory?.resolved, { providerId: "routed", model: "mock-cheap" });
    assert.deepEqual(summary?.resolved, { providerId: "echo", model: "echo-1" });
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("end-to-end: real provider → context snapshot → usage → memory → retrieval", async () => {
  const ctx = await setup();
  const mock = await startMockOpenAIServer({ chatReply: "（mock）我记得你喜欢深烘豆。" });
  try {
    await post(ctx, "/api/providers", {
      id: "mock-openai",
      kind: "openai-compatible",
      displayName: "Mock OpenAI",
      baseUrl: mock.baseUrl,
      defaultModel: "mock-chat",
      requiresCredential: true,
      apiKey: SECRET,
    });
    for (const taskType of ["chat", "memory_extraction", "summarization"]) {
      await put(ctx, "/api/model-routing", { taskType, providerId: "mock-openai", model: "mock-chat" });
    }

    const characterId = await createCharacter(ctx);
    const conversationId = await createConversation(ctx, characterId);

    const first = await post(ctx, `/api/conversations/${conversationId}/messages`, { text: "我平时只喝深烘豆，别的喝不惯" });
    assert.equal(first.status, 201);
    const firstItems = ((await first.json()) as { items: Array<{ role: string; text: string; status: string }> }).items;
    assert.equal(firstItems[firstItems.length - 1]?.role, "character");
    assert.match(firstItems[firstItems.length - 1]?.text ?? "", /mock/);

    // 第二轮会满足抽取闸门（每 2 条用户消息抽取一次）
    await post(ctx, `/api/conversations/${conversationId}/messages`, { text: "你觉得深烘豆配什么点心好？" });

    // 1) 用量记录：provider / model / task / tokens / latency
    const usageResponse = await fetch(`${ctx.baseUrl}/api/usage?days=1`);
    const usage = (await usageResponse.json()) as {
      summary: Array<{ taskType: string; calls: number; inputTokens: number; outputTokens: number }>;
      recent: Array<{ providerId: string; model: string; inputTokens: number | null; latencyMs: number }>;
    };
    const chatUsage = usage.summary.find((entry) => entry.taskType === "chat");
    assert.ok(chatUsage !== undefined && chatUsage.calls >= 2, "每次调用都要有用量记录");
    assert.equal(chatUsage?.inputTokens, 42 * chatUsage!.calls);
    assert.equal(usage.recent[0]?.providerId, "mock-openai");
    assert.ok((usage.recent[0]?.latencyMs ?? -1) >= 0);

    // 2) 上下文快照：每次真实调用前都有
    const snapshotsResponse = await fetch(`${ctx.baseUrl}/api/conversations/${conversationId}/snapshots`);
    const snapshots = ((await snapshotsResponse.json()) as { items: Array<{ sections: Array<{ kind: string }>; model: string }> }).items;
    assert.ok(snapshots.length >= 2);
    assert.equal(snapshots[0]?.model, "mock-chat");
    assert.ok(snapshots[0]?.sections.some((section) => section.kind === "character_definition"));

    // 3) 记忆抽取落库（后台任务，轮询等待）
    const memories = await waitFor(async () => {
      const response = await fetch(`${ctx.baseUrl}/api/memories?limit=50`);
      const body = (await response.json()) as { items: Array<{ id: string; content: string }> };
      return body.items.length > 0 ? body.items : null;
    });
    assert.ok(memories !== null, "第二轮之后必须抽取到记忆");
    assert.match(memories![0]!.content, /深烘/);

    // 4) 检索命中 + 来源可追溯
    const searchResponse = await post(ctx, "/api/memories/search", { text: "深烘豆", limit: 5 });
    const hits = ((await searchResponse.json()) as { items: Array<{ memory: { id: string; content: string }; score: number }> }).items;
    assert.ok(hits.length > 0);
    assert.equal(hits[0]?.memory.id, memories![0]!.id);

    const detail = await fetch(`${ctx.baseUrl}/api/memories/${memories![0]!.id}`);
    const detailBody = (await detail.json()) as { sourceMessage: { text: string } | null; links: Array<{ targetType: string }> };
    assert.ok(detailBody.sourceMessage !== null, "记忆必须能追溯到来源消息");
    assert.match(detailBody.sourceMessage!.text, /深烘豆/);
    assert.ok(detailBody.links.some((link) => link.targetType === "character"));

    // 5) Context Preview 里能看到这条记忆
    const preview = await post(ctx, `/api/conversations/${conversationId}/context-preview`, { text: "深烘豆怎么样？" });
    const previewBody = (await preview.json()) as {
      sections: Array<{ kind: string; text: string }>;
      totalTokens: number;
      budgetTokens: number;
      model: { providerId: string; model: string };
    };
    assert.equal(previewBody.model.providerId, "mock-openai");
    assert.ok(previewBody.totalTokens > 0 && previewBody.totalTokens <= previewBody.budgetTokens);
    const memorySection = previewBody.sections.find((section) => section.kind === "memories");
    assert.ok(memorySection !== undefined, "预览必须能看到检索到的记忆");
    assert.match(memorySection!.text, /深烘/);

    // 6) 删除记忆
    const deleted = await fetch(`${ctx.baseUrl}/api/memories/${memories![0]!.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("streaming over HTTP: many SSE deltas, exactly one stored assistant message", async () => {
  const ctx = await setup();
  const mock = await startMockOpenAIServer({ chatReply: "（mock）我把这段话分块流式讲完，但数据库里只应该有一条消息。" });
  try {
    await post(ctx, "/api/providers", {
      id: "mock-openai",
      kind: "openai-compatible",
      displayName: "Mock OpenAI",
      baseUrl: mock.baseUrl,
      defaultModel: "mock-chat",
      requiresCredential: false,
    });
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "mock-openai", model: "mock-chat" });

    const characterId = await createCharacter(ctx);
    const conversationId = await createConversation(ctx, characterId);

    const controller = new AbortController();
    const sse = await fetch(`${ctx.baseUrl}/api/events/stream`, { signal: controller.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deltas: string[] = [];

    const started = await post(ctx, `/api/conversations/${conversationId}/messages`, { text: "讲个故事", stream: true });
    assert.equal(started.status, 202);
    const startBody = (await started.json()) as { runId: string; conversationId: string };
    assert.match(startBody.runId, /^run:/);

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 300)),
      ]);
      if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true });
      // 按完整帧切分，保留尚未接收完的尾部（跨 chunk 的边界不能丢）
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (!frame.startsWith("event: message.delta")) continue;
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine === undefined) continue;
        // SSE 的 data 是完整的领域事件信封：真正的内容在 payload 里
        const event = JSON.parse(dataLine.slice(6)) as { payload?: { delta?: string; runId?: string; complete?: boolean } };
        const payload = event.payload ?? {};
        if (payload.runId === startBody.runId && payload.delta !== undefined) deltas.push(payload.delta);
      }
      const messages = ctx.container.services.conversations.messages(conversationId);
      // Phase 5：会话创建时会有一条开场白（assistant），因此这里看的是"最新一条 assistant"
      const assistant = messages.filter((message) => message.role === "character");
      if (assistant.length >= 2 && assistant.at(-1)!.status === "completed") break;
    }
    controller.abort();

    assert.ok(deltas.length > 3, `应当收到多个增量，实际 ${deltas.length}`);
    const messages = ctx.container.services.conversations.messages(conversationId);
    const assistant = messages.filter((message) => message.role === "character");
    // 开场白（Phase 5 导入的角色卡 first_mes）+ 本次流式回复 = 2 条 assistant
    assert.equal(assistant.length, 2, "数十个 chunk 只能落库一条**新** assistant 消息");
    assert.equal((assistant[0]?.textRender ?? "").trim().length > 0, true, "第 0 条是角色卡开场白");
    assert.equal(assistant.at(-1)?.status, "completed");
    assert.equal(assistant.at(-1)?.textRender, "（mock）我把这段话分块流式讲完，但数据库里只应该有一条消息。");
    assert.equal(messages.filter((message) => message.role === "user").length, 1);

    // 流式调用同样要记录用量（最后一帧带 usage，不能丢）
    const usageResponse = await fetch(`${ctx.baseUrl}/api/usage?days=1`);
    const usage = (await usageResponse.json()) as { recent: Array<{ taskType: string; inputTokens: number | null; outputTokens: number | null }> };
    const streamingCall = usage.recent.find((entry) => entry.taskType === "chat");
    assert.equal(streamingCall?.inputTokens, 42);
    assert.equal(streamingCall?.outputTokens, 17);
  } finally {
    await mock.close();
    await ctx.close();
  }
});

test("provider errors surface as structured failures, not crashes", async () => {
  const ctx = await setup();
  try {
    const created = await post(ctx, "/api/providers", {
      id: "dead",
      kind: "openai-compatible",
      displayName: "Dead",
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "nope",
      requiresCredential: false,
      timeoutMs: 1500,
    });
    assert.equal(created.status, 201);
    const testResult = await post(ctx, "/api/providers/dead/test", {});
    const body = (await testResult.json()) as { ok: boolean; error: { kind: string } | null };
    assert.equal(body.ok, false);
    assert.ok(["network", "timeout"].includes(body.error?.kind ?? ""), `unexpected kind: ${body.error?.kind}`);

    // 路由到坏 provider 后，聊天请求必须返回结构化错误而不是 500 崩溃
    await put(ctx, "/api/model-routing", { taskType: "chat", providerId: "dead", model: "nope" });
    const characterId = await createCharacter(ctx);
    const conversationId = await createConversation(ctx, characterId);
    const chat = await post(ctx, `/api/conversations/${conversationId}/messages`, { text: "在吗" });
    assert.equal(chat.status, 502);
    const errorBody = (await chat.json()) as { error: { code: string } };
    assert.equal(errorBody.error.code, "provider_error");

    // 进程仍然可用：健康检查照常
    const health = await fetch(`${ctx.baseUrl}/api/system/health`);
    assert.equal(health.status, 200);
  } finally {
    await ctx.close();
  }
});
/**
 * Phase 2 冒烟脚本：真实进程 + 真实 HTTP + 真实 SQLite 文件。
 *
 * 用一个本地 OpenAI 兼容 mock 服务替代真实 API Key，从而完整验证：
 * 创建角色（原生定义） → 上下文构建 → 模型路由 → 真实 Provider HTTP → 流式 → 落库 → 记忆抽取 → 检索 → 用量与快照。
 *
 * 用法：node scripts/phase2-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-smoke-"));
const cleanup = process.argv[2] === undefined;
const lines: string[] = [];
const log = (message: string): void => {
  lines.push(message);
  process.stdout.write(`${message}\n`);
};

const config = loadConfig({
  COMPANION_DATA_DIR: dataDir,
  COMPANION_LOG_LEVEL: "warn",
});
const container = await createContainer({ config });
await startChannels(container);
const app = createHttpServer(container);
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") throw new Error("no address");
const base = `http://127.0.0.1:${address.port}`;

const mock = await startMockOpenAIServer({
  chatReply: "（mock 模型）我记得你只喝深烘豆，今天也给你留了一杯。",
  extractionReply: JSON.stringify([
    { scope: "user", type: "preference", content: "用户只喝深烘咖啡豆", importance: 0.85, confidence: 0.9, tags: ["咖啡", "偏好"] },
    { scope: "user", type: "identity", content: "用户的生日是 3 月 14 日", importance: 0.95, confidence: 0.9, tags: ["生日"] },
  ]),
});

const json = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${text.slice(0, 200)}`);
  return text.length === 0 ? null : JSON.parse(text);
};

try {
  log(`DATA DIR: ${dataDir}`);
  const health = (await json("/api/system/health")) as { status: string; database: string; channels: Array<{ channel: string; state: string }> };
  log(`HEALTH: ${health.status} / db=${health.database} / channels=${health.channels.map((c) => `${c.channel}:${c.state}`).join(",")}`);

  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-openai",
      kind: "openai-compatible",
      displayName: "本地 mock 模型",
      baseUrl: mock.baseUrl,
      defaultModel: "mock-chat",
      requiresCredential: true,
      apiKey: "sk-smoke-secret",
    }),
  });
  for (const taskType of ["chat", "memory_extraction", "summarization"]) {
    await json("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId: "smoke-openai", model: "mock-chat" }) });
  }
  const tested = (await json("/api/providers/smoke-openai/test", { method: "POST" })) as { ok: boolean; models: Array<{ id: string }> };
  log(`PROVIDER TEST: ok=${tested.ok} models=${tested.models.map((m) => m.id).join(",")}`);

  const providers = (await json("/api/providers")) as { items: Array<Record<string, unknown>> };
  const leaked = JSON.stringify(providers).includes("sk-smoke-secret");
  log(`CREDENTIAL LEAK CHECK: ${leaked ? "LEAKED!" : "no secret in API response"}`);

  // 角色：原生定义内联构建（角色卡导入接口已删除）
  const character = (await json("/api/characters", {
    method: "POST",
    body: JSON.stringify({
      name: "Aria",
      description: "一个会记住你的角色",
      personality: "温柔、好奇",
      scenario: "小镇的咖啡馆",
      systemPrompt: "保持简洁，不要长篇大论。",
      firstMessage: "欢迎回来，今天想喝点什么？",
    }),
  })) as { id: string; name: string };
  log(`CHARACTER: ${character.name} (${character.id})`);

  const conversation = (await json("/api/conversations", { method: "POST", body: JSON.stringify({ characterId: character.id }) })) as { id: string };
  log(`CONVERSATION: ${conversation.id}`);

  const first = (await json(`/api/conversations/${conversation.id}/messages`, { method: "POST", body: JSON.stringify({ text: "我只喝深烘豆，别的喝不惯，另外我生日是 3 月 14 日" }) })) as {
    items: Array<{ role: string; text: string }>;
  };
  log(`CHAT #1: ${first.items.map((m) => `[${m.role}] ${m.text.slice(0, 30)}`).join(" | ")}`);

  // 流式：监听 SSE，实时拼接增量
  const controller = new AbortController();
  const sse = await fetch(`${base}/api/events/stream`, { signal: controller.signal });
  const reader = sse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const streamed: string[] = [];
  const started = (await json(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "今天推荐点什么？", stream: true }),
  })) as { runId: string };
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 250)),
    ]);
    if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (!frame.startsWith("event: message.delta")) continue;
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine === undefined) continue;
      const event = JSON.parse(dataLine.slice(6)) as { payload?: { delta?: string; runId?: string; complete?: boolean } };
      if (event.payload?.runId === started.runId && event.payload.delta !== undefined) streamed.push(event.payload.delta);
      if (event.payload?.complete === true) boundary = -1;
    }
    if (streamed.length > 5 && Date.now() > deadline - 4000) break;
    const assistant = container.services.conversations
      .messages(conversation.id)
      .filter((message) => message.role === "character");
    if (assistant.length === 2 && assistant[1]?.status === "completed") break;
  }
  controller.abort();
  log(`STREAM: runId=${started.runId} deltas=${streamed.length} → "${streamed.join("").slice(0, 40)}…"`);

  const messages = container.services.conversations.messages(conversation.id);
  log(`MESSAGES IN DB: ${messages.length}（user=${messages.filter((m) => m.role === "user").length}, character=${messages.filter((m) => m.role === "character").length}）`);

  await new Promise((resolve) => setTimeout(resolve, 800));
  const memories = (await json("/api/memories?limit=20")) as { items: Array<{ id: string; content: string; importance: number }>; total: number };
  log(`MEMORIES: ${memories.items.length} 条 → ${memories.items.map((m) => `${m.content}(${m.importance})`).join("; ")}`);

  const hits = (await json("/api/memories/search", { method: "POST", body: JSON.stringify({ text: "深烘豆", limit: 5 }) })) as {
    items: Array<{ memory: { content: string }; score: number }>;
  };
  log(`RETRIEVAL: ${hits.items.map((h) => `${h.memory.content} [${h.score.toFixed(3)}]`).join(" | ")}`);

  const preview = (await json(`/api/conversations/${conversation.id}/context-preview`, {
    method: "POST",
    body: JSON.stringify({ text: "深烘豆配什么点心？" }),
  })) as { totalTokens: number; budgetTokens: number; sections: Array<{ kind: string; tokenEstimate: number }>; model: { providerId: string } };
  log(`CONTEXT PREVIEW: model=${preview.model.providerId} tokens=${preview.totalTokens}/${preview.budgetTokens} sections=${preview.sections.map((s) => `${s.kind}(${s.tokenEstimate})`).join(",")}`);

  const snapshots = (await json(`/api/conversations/${conversation.id}/snapshots`)) as { items: Array<{ id: string; model: string }> };
  log(`SNAPSHOTS: ${snapshots.items.length} 条，最近一条 model=${snapshots.items[0]?.model}`);

  const usage = (await json("/api/usage?days=1")) as { summary: Array<{ taskType: string; calls: number; inputTokens: number; outputTokens: number; estimatedCost: number | null }> };
  log(`USAGE: ${usage.summary.map((s) => `${s.taskType}: ${s.calls}次 in=${s.inputTokens} out=${s.outputTokens} cost=${s.estimatedCost?.toFixed(5) ?? "—"}`).join(" | ")}`);

  log("SMOKE OK");
} finally {
  await mock.close();
  await app.close();
  await container.shutdown();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

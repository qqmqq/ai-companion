import { createTestDatabase } from "./db.ts";
import { createMemoryRepository } from "../../src/storage/repositories/memories.ts";
import { createFtsMemoryRetriever } from "../../src/storage/search/fts-memory-retriever.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createMemoryService } from "../../src/core/memory/memory-service.ts";
import { createLogger } from "../../src/app/logger.ts";
import { defaultRuntimeState } from "../../src/core/model/character.ts";
import type { ChatDelta, ChatRequest, ChatResponse, LLMProvider } from "../../src/core/ports/llm-provider.ts";
import type { TaskLLM } from "../../src/core/ports/task-llm.ts";
import type { TaskType } from "../../src/core/model/task.ts";
import { createModelUsageRepository } from "../../src/storage/repositories/model-usage.ts";
import { createTaskLLM } from "../../src/providers/task-llm.ts";
import type { LLMProviderRegistry } from "../../src/providers/llm/registry.ts";

/** 可编程的假 Provider：按顺序返回预设文本，并记录收到的请求。 */
export function fakeProvider(responses: string[]): { provider: LLMProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let index = 0;
  const provider: LLMProvider = {
    id: "fake",
    kind: "fake",
    async listModels() {
      return [
        {
          id: "fake-model",
          displayName: "fake",
          capabilities: {
            tools: false,
            vision: false,
            jsonMode: true,
            streaming: true,
            contextWindow: 8192,
            costPer1kInput: 0.001,
            costPer1kOutput: 0.002,
          },
        },
      ];
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      const text = responses[Math.min(index, responses.length - 1)] ?? "";
      index += 1;
      return { text, model: request.model, usage: { promptTokens: 100, completionTokens: 20 }, finishReason: "stop" };
    },
    async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
      requests.push(request);
      const text = responses[Math.min(index, responses.length - 1)] ?? "";
      index += 1;
      for (const chunk of text.match(/.{1,5}/gs) ?? []) yield { text: chunk, done: false };
      yield { text: "", done: true };
    },
  };
  return { provider, requests };
}

export interface MemoryStack {
  db: ReturnType<typeof createTestDatabase>;
  memories: ReturnType<typeof createMemoryRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  service: ReturnType<typeof createMemoryService>;
  taskLLM: ReturnType<typeof createTaskLLM>;
  usage: ReturnType<typeof createModelUsageRepository>;
  requests: ChatRequest[];
  close(): void;
}

const AT = "2026-01-01T00:00:00.000Z";

/** 记忆有外键约束（character / conversation），测试也要有真实的父行。 */
export function seedFixtures(
  db: ReturnType<typeof createTestDatabase>,
  ids: { userId: string; characterId: string; conversationId: string },
): void {
  db.raw.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)").run(ids.userId, "测试用户", AT);
  db.raw
    .prepare(
      "INSERT INTO characters (id, user_id, name, slug, current_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(ids.characterId, ids.userId, "Aria", `aria-${ids.characterId}`, "v1", AT, AT);
  db.raw
    .prepare(
      "INSERT INTO character_versions (id, character_id, spec_version, definition_json, imported_from, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("v1", ids.characterId, "companion-v1", "{}", "test", AT);
  db.raw
    .prepare(
      "INSERT INTO conversations (id, user_id, character_id, channel, conversation_ref, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(ids.conversationId, ids.userId, ids.characterId, "web", `web:${ids.characterId}`, "测试会话", "active", AT);
  // 运行时状态：真实流程由 CharacterService 写入，夹具必须一致，否则上下文里没有角色状态
  const state = defaultRuntimeState(ids.characterId, ids.userId, AT);
  db.raw
    .prepare("INSERT INTO character_states (character_id, user_id, state_json, updated_at) VALUES (?, ?, ?, ?)")
    .run(ids.characterId, ids.userId, JSON.stringify(state), AT);
}

export function createMemoryStack(responses: string[], nowMs: () => number = () => Date.now()): MemoryStack {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const memories = createMemoryRepository(db);
  const settings = createSettingsRepository(db);
  const usage = createModelUsageRepository(db);
  const retriever = createFtsMemoryRetriever({ memories, now: nowMs });
  const { provider, requests } = fakeProvider(responses);

  const registry: LLMProviderRegistry = {
    get: (id) => (id === "fake" ? provider : undefined),
    list: () => [provider],
    modelInfo: (providerId, model) =>
      providerId === "fake"
        ? {
            id: model,
            displayName: model,
            capabilities: {
              tools: false,
              vision: false,
              jsonMode: true,
              streaming: true,
              contextWindow: 8192,
              costPer1kInput: 0.001,
              costPer1kOutput: 0.002,
            },
          }
        : null,
    refreshModelInfo: async () => provider.listModels(),
  };

  const taskLLM = createTaskLLM({
    router: {
      resolve: (task: TaskType) => ({ taskType: task, providerId: "fake", model: "fake-model" }),
      listRoutes: () => [],
    },
    providers: registry,
    usage,
    logger: createLogger({ level: "error", sink: () => {} }),
    now: nowMs,
  });

  const service = createMemoryService({
    memories,
    retriever,
    taskLLM,
    settings,
    logger: createLogger({ level: "error", sink: () => {} }),
    clock: { now: () => new Date(nowMs()), nowIso: () => new Date(nowMs()).toISOString() },
    now: nowMs,
  });

  return { db, memories, settings, service, taskLLM, usage, requests, close: () => db.close() };
}
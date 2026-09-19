import { createTestDatabase } from "./db.ts";
import { createUserRepository } from "../../src/storage/repositories/users.ts";
import { seedFixtures } from "./memory-stack.ts";
import { createMemoryRepository } from "../../src/storage/repositories/memories.ts";
import { createSummaryRepository } from "../../src/storage/repositories/summaries.ts";
import { createContextSnapshotRepository } from "../../src/storage/repositories/context-snapshots.ts";
import { createModelUsageRepository } from "../../src/storage/repositories/model-usage.ts";
import { createProviderConfigRepository } from "../../src/storage/repositories/model-config.ts";
import { createCharacterRepository } from "../../src/storage/repositories/characters.ts";
import { createConversationRepository } from "../../src/storage/repositories/conversations.ts";
import { createMessageRepository } from "../../src/storage/repositories/messages.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createFtsMemoryRetriever } from "../../src/storage/search/fts-memory-retriever.ts";
import { createMemoryService } from "../../src/core/memory/memory-service.ts";
import { createContextEngine } from "../../src/core/context/context-engine.ts";
import { createConversationService } from "../../src/core/services/conversation-service.ts";
import { createSummaryService } from "../../src/core/services/summary-service.ts";
import { createTaskLLM } from "../../src/providers/task-llm.ts";
import { createLogger } from "../../src/app/logger.ts";
import type { LLMProvider, ChatRequest, ChatResponse, ChatDelta, ModelInfo } from "../../src/core/ports/llm-provider.ts";
import { ProviderError } from "../../src/core/model/provider-error.ts";
import type { LLMProviderRegistry } from "../../src/providers/llm/registry.ts";
import type { TaskType } from "../../src/core/model/task.ts";
import type { Message } from "../../src/core/model/message.ts";


// ---- Phase 3 ----
import { createRelationshipRepository } from "../../src/storage/repositories/relationships.ts";
import { createEmotionRepository } from "../../src/storage/repositories/emotions.ts";
import { createEventRepository } from "../../src/storage/repositories/events.ts";
import { createWorkTaskRepository } from "../../src/storage/repositories/work-tasks.ts";
import { createScheduledJobRepository } from "../../src/storage/repositories/scheduled-jobs.ts";
import { createProactiveDecisionRepository } from "../../src/storage/repositories/proactive-decisions.ts";
import { createRelationshipService } from "../../src/core/services/relationship-service.ts";
import { createEmotionService } from "../../src/core/services/emotion-service.ts";
import { createCharacterStateService } from "../../src/core/services/character-state-service.ts";
import { createEventService } from "../../src/core/services/event-service.ts";
import { createTaskService } from "../../src/core/services/task-service.ts";
import { createProactiveService } from "../../src/core/services/proactive-service.ts";
import { createCharacterService } from "../../src/core/services/character-service.ts";
import { createProactiveMessageWriter } from "../../src/core/services/proactive-message-writer.ts";
import { createScheduler } from "../../src/core/scheduler/scheduler.ts";
import { createFakeClock, type FakeClock } from "./fake-clock.ts";
import type { ProactiveOutbound, ProactiveOutboundRequest, ProactiveOutboundResult } from "../../src/core/ports/outbound.ts";
import type { WorkTask } from "../../src/core/model/work.ts";

export interface ChatStackOptions {
  /** 各任务类型的模型回复（chat 会用流式逐块吐出） */
  chatReply?: string;
  extractionReply?: string;
  summaryReply?: string;
  /** 流式分块大小 */
  chunkSize?: number;
  /** chat 流在第 N 个 chunk 之后抛错，用于测试中断落库 */
  failAfterChunks?: number;
  /** 非流式 chat 直接抛错（用于测试主动消息生成失败） */
  failChat?: boolean;
  characterName?: string;
  /** 起始时间（默认 2026-03-01T09:00:00Z） */
  startIso?: string;
}

export interface ChatStack {
  db: ReturnType<typeof createTestDatabase>;
  messages: ReturnType<typeof createMessageRepository>;
  conversations: ReturnType<typeof createConversationRepository>;
  memories: ReturnType<typeof createMemoryRepository>;
  summaries: ReturnType<typeof createSummaryRepository>;
  snapshots: ReturnType<typeof createContextSnapshotRepository>;
  usage: ReturnType<typeof createModelUsageRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  memory: ReturnType<typeof createMemoryService>;
  context: ReturnType<typeof createContextEngine>;
  conversationService: ReturnType<typeof createConversationService>;
  summaryService: ReturnType<typeof createSummaryService>;
  providerConfig: ReturnType<typeof createProviderConfigRepository>;
  taskLLM: ReturnType<typeof createTaskLLM>;
  // Phase 3
  clock: FakeClock;
  characterState: ReturnType<typeof createCharacterStateService>;
  relationship: ReturnType<typeof createRelationshipService>;
  emotion: ReturnType<typeof createEmotionService>;
  eventService: ReturnType<typeof createEventService>;
  taskService: ReturnType<typeof createTaskService>;
  scheduler: ReturnType<typeof createScheduler>;
  proactive: ReturnType<typeof createProactiveService>;
  outbound: ProactiveOutbound & { sent: ProactiveOutboundRequest[] };
  workTasks: ReturnType<typeof createWorkTaskRepository>;
  scheduledJobs: ReturnType<typeof createScheduledJobRepository>;
  proactiveDecisions: ReturnType<typeof createProactiveDecisionRepository>;
  requests: ChatRequest[];
  conversationId: string;
  userId: string;
  characterId: string;
  close(): void;
}

const AT = "2026-01-01T00:00:00.000Z";

/** 会按系统提示词判断"这是哪个任务"的假 Provider：既能测路由，也能测真实调用链。 */
function scriptedProvider(options: ChatStackOptions, requests: ChatRequest[]): LLMProvider {
  const chunkSize = options.chunkSize ?? 6;
  const modelInfo: ModelInfo = {
    id: "scripted-model",
    displayName: "scripted",
    capabilities: {
      tools: false,
      vision: false,
      jsonMode: true,
      streaming: true,
      contextWindow: 8192,
      costPer1kInput: 0.001,
      costPer1kOutput: 0.002,
    },
  };

  const respond = (request: ChatRequest): string => {
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("记忆抽取器")) return options.extractionReply ?? "[]";
    if (system.includes("对话压缩器")) return options.summaryReply ?? "（摘要）用户与角色聊了日常。";
    return options.chatReply ?? "好的呀。";
  };

  return {
    id: "scripted",
    kind: "scripted",
    async listModels() {
      return [modelInfo];
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      if (options.failChat === true) {
        throw new ProviderError("上游 500", {
          providerId: "scripted",
          kind: "server_error",
          httpStatus: 500,
          retryable: true,
        });
      }
      return { text: respond(request), model: request.model, usage: { promptTokens: 50, completionTokens: 10 }, finishReason: "stop" };
    },
    async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
      requests.push(request);
      if (request.signal?.aborted === true) {
        throw new ProviderError("已被取消", {
          providerId: "scripted",
          kind: "aborted",
          httpStatus: null,
          retryable: false,
        });
      }
      const text = respond(request);
      const chunks = text.match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, "g")) ?? [];
      let produced = 0;
      for (const chunk of chunks) {
        if (options.failAfterChunks !== undefined && produced >= options.failAfterChunks) {
          throw new ProviderError("上游断开", {
            providerId: "scripted",
            kind: "network",
            httpStatus: null,
            retryable: true,
          });
        }
        produced += 1;
        yield { text: chunk, done: false };
      }
      yield { text: "", done: true };
    },
  };
}

export function createChatStack(options: ChatStackOptions = {}): ChatStack {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });

  const characters = createCharacterRepository(db);
  // seedFixtures 已经建了 v1 版本行；这里只覆盖它的定义内容，避免主键冲突
  const definitionFixture = {
      name: options.characterName ?? "Aria",
      description: "温柔的咖啡师",
      personality: "耐心",
      scenario: "小镇咖啡馆",
      firstMessage: "欢迎回来。",
      messageExamples: "",
      systemPrompt: "",
      creatorNotes: "",
      tags: [],
      alternateGreetings: [],
      characterBook: null,
      specVersion: "tavern-v2" as const,
      extensions: {},
  };
  db.raw
    .prepare("UPDATE character_versions SET definition_json = ?, spec_version = ? WHERE id = ?")
    .run(JSON.stringify(definitionFixture), "tavern-v2", "v1");

  const messages = createMessageRepository(db);
  const conversations = createConversationRepository(db);
  const memories = createMemoryRepository(db);
  const summaries = createSummaryRepository(db);
  const snapshots = createContextSnapshotRepository(db);
  const usersRepo = createUserRepository(db);
  usersRepo.ensureLocalUser();
  const usage = createModelUsageRepository(db);
  const settings = createSettingsRepository(db);
  const providerConfig = createProviderConfigRepository(db);
  const retriever = createFtsMemoryRetriever({ memories });
  const logger = createLogger({ level: "error", sink: () => {} });
  const requests: ChatRequest[] = [];
  const provider = scriptedProvider(options, requests);

  const registry: LLMProviderRegistry = {
    get: (id) => (id === "scripted" ? provider : undefined),
    list: () => [provider],
    modelInfo: (providerId, model) => (providerId === "scripted" ? { ...{ id: model, displayName: model }, ...{} , capabilities: {
      tools: false, vision: false, jsonMode: true, streaming: true, contextWindow: 8192, costPer1kInput: 0.001, costPer1kOutput: 0.002,
    } } : null),
    refreshModelInfo: async () => provider.listModels(),
  };

  const taskLLM = createTaskLLM({
    router: {
      resolve: (task: TaskType) => ({ taskType: task, providerId: "scripted", model: "scripted-model" }),
      resolveOrNull: (task: TaskType) => ({ taskType: task, providerId: "scripted", model: "scripted-model" }),
      listRoutes: () => [],
    },
    providers: registry,
    usage,
    logger,
  });

  const clock = createFakeClock(options.startIso);
  const memory = createMemoryService({ memories, retriever, taskLLM, settings, logger, clock });

  // ---- Phase 3 服务 ----
  const relationshipsRepo = createRelationshipRepository(db);
  const emotionsRepo = createEmotionRepository(db);
  const eventsRepo = createEventRepository(db);
  const workTasksRepo = createWorkTaskRepository(db);
  const scheduledJobsRepo = createScheduledJobRepository(db);
  const proactiveDecisionsRepo = createProactiveDecisionRepository(db);

  const relationship = createRelationshipService({ relationships: relationshipsRepo, events: { publish: () => {} }, logger, clock });
  const characterState = createCharacterStateService({ characters, clock, logger });
  const emotion = createEmotionService({
    emotions: emotionsRepo,
    characterState,
    taskLLM,
    settings,
    events: { publish: () => {} },
    logger,
    clock,
  });
  const eventService = createEventService({
    events: eventsRepo,
    effectHandlers: {},
    publisher: { publish: () => {} },
    logger,
    clock,
  });
  const context = createContextEngine({
    characters,
    messages,
    summaries,
    snapshots,
    memoryService: memory,
    emotion,
    relationship,
    events: eventService,
    taskLLM,
    settings,
    logger,
    clock,
  });
  const characterService = createCharacterService({ characters, events: { publish: () => {} }, logger, clock });
  const conversationService = createConversationService({
    users: usersRepo,
    conversations,
    messages,
    characters,
    summaries,
    contextEngine: context,
    taskLLM,
    events: { publish: () => {} },
    logger,
    clock,
  });
  const summaryService = createSummaryService({ conversations, messages, summaries, taskLLM, settings, logger, clock });

  const messageWriter = createProactiveMessageWriter({ messages, conversations, publisher: { publish: () => {} }, clock });
  const outbound: ProactiveOutbound & { sent: ProactiveOutboundRequest[] } = {
    sent: [],
    async send(request: ProactiveOutboundRequest): Promise<ProactiveOutboundResult> {
      outbound.sent.push(request);
      return { delivered: true, providerMessageId: `fake-${outbound.sent.length}`, error: null };
    },
  };
  const taskHandlers = new Map<string, (task: WorkTask) => Promise<{ ok: boolean; detail?: Record<string, unknown>; error?: string }>>();
  const taskService = createTaskService({
    tasks: workTasksRepo,
    events: eventsRepo,
    handlers: taskHandlers,
    publisher: { publish: () => {} },
    logger,
    clock,
  });
  const proactive = createProactiveService({
    settings,
    decisions: proactiveDecisionsRepo,
    conversations,
    conversationService,
    characters: characterService,
    messages,
    events: eventsRepo,
    jobs: scheduledJobsRepo,
    emotion,
    context,
    taskLLM,
    messageWriter,
    outbound,
    publisher: { publish: () => {} },
    logger,
    clock,
  });
  taskHandlers.set("proactive_message", (task) => proactive.handleTask(task));
  const scheduler = createScheduler({ jobs: scheduledJobsRepo, clock, logger, publisher: { publish: () => {} } });
  scheduler.registerHandler("proactive_message", async (job) => {
    if (job.characterId === null) return { outcome: "skipped", reason: "no character" };
    const triggerKind = typeof job.payload.triggerKind === "string" ? job.payload.triggerKind : "idle_check";
    const result = await proactive.propose({ userId: job.userId, characterId: job.characterId, triggerKind, jobId: job.id });
    // 与生产 bootstrap 保持一致：被策略拦住也算"执行过"，但带上 blocked 原因
    if (result.decision.decision === "sent") return { outcome: "ran", reason: result.decision.triggerReason };
    if (result.decision.decision === "blocked") {
      return { outcome: "ran", reason: `blocked:${result.decision.blockedReason}`, detail: { blocked: true } };
    }
    return { outcome: "skipped", reason: result.decision.blockedReason ?? result.decision.triggerReason };
  });

  return {
    db,
    messages,
    conversations,
    memories,
    summaries,
    snapshots,
    usage,
    settings,
    memory,
    context,
    conversationService,
    summaryService,
    providerConfig,
    taskLLM,
    requests,
    clock,
    characterState,
    relationship,
    emotion,
    eventService,
    taskService,
    scheduler,
    proactive,
    outbound,
    workTasks: workTasksRepo,
    scheduledJobs: scheduledJobsRepo,
    proactiveDecisions: proactiveDecisionsRepo,
    conversationId: "cv1",
    userId: "u1",
    characterId: "c1",
    close: () => db.close(),
  };
}

export function messageTexts(messages: Message[]): string[] {
  return messages.map((message) => `${message.role}:${message.status}:${message.textRender}`);
}
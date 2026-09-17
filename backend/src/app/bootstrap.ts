import { join } from "node:path";
import { instantiateChannelModules } from "./channel-loader.ts";
import type { ChannelModule, SqlDatabase } from "../core/ports/channel-module.ts";
import type { AppConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createEventBus, type InMemoryEventBus } from "./events.ts";
import { openDatabase, type Database } from "../storage/db.ts";
import { runMigrations } from "../storage/migrations.ts";
import { createUserRepository } from "../storage/repositories/users.ts";
import { createCharacterRepository } from "../storage/repositories/characters.ts";
import { createConversationRepository } from "../storage/repositories/conversations.ts";
import { createMessageRepository } from "../storage/repositories/messages.ts";
import { createChannelRepository } from "../storage/repositories/channels.ts";
import { createCredentialRepository } from "../storage/repositories/credentials.ts";
import { createSettingsRepository } from "../storage/repositories/settings.ts";
import { createAuditRepository } from "../storage/repositories/audit.ts";
import { createMemoryRepository } from "../storage/repositories/memories.ts";
import { createSummaryRepository } from "../storage/repositories/summaries.ts";
import { createContextSnapshotRepository } from "../storage/repositories/context-snapshots.ts";
import { createModelUsageRepository } from "../storage/repositories/model-usage.ts";
import { createProviderConfigRepository } from "../storage/repositories/model-config.ts";
import { createTranscriptionRepository } from "../storage/repositories/transcriptions.ts";
import { createRelationshipRepository } from "../storage/repositories/relationships.ts";
import { createEmotionRepository } from "../storage/repositories/emotions.ts";
import { createEventRepository } from "../storage/repositories/events.ts";
import { createWorkTaskRepository } from "../storage/repositories/work-tasks.ts";
import { createScheduledJobRepository } from "../storage/repositories/scheduled-jobs.ts";
import { createProactiveDecisionRepository } from "../storage/repositories/proactive-decisions.ts";
import { createFtsMemoryRetriever } from "../storage/search/fts-memory-retriever.ts";
import { createLocalMediaStorage } from "../storage/media/local-media-storage.ts";
import type { MediaStorage } from "../core/ports/media-storage.ts";
import { createSqliteCredentialStore } from "../security/credential-store.ts";
import { defaultKeyPath, envKeyProvider, fileKeyProvider, type KeyProvider } from "../security/key-provider.ts";
import { createCharacterService } from "../core/services/character-service.ts";
import { createCharacterStudioService } from "../core/services/character-studio-service.ts";
import { createReminderComposer } from "../core/services/reminder-composer.ts";
import { createChatCharacterSwitch } from "../core/services/chat-character-switch.ts";
import { createConversationService } from "../core/services/conversation-service.ts";
import { createSummaryService } from "../core/services/summary-service.ts";
import { createMessagingPipeline } from "../core/services/messaging-pipeline.ts";
import { createActionIntentDetector } from "../core/services/action-intent.ts";
import { createAssistantActionService } from "../core/services/assistant-action-service.ts";
import {
  SCHEDULED_MESSAGE_KIND,
  createScheduledMessageService,
  readScheduledMessagePayload,
} from "../core/services/scheduled-message-service.ts";
import { createTranscriptionService } from "../core/services/transcription-service.ts";
import { createAsrRegistry } from "../providers/asr/registry.ts";
import { createTtsRegistry } from "../providers/tts/registry.ts";
import { createTtsService } from "../core/services/tts-service.ts";
import { createTtsSynthesisRepository } from "../storage/repositories/tts-syntheses.ts";
import { createContextEngine } from "../core/context/context-engine.ts";
import { createRelationshipService } from "../core/services/relationship-service.ts";
import { createEmotionService } from "../core/services/emotion-service.ts";
import { createCharacterStateService } from "../core/services/character-state-service.ts";
import { createEventService } from "../core/services/event-service.ts";
import { createTaskService } from "../core/services/task-service.ts";
import { createProactiveService } from "../core/services/proactive-service.ts";
import { createProactiveMessageWriter } from "../core/services/proactive-message-writer.ts";
import { createScheduler } from "../core/scheduler/scheduler.ts";
import { createSchedulerRunner, type SchedulerRunner } from "./scheduler-runner.ts";
import { createChannelProactiveOutbound } from "./outbound.ts";
import { systemClock, type Clock } from "../core/ports/clock.ts";
import type { ProactiveOutbound } from "../core/ports/outbound.ts";
import type { Scheduler } from "../core/scheduler/scheduler.ts";
import type { WorkTaskKind } from "../core/model/work.ts";
import { createMemoryService } from "../core/memory/memory-service.ts";
import { createModelRouter } from "../providers/model-router.ts";
import { createTaskLLM } from "../providers/task-llm.ts";
import { createProviderRegistry, type MutableProviderRegistry } from "../providers/llm/registry.ts";
import { createChannelManager, type ChannelManager } from "../channels/manager.ts";
import { createSseHub } from "../channels/web/sse-hub.ts";
import { createWebChannel, type WebChannel } from "../channels/web/channel.ts";
import type { CredentialStore } from "../core/ports/credential-store.ts";
import type { Logger } from "../core/ports/logger.ts";
import type { User } from "../core/model/user.ts";
import type { ProviderConfig, ProviderKind } from "../core/model/usage.ts";
import type { RunRegistry } from "../core/ports/runs.ts";
import { uuidv7 } from "../util/ids.ts";
import { nowIso } from "../util/time.ts";

export interface Container {
  config: AppConfig;
  logger: Logger;
  db: Database;
  events: InMemoryEventBus;
  credentials: CredentialStore;
  providers: MutableProviderRegistry;
  modelRouter: ReturnType<typeof createModelRouter>;
  taskLLM: ReturnType<typeof createTaskLLM>;
  clock: Clock;
  services: {
    characters: ReturnType<typeof createCharacterService>;
    characterStudio: ReturnType<typeof createCharacterStudioService>;
    /** 渠道聊天里"现在在跟哪个角色聊"：口令与后台按钮共用 */
    characterSwitch: ReturnType<typeof createChatCharacterSwitch>;
    conversations: ReturnType<typeof createConversationService>;
    summaries: ReturnType<typeof createSummaryService>;
    memory: ReturnType<typeof createMemoryService>;
    context: ReturnType<typeof createContextEngine>;
    // Phase 3
    relationship: ReturnType<typeof createRelationshipService>;
    emotion: ReturnType<typeof createEmotionService>;
    characterState: ReturnType<typeof createCharacterStateService>;
    events: ReturnType<typeof createEventService>;
    tasks: ReturnType<typeof createTaskService>;
    proactive: ReturnType<typeof createProactiveService>;
    scheduler: Scheduler;
  };
  outbound: ProactiveOutbound;
  schedulerRunner: SchedulerRunner;
  /** 平台无关的媒体存储：消息里只保存 mediaId */
  mediaStorage: MediaStorage;
  /** 运行时发现的可选渠道模块（不含 web） */
  channelModules: Array<{ name: string; kind: string; module: ChannelModule }>;
  repos: {
    users: ReturnType<typeof createUserRepository>;
    characters: ReturnType<typeof createCharacterRepository>;
    conversations: ReturnType<typeof createConversationRepository>;
    messages: ReturnType<typeof createMessageRepository>;
    channels: ReturnType<typeof createChannelRepository>;
    credentials: ReturnType<typeof createCredentialRepository>;
    settings: ReturnType<typeof createSettingsRepository>;
    audit: ReturnType<typeof createAuditRepository>;
    memories: ReturnType<typeof createMemoryRepository>;
    summaries: ReturnType<typeof createSummaryRepository>;
    snapshots: ReturnType<typeof createContextSnapshotRepository>;
    usage: ReturnType<typeof createModelUsageRepository>;
    providerConfig: ReturnType<typeof createProviderConfigRepository>;
    // Phase 3
    relationships: ReturnType<typeof createRelationshipRepository>;
    emotions: ReturnType<typeof createEmotionRepository>;
    eventsPhase3: ReturnType<typeof createEventRepository>;
    workTasks: ReturnType<typeof createWorkTaskRepository>;
    scheduledJobs: ReturnType<typeof createScheduledJobRepository>;
    proactiveDecisions: ReturnType<typeof createProactiveDecisionRepository>;
    // Phase 4.5-D3
    transcriptions: ReturnType<typeof createTranscriptionRepository>;
    // Phase 4.5-D4
    ttsSyntheses: ReturnType<typeof createTtsSynthesisRepository>;
  };
  transcription: ReturnType<typeof createTranscriptionService>;
  tts: ReturnType<typeof createTtsService>;
  pipeline: ReturnType<typeof createMessagingPipeline>;
  channels: ChannelManager;
  web: WebChannel;
  webHub: ReturnType<typeof createSseHub>;
  keyProvider: KeyProvider;
  user: User;
  webAccountId: string;
  startedAt: string;
  runs: RunRegistry;
  /** 重新读取 provider 配置并重建 Provider 实例（设置改动后调用）。 */
  reloadProviders(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createRunRegistry(): RunRegistry {
  const runs = new Map<string, { controller: AbortController; startedAt: string }>();
  return {
    register: (id, controller) => {
      runs.set(id, { controller, startedAt: nowIso() });
    },
    abort: (id) => {
      const run = runs.get(id);
      if (run === undefined) return false;
      run.controller.abort();
      runs.delete(id);
      return true;
    },
    finish: (id) => {
      runs.delete(id);
    },
    list: () => [...runs.entries()].map(([id, run]) => ({ id, startedAt: run.startedAt })),
  };
}

export interface CreateContainerOptions {
  config: AppConfig;
  databasePath?: string;
  keyProvider?: KeyProvider;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** 是否写入默认 provider/路由（测试可关闭） */
  seedDefaults?: boolean;
  /** 注入时钟：测试用 FakeClock，生产用 SystemClock */
  clock?: Clock;
  /** 是否启动真实定时器（测试关闭，改为手动 tick） */
  startSchedulerTimer?: boolean;
  /** 渠道实例化之前写入的初始设置（例如把渠道指向测试后端） */
  settingsSeed?: Record<string, unknown>;
}

const DEFAULT_PROVIDERS: Array<{ id: string; kind: ProviderKind; displayName: string; baseUrl: string; model: string; requiresCredential: boolean }> = [
  { id: "echo", kind: "echo", displayName: "内置占位模型（离线可用）", baseUrl: "internal://echo", model: "echo-1", requiresCredential: false },
];

export function seedProviderDefaults(
  providerConfig: ReturnType<typeof createProviderConfigRepository>,
  at: string,
): void {
  if (providerConfig.list().length === 0) {
    for (const preset of DEFAULT_PROVIDERS) {
      const config: ProviderConfig = {
        id: preset.id,
        kind: preset.kind,
        displayName: preset.displayName,
        baseUrl: preset.baseUrl,
        defaultModel: preset.model,
        credentialRef: null,
        requiresCredential: preset.requiresCredential,
        timeoutMs: 60_000,
        enabled: true,
        createdAt: at,
        updatedAt: at,
      };
      providerConfig.upsert(config);
    }
  }
  if (providerConfig.listRoutes().length === 0) {
    for (const taskType of ["chat", "memory_extraction", "summarization", "context_compression"] as const) {
      providerConfig.upsertRoute({ taskType, providerId: "echo", model: "echo-1", updatedAt: at });
    }
  }

  /**
   * 悬空路由清理：以前删 provider 时不会删它的路由，于是留下 chat → echo/echo-1 这样的路由，
   * 用户配的真实 provider 会被这条路由劫持（真实事故：把 echo-1 发给了真实 API）。
   * 这里只在启动时删掉"指向已不存在的 provider"的路由；用户自己的有效配置一律不动。
   */
  const knownIds = new Set(providerConfig.list().map((config) => config.id));
  for (const route of providerConfig.listRoutes()) {
    if (route.providerId !== null && !knownIds.has(route.providerId)) {
      providerConfig.deleteRoute(route.taskType);
    }
  }
}

export async function createContainer(options: CreateContainerOptions): Promise<Container> {
  const config = options.config;
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const db = openDatabase({ path: options.databasePath ?? config.databasePath });
  runMigrations(db);

  const events = createEventBus();
  const webHub = createSseHub();
  events.subscribe({ onEvent: (event) => webHub.broadcast(event) });

  const users = createUserRepository(db);
  const characters = createCharacterRepository(db);
  const conversations = createConversationRepository(db);
  const messages = createMessageRepository(db);
  const channelRepo = createChannelRepository(db);
  const credentialRepo = createCredentialRepository(db);
  const settings = createSettingsRepository(db);
  const audit = createAuditRepository(db);
  const memories = createMemoryRepository(db);
  const summaries = createSummaryRepository(db);
  const snapshots = createContextSnapshotRepository(db);
  const usage = createModelUsageRepository(db);
  const providerConfig = createProviderConfigRepository(db);
  const transcriptions = createTranscriptionRepository(db);
  const ttsSyntheses = createTtsSynthesisRepository(db);
  const relationshipsRepo = createRelationshipRepository(db);
  const emotionsRepo = createEmotionRepository(db);
  const eventsRepo = createEventRepository(db);
  const workTasksRepo = createWorkTaskRepository(db);
  const scheduledJobsRepo = createScheduledJobRepository(db);
  const proactiveDecisionsRepo = createProactiveDecisionRepository(db);
  const clock: Clock = options.clock ?? systemClock();

  const keyProvider =
    options.keyProvider ??
    (config.keyProvider.kind === "env"
      ? envKeyProvider(config.keyProvider.masterKey ?? "")
      : fileKeyProvider(defaultKeyPath(config.dataDir)));
  const credentials = createSqliteCredentialStore({ repository: credentialRepo, keyProvider, nowIso });

  if (options.seedDefaults !== false) seedProviderDefaults(providerConfig, nowIso());

  const providers = await createProviderRegistry({
    configs: providerConfig.list(),
    credentials,
    logger,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  // 仓储实现与端口做一次显式适配，避免把 storage 的类型渗进 Core 端口
  const modelConfigStore = {
    listProviders: () => providerConfig.list(),
    getProvider: (id: string) => providerConfig.get(id),
    getRoute: (taskType: Parameters<typeof providerConfig.getRoute>[0]) => providerConfig.getRoute(taskType),
    listRoutes: () => providerConfig.listRoutes(),
  };
  const modelRouter = createModelRouter({ config: modelConfigStore, providers, logger });
  const taskLLM = createTaskLLM({ router: modelRouter, providers, usage, logger });

  const relationshipService = createRelationshipService({ relationships: relationshipsRepo, events, logger, clock });
  const characterStateService = createCharacterStateService({ characters, clock, logger });
  const emotionService = createEmotionService({
    emotions: emotionsRepo,
    characterState: characterStateService,
    taskLLM,
    settings,
    events,
    logger,
    clock,
  });
  const eventEffects: import("../core/services/event-service.ts").EventEffectHandlers = {};
  const eventService = createEventService({
    events: eventsRepo,
    effectHandlers: eventEffects,
    publisher: events,
    logger,
    clock,
  });
  const taskHandlers = new Map<WorkTaskKind | string, (task: import("../core/model/work.ts").WorkTask) => Promise<{ ok: boolean; detail?: Record<string, unknown>; error?: string }>>();
  const taskService = createTaskService({
    tasks: workTasksRepo,
    events: eventsRepo,
    handlers: taskHandlers,
    publisher: events,
    logger,
    clock,
  });

  const retriever = createFtsMemoryRetriever({ memories });
  const memoryService = createMemoryService({ memories, retriever, taskLLM, settings, logger, clock });
  const contextEngine = createContextEngine({
    characters,
    messages,
    summaries,
    snapshots,
    memoryService,
    emotion: emotionService,
    relationship: relationshipService,
    events: eventService,
    taskLLM,
    settings,
    logger,
    clock,
  });

  const charactersService = createCharacterService({ characters, events, logger, clock });
  // 角色工坊：只产出候选设定，落库仍然走 charactersService（确认后才产生新版本）
  const characterStudio = createCharacterStudioService({ taskLLM, logger });
  // 到点提醒的措辞：用角色自己的语气说，而不是把记录原文念一遍
  const reminderComposer = createReminderComposer({ context: contextEngine, taskLLM, logger });
  const conversationsService = createConversationService({
    users,
    conversations,
    messages,
    characters,
    summaries,
    contextEngine,
    taskLLM,
    events,
    logger,
    clock,
  });
  const summaryService = createSummaryService({ conversations, messages, summaries, taskLLM, settings, logger, clock });

  const channels = createChannelManager({ logger });
  const webAccountId = `web:${uuidv7()}`;
  const web = createWebChannel({ accountId: webAccountId, events, logger });
  channels.register(web);

  const user = users.ensureLocalUser();
  channelRepo.ensureChannel("web", true);
  channelRepo.upsertAccount({
    id: webAccountId,
    channel: "web",
    externalAccountId: "local",
    displayName: "本地 Web",
    status: "active",
    createdAt: nowIso(),
    boundUserId: user.id,
  });

  const runs = createRunRegistry();

  for (const [key, value] of Object.entries(options.settingsSeed ?? {})) {
    settings.put(key, value, nowIso());
  }

  const mediaStorage = createLocalMediaStorage({ dataDir: config.dataDir, logger, clock });

  /**
   * ASR（Phase 4.5-D3）：与 LLM 共用同一套 Provider 配置与凭据规则，
   * 但使用**独立注册表**——ASR 默认关闭，只有 asr.enabled + asr.providerId 都配好才会真的调用 provider。
   */
  const asrProviders = await createAsrRegistry({
    configs: providerConfig.list(),
    credentials,
    logger,
    clock,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    modelOverride: settings.get<string | null>("asr.model", null),
  });
  const transcriptionService = createTranscriptionService({
    registry: asrProviders,
    repository: transcriptions,
    storage: mediaStorage,
    settings,
    logger,
    clock,
  });

  /**
   * TTS（Phase 4.5-D4）：与 ASR 对称的独立注册表，同样默认关闭。
   * 文字回复永远先生效；语音只是可选附加表示。
   */
  const ttsProviders = await createTtsRegistry({
    configs: providerConfig.list(),
    credentials,
    logger,
    clock,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    modelOverride: settings.get<string | null>("tts.model", null),
    voiceOverride: settings.get<string | null>("tts.voice", null),
  });
  const ttsService = createTtsService({
    registry: ttsProviders,
    repository: ttsSyntheses,
    storage: mediaStorage,
    settings,
    logger,
    clock,
  });

  // ---- 可选渠道（运行时发现，组合根不 import 任何具体渠道实现）----
  const channelModules = await instantiateChannelModules(join(import.meta.dirname, "..", "channels"), {
    logger,
    clock,
    events,
    credentials,
    settings,
    accounts: channelRepo,
    mediaStorage,
    userId: user.id,
    dataDir: config.dataDir,
    db: db.raw as unknown as SqlDatabase,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  for (const entry of channelModules) {
    // 复用既有 channels / channel_accounts 体系：渠道先登记自己，账号才有合法归属
    channelRepo.ensureChannel(entry.kind, true);
    channels.register(entry.channel);
    logger.info("optional channel module registered", { entry: entry.name, kind: entry.kind });
  }

  /**
   * Phase 4.5-E 启动恢复：进程若在转写/合成途中崩溃，记录会永远停在 processing
   * （没有后台任务会回来收尾），前端就会一直显示"生成中…"。
   * 这里做一次最小收敛：把**早于阈值**的 processing 记录标成 failed(interrupted)，
   * 状态变回可观测、可显式重试。默认阈值 10 分钟（远大于任何一次正常调用）。
   * 这不是分布式任务队列，也不做自动重放 —— 只把"不可能再完成"的中间态收敛掉。
   */
  const interruptedAfterMs = 10 * 60 * 1000;
  const recoveryCutoff = new Date(Date.parse(clock.nowIso()) - interruptedAfterMs).toISOString();
  try {
    const recoveredTranscriptions = transcriptions.recoverInterrupted(recoveryCutoff, clock.nowIso());
    const recoveredSyntheses = ttsSyntheses.recoverInterrupted(recoveryCutoff, clock.nowIso());
    const recoveredMessages = messages.recoverStaleTts(recoveryCutoff, clock.nowIso());
    if (recoveredTranscriptions + recoveredSyntheses + recoveredMessages > 0) {
      logger.warn("recovered interrupted media processing states", {
        transcriptions: recoveredTranscriptions,
        ttsSyntheses: recoveredSyntheses,
        messages: recoveredMessages,
      });
    }
  } catch (error) {
    // 恢复失败不应该阻止进程启动（下次启动还会再试）
    logger.warn("interrupted processing recovery failed", { error: (error as Error).message });
  }

  // 调度器要在管线之前建好：定时消息能力依赖它（scheduled_jobs + createJob）
  const scheduler = createScheduler({ jobs: scheduledJobsRepo, clock, logger, publisher: events });

  // ---- 定时消息：意图识别（模型）+ 应用服务（唯一能建 job 的地方） ----
  const actionIntent = createActionIntentDetector({
    taskLLM,
    logger,
    clock: () => clock.now(),
  });
  const scheduledMessages = createScheduledMessageService({ scheduler, conversations, clock, logger });
  const actions = createAssistantActionService({
    events: eventService,
    tasks: taskService,
    scheduledMessages,
    conversations,
    clock,
    logger,
  });

  // 渠道里换角色：口令 → 换会话 → 新会话的第一句话是那个角色的开场白
  const characterSwitch = createChatCharacterSwitch({
    characters,
    conversations: conversationsService,
    settings,
    clock,
    logger,
  });

  const pipeline = createMessagingPipeline({
    users: { localUserId: () => user.id },
    characters: charactersService,
    conversations: conversationsService,
    summaries: summaryService,
    memory: memoryService,
    emotion: emotionService,
    relationship: relationshipService,
    characterState: characterStateService,
    channels,
    settings,
    events,
    logger,
    runs,
    transcription: transcriptionService,
    tts: ttsService,
    messages,
    clock,
    actionIntent,
    actions,
    characterSwitch,
  });
  channels.setInboundHandler((message) => pipeline.handleInbound(message).then(() => undefined));
  web.onInboundStreaming((message) => pipeline.handleInboundStreaming(message));

  // ---- Phase 3：任务 / 调度 / 主动消息 ----
  const messageWriter = createProactiveMessageWriter({ messages, conversations, publisher: events, clock });
  const outbound = createChannelProactiveOutbound({ channels, logger });


  const proactiveService = createProactiveService({
    settings,
    decisions: proactiveDecisionsRepo,
    conversations,
    conversationService: conversationsService,
    characters: charactersService,
    messages,
    events: eventsRepo,
    jobs: scheduledJobsRepo,
    emotion: emotionService,
    context: contextEngine,
    taskLLM,
    messageWriter,
    outbound,
    publisher: events,
    logger,
    clock,
  });

  // 任务处理器：任务只描述"要做什么"，具体动作在这里注入
  taskHandlers.set("proactive_message", (task) => proactiveService.handleTask(task));
  taskHandlers.set("event_reminder", (task) => proactiveService.handleTask(task));
  taskHandlers.set("custom", async () => ({ ok: true, detail: { note: "no-op custom task" } }));

  // 事件效果：完成重要事件会影响关系；带到期时间的事件会派生提醒任务
  eventEffects.onCreated = (event) => {
    if (event.dueAt === null) return;
    if (event.type !== "promise" && event.type !== "future_plan" && event.type !== "anniversary") return;
    const remindersAt = new Date(Date.parse(event.dueAt) - 12 * 3600 * 1000).toISOString();
    taskService.createFromEvent({
      eventId: event.id,
      kind: "proactive_message",
      executeAt: remindersAt < clock.nowIso() ? clock.nowIso() : remindersAt,
      payload: { triggerKind: "event_due", reason: `事件即将发生：${event.title}` },
    });
  };
  eventEffects.onCompleted = (event) => {
    if (event.type === "promise" || event.type === "shared_experience" || event.type === "relationship_change") {
      relationshipService.applyChange(event.userId, event.characterId, [
        { dimension: "trust", delta: 0.03, reason: `共同完成：${event.title}`, source: "event" },
        { dimension: "affection", delta: 0.02, reason: `共同完成：${event.title}`, source: "event" },
      ]);
    }
  };

  /** 调度 → 触发 → 主动消息：调度器不生成内容，只决定"现在该检查什么"。 */
  scheduler.registerHandler("proactive_message", async (job) => {
    // 早期版本在"用户还没有角色"时就种下了 job，character_id 一直是 NULL；
    // 现在补一层兜底：用该用户的第一个角色，而不是直接跳过（跳过=自动消息永远发不出去）。
    const characterId = job.characterId ?? characters.listByUser(job.userId)[0]?.id ?? null;
    if (characterId === null) {
      logger.warn("proactive job skipped: no character available for this user", {
        step: "proactive.job",
        status: "failed",
        errorCategory: "no_character",
        jobId: job.id,
      });
      return { outcome: "skipped", reason: "job has no character and the user has no character yet" };
    }
    if (job.characterId === null) {
      logger.info("proactive job had no character bound; using the user's first character", {
        step: "proactive.job",
        status: "completed",
        jobId: job.id,
        characterId,
      });
    }
    const triggerKind = typeof job.payload.triggerKind === "string" ? job.payload.triggerKind : "idle_check";
    const result = await proactiveService.propose({
      userId: job.userId,
      characterId,
      triggerKind,
      reason: typeof job.payload.reason === "string" ? job.payload.reason : undefined,
      jobId: job.id,
    });
    if (result.decision.decision === "sent") return { outcome: "ran", reason: result.decision.triggerReason };
    if (result.decision.decision === "blocked") {
      return { outcome: "ran", reason: `blocked:${result.decision.blockedReason}`, detail: { blocked: true } };
    }
    return { outcome: "skipped", reason: result.decision.blockedReason ?? result.decision.triggerReason };
  });
  /**
   * 用户显式设置的定时消息：**按原文发送**，不走"现在该不该说话"的策略门（用户已经明确要求了），
   * 但仍走既有链路：scheduled_jobs → scheduler → runner → 写入会话（source=proactive）→ 渠道出站。
   */
  scheduler.registerHandler(SCHEDULED_MESSAGE_KIND, async (job) => {
    const payload = readScheduledMessagePayload(job);
    if (payload === null) return { outcome: "skipped", reason: "invalid scheduled message payload" };
    const conversation = conversations.getById(payload.conversationId);
    if (conversation === null) {
      logger.warn("scheduled message skipped: conversation no longer exists", {
        step: "schedule.deliver",
        status: "skipped",
        jobId: job.id,
      });
      return { outcome: "skipped", reason: "conversation no longer exists" };
    }
    /**
     * 用户明确要求换渠道时，去找他在**那个渠道**上与该角色的会话（通用查找，不涉及任何平台知识）；
     * 找不到就发回本条 job 自己的会话，并把这件事写进日志。
     */
    const target =
      payload.requestedChannel === null || payload.requestedChannel === conversation.channel
        ? conversation
        : conversations
            .listByUser(conversation.userId, 200)
            .find((entry) => entry.channel === payload.requestedChannel && entry.characterId === conversation.characterId) ?? conversation;
    if (target.id !== conversation.id) {
      logger.info("scheduled message redirected to the requested channel", {
        step: "schedule.deliver",
        status: "completed",
        jobId: job.id,
        requestedChannel: payload.requestedChannel,
      });
    }
    /**
     * 措辞：**不照抄记录原文**，交给角色用自己的语气把这件事说出来（复用主动消息那条上下文链路）。
     * 模型抽风/返回空 → 退回原文：提醒绝不能因为一次生成失败就丢掉。
     */
    const placeholder = messageWriter.begin({ conversationId: target.id, source: "proactive" });
    let text = payload.message;
    let composed = false;
    try {
      const generated = await reminderComposer.compose({
        conversation: target,
        userId: conversation.userId,
        reminderText: payload.message,
      });
      if (generated.length > 0) {
        text = generated;
        composed = true;
      }
    } catch (error) {
      logger.warn("reminder composer failed; falling back to the recorded reminder", {
        step: "schedule.compose",
        status: "failed",
        errorCategory: "compose_unavailable",
        jobId: job.id,
        error: (error as Error).message,
      });
    }
    messageWriter.finalize({ messageId: placeholder.id, text, status: "completed" });
    const sent = await outbound.send({
      target: { channel: target.channel, accountId: target.accountId, conversationRef: target.conversationId },
      text,
      messageId: placeholder.id,
      idempotencyKey: "scheduled:" + job.id,
    });
    logger.info("scheduled message delivered", {
      step: "schedule.deliver",
      status: sent.delivered ? "completed" : "failed",
      jobId: job.id,
      conversationId: target.id,
      delivered: sent.delivered,
      composed,
      ...(sent.delivered ? {} : { errorCategory: "send_failed" }),
    });
    if (!sent.delivered) return { outcome: "failed", reason: sent.error ?? "send failed" };
    return { outcome: "ran", reason: "scheduled message delivered" };
  });

  scheduler.registerHandler("event_maintenance", async () => {
    const expired = await eventService.expireOverdue(clock.nowIso());
    return { outcome: "ran", reason: `expired ${expired.length} events` };
  });
  scheduler.registerHandler("task_runner", async () => {
    const summary = await taskService.runDue();
    return { outcome: "ran", reason: `tasks due=${summary.due} ok=${summary.completed} failed=${summary.failed}` };
  });

  const schedulerRunner = createSchedulerRunner({
    scheduler,
    runTasks: async () => {
      await taskService.runDue();
    },
    logger,
    intervalMs: config.scheduler.intervalMs,
  });

  logger.info("container created", { dataDir: config.dataDir, database: db.kind, providers: providers.list().map((p) => p.id) });

  return {
    config,
    logger,
    db,
    events,
    credentials,
    providers,
    modelRouter,
    taskLLM,
    clock,
    services: {
      characters: charactersService,
      characterStudio,
      characterSwitch,
      conversations: conversationsService,
      summaries: summaryService,
      memory: memoryService,
      context: contextEngine,
      relationship: relationshipService,
      emotion: emotionService,
      characterState: characterStateService,
      events: eventService,
      tasks: taskService,
      proactive: proactiveService,
      scheduler,
    },
    outbound,
    schedulerRunner,
    mediaStorage,
    channelModules: channelModules.map((entry) => ({ name: entry.name, kind: entry.kind, module: entry.module })),
    repos: {
      users,
      characters,
      conversations,
      messages,
      channels: channelRepo,
      credentials: credentialRepo,
      settings,
      audit,
      memories,
      summaries,
      snapshots,
      usage,
      providerConfig,
      relationships: relationshipsRepo,
      emotions: emotionsRepo,
      eventsPhase3: eventsRepo,
      workTasks: workTasksRepo,
      scheduledJobs: scheduledJobsRepo,
      proactiveDecisions: proactiveDecisionsRepo,
      transcriptions,
      ttsSyntheses,
    },
    transcription: transcriptionService,
    tts: ttsService,
    pipeline,
    channels,
    web,
    webHub,
    keyProvider,
    user,
    webAccountId,
    startedAt: nowIso(),
    runs,
    async reloadProviders(): Promise<void> {
      // 注册表本身是可变对象，重建内容即可生效：TaskLLM / ModelRouter 持有的引用不变。
      await providers.rebuild(providerConfig.list());
      // ASR 使用同一份 Provider 配置：改完配置必须一起重建，否则设置页改了 ASR provider 也不会生效
      await asrProviders.rebuild(providerConfig.list(), settings.get<string | null>("asr.model", null));
      await ttsProviders.rebuild(
        providerConfig.list(),
        settings.get<string | null>("tts.model", null),
        settings.get<string | null>("tts.voice", null),
      );
      logger.info("provider registry reloaded", {
        providers: providers.list().map((p) => p.id),
        asrProviders: asrProviders.list().map((p) => p.id),
        ttsProviders: ttsProviders.list().map((p) => p.id),
      });
    },
    async shutdown(): Promise<void> {
      schedulerRunner.stop();
      await channels.stopAll();
      db.close();
    },
  };
}

export async function startChannels(container: Container): Promise<void> {
  try {
    await container.keyProvider.getMasterKey();
  } catch (error) {
    container.logger.error("master key initialization failed", { error: (error as Error).message });
    throw error;
  }
  await container.channels.startAll();
  seedDefaultJobs(container);
  if (container.config.scheduler.enabled) {
    container.schedulerRunner.start();
  }
}

/**
 * 首次启动写入两条默认调度：每天 22:00 的定时问候 + 每 30 分钟的冷淡期检查。
 * 两者都要经过 ProactivePolicy 才会真正发送。
 */
export function seedDefaultJobs(container: Container): void {
  const characterId = container.repos.characters.listByUser(container.user.id)[0]?.id ?? null;
  // 补偿：已有 job 但 character_id 是 NULL（当初种 job 时还没有任何角色）→ 补上，
  // 否则调度器每轮都只会返回 "job has no character"，主动消息永远不会生成。
  if (characterId !== null) {
    for (const job of container.repos.scheduledJobs.list({ limit: 200 })) {
      if (job.characterId === null && job.kind === "proactive_message") {
        container.repos.scheduledJobs.update({ ...job, characterId, updatedAt: container.clock.nowIso() });
        container.logger.info("scheduled job bound to the user's first character", {
          step: "scheduler.backfill",
          status: "completed",
          jobId: job.id,
          characterId,
        });
      }
    }
  }
  if (container.repos.scheduledJobs.list({ limit: 1 }).length > 0) return;
  const at = container.clock.nowIso();
  container.services.scheduler.createJob({
    userId: container.user.id,
    characterId,
    kind: "proactive_message",
    triggerType: "cron_like",
    runAt: null,
    cronExpr: "22:00",
    intervalMs: null,
    nextRunAt: at,
    enabled: true,
    misfirePolicy: "skip",
    payload: { triggerKind: "scheduled_window", reason: "到了晚上十点，你想跟对方说声晚安" },
  });
  container.services.scheduler.createJob({
    userId: container.user.id,
    characterId,
    kind: "proactive_message",
    triggerType: "idle",
    runAt: null,
    cronExpr: null,
    intervalMs: 30 * 60 * 1000,
    nextRunAt: at,
    enabled: true,
    misfirePolicy: "skip",
    payload: { triggerKind: "idle_check" },
  });
  container.services.scheduler.createJob({
    userId: container.user.id,
    characterId,
    kind: "event_maintenance",
    triggerType: "interval",
    runAt: null,
    cronExpr: null,
    intervalMs: 6 * 60 * 60 * 1000,
    nextRunAt: at,
    enabled: true,
    misfirePolicy: "skip",
    payload: {},
  });
}

export function mediaDir(config: AppConfig): string {
  return join(config.dataDir, "media");
}

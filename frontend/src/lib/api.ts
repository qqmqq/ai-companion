import type {
  CharacterDto,
  EmotionViewDto,
  EventDto,
  JobDto,
  ProactiveDecisionDto,
  ProactivePolicyDto,
  RelationshipItemDto,
  SchedulerStatusDto,
  TaskDto,
  WeixinLoginDto,
  WeixinStatusDto,
  QqStatusDto,
  ContextPreviewDto,
  ConversationDto,
  MemoryDto,
  MemoryHitDto,
  MessageDto,
  ProviderDto,
  RoutingItemDto,
  UsageSummaryDto,
} from "./types.ts";

/**
 * 后端错误体是 { error: { code, message } }：只把"给人看的那句话"抛出去。
 * 绝不把原始 body（可能很长、可能是 HTML 错误页、可能带堆栈）直接丢到界面上。
 */
async function errorText(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // 不是 JSON（反向代理的 HTML 错误页等）：退回到状态码
  }
  return response.status + " " + response.statusText;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(await errorText(response));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface StreamEvent {
  name: string;
  payload: { conversationId?: string; messageId?: string; delta?: string; text?: string; runId?: string; complete?: boolean; error?: string };
}

/** 角色定义（新建与编辑都用它）：只包含本程序自己的字段 */
export interface CharacterDefinitionInput {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  systemPrompt: string;
  firstMessage: string;
}

/** 角色工坊：一次对话里的来回（前端保存，后端无状态） */
export interface StudioTurn {
  role: "user" | "assistant";
  text: string;
}

export interface DefinitionChange {
  field: keyof CharacterDefinitionInput;
  label: string;
  before: string;
  after: string;
}

export interface StudioResult {
  definition: CharacterDefinitionInput;
  reply: string;
  changes: DefinitionChange[];
}

export const api = {
  health: () => request<{ status: string; channels: Array<{ channel: string; state: string }> }>("/api/system/health"),

  characters: () => request<{ items: CharacterDto[] }>("/api/characters").then((r) => r.items),
  createCharacter: (input: CharacterDefinitionInput) =>
    request<CharacterDto>("/api/characters", { method: "POST", body: JSON.stringify(input) }),
  /** 编辑 = 新版本：已有会话继续用旧版本，新会话用新版本 */
  updateCharacter: (id: string, patch: Partial<CharacterDefinitionInput>) =>
    request<CharacterDto>("/api/characters/" + id, { method: "PATCH", body: JSON.stringify(patch) }),
  /** 角色工坊第一步：几句设想 → 完整角色设定（不落库，用户确认后才保存） */
  draftCharacter: (input: { ideas: string; history?: StudioTurn[] }) =>
    request<StudioResult>("/api/characters/draft", { method: "POST", body: JSON.stringify(input) }),
  /** 角色工坊第二步：当前设定 + 一句人话要求 → 改完的完整设定（同样不落库） */
  reviseCharacter: (input: { definition: CharacterDefinitionInput; instruction: string; history?: StudioTurn[] }) =>
    request<StudioResult>("/api/characters/revise", { method: "POST", body: JSON.stringify(input) }),
  deleteCharacter: (id: string) => request<void>("/api/characters/" + id, { method: "DELETE" }),
  duplicateCharacter: (id: string) =>
    request<CharacterDto>("/api/characters/" + id + "/duplicate", { method: "POST" }),
  setCharacterAvatar: (id: string, filename: string, base64: string) =>
    request<CharacterDto>("/api/characters/" + id + "/avatar", { method: "PUT", body: JSON.stringify({ filename, base64 }) }),
  clearCharacterAvatar: (id: string) => request<CharacterDto>("/api/characters/" + id + "/avatar", { method: "DELETE" }),
  /** 头像或第一版时的首条消息都用它；没有头像时后端返回 404 */
  characterAvatarUrl: (id: string) => "/api/characters/" + id + "/avatar",

  conversations: () => request<{ items: ConversationDto[] }>("/api/conversations").then((r) => r.items),
  /** newSession=true：开一个绑定**当前**角色版本的新会话（旧会话继续用它们各自的旧版本） */
  createConversation: (characterId: string, options: { newSession?: boolean } = {}) =>
    request<ConversationDto>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ characterId, ...(options.newSession === true ? { newSession: true } : {}) }),
    }),
  /** 后台里换角色：与微信里发「切换角色 X」同一条逻辑（新角色 = 新会话 = 开场白） */
  switchConversationCharacter: (conversationId: string, characterId: string) =>
    request<{
      conversationId: string;
      characterId: string | null;
      characterName: string;
      newConversation: boolean;
      text: string;
      delivered: boolean;
      deliveryError: string | null;
    }>("/api/conversations/" + conversationId + "/active-character", {
      method: "PUT",
      body: JSON.stringify({ characterId }),
    }),
  /** 删除会话：只删这一个会话（消息一起删；角色/微信账号/登录状态不受影响） */
  deleteConversation: (conversationId: string) =>
    request<void>("/api/conversations/" + conversationId, { method: "DELETE" }),
  messages: (conversationId: string) =>
    request<{ items: MessageDto[] }>(`/api/conversations/${conversationId}/messages`).then((r) => r.items),

  /** Phase 4.5-D4：显式生成/重新生成一条消息的语音（只生成，不投递） */
  generateSpeech: (messageId: string, force = false) =>
    request<{ message: MessageDto }>(`/api/messages/${messageId}/speech`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }).then((r) => r.message),

  sendMessage: (conversationId: string, text: string) =>
    request<{ items: MessageDto[] }>(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }).then((r) => r.items),
  streamMessage: (conversationId: string, text: string) =>
    request<{ runId: string; userMessageId: string; conversationId: string }>(
      `/api/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ text, stream: true }) },
    ),
  abortRun: (runId: string) => request<{ aborted: boolean }>(`/api/runs/${runId}/abort`, { method: "POST" }),

  contextPreview: (conversationId: string, text: string) =>
    request<ContextPreviewDto>(`/api/conversations/${conversationId}/context-preview`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  memories: (characterId?: string) =>
    request<{ items: MemoryDto[]; total: number }>(
      `/api/memories?${characterId === undefined ? "" : `characterId=${characterId}`}`,
    ),
  searchMemories: (text: string, characterId?: string) =>
    request<{ items: MemoryHitDto[] }>("/api/memories/search", {
      method: "POST",
      body: JSON.stringify({ text, limit: 10, ...(characterId === undefined ? {} : { characterId }) }),
    }),
  memoryDetail: (id: string) =>
    request<{ memory: MemoryDto; sourceMessage: MessageDto | null; links: Array<{ targetType: string; targetId: string }> }>(
      `/api/memories/${id}`,
    ),
  updateMemoryImportance: (id: string, importance: number) =>
    request<MemoryDto>(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify({ importance }) }),
  deleteMemory: (id: string) => request<void>(`/api/memories/${id}`, { method: "DELETE" }),

  providers: () => request<{ items: ProviderDto[] }>("/api/providers").then((r) => r.items),
  upsertProvider: (input: Record<string, unknown>) =>
    request<ProviderDto>("/api/providers", { method: "POST", body: JSON.stringify(input) }),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    request<{ ok: boolean; models: Array<{ id: string; displayName: string }>; error?: { kind: string; message: string } }>(
      `/api/providers/${id}/test`,
      { method: "POST" },
    ),
  routing: () => request<{ items: RoutingItemDto[] }>("/api/model-routing").then((r) => r.items),
  /** model 传 null = 用该 Provider 的默认模型 */
  setRoute: (taskType: string, providerId: string, model: string | null) =>
    request<{ taskType: string }>("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId, model }) }),
  usage: () =>
    request<{ summary: UsageSummaryDto[]; recent: Array<{ providerId: string; model: string; taskType: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean; createdAt: string }> }>(
      "/api/usage?days=7",
    ),

  // ---- Phase 3 ----
  relationships: () => request<{ items: RelationshipItemDto[] }>("/api/relationships").then((r) => r.items),
  relationshipDetail: (characterId: string) =>
    request<{
      relationship: { stage: string; updatedAt: string };
      milestones: Array<{ id: string; label: string; at: string }>;
      changes: Array<{ id: string; dimension: string; delta: number; reason: string; source: string; createdAt: string }>;
    }>(`/api/relationships/${characterId}`),
  emotion: (characterId: string) => request<EmotionViewDto>(`/api/emotions/${characterId}`),
  deleteRelationshipChange: (characterId: string, changeId: string) =>
    request<void>(`/api/relationships/${characterId}/changes/${changeId}`, { method: "DELETE" }),
  deleteRelationshipMilestone: (characterId: string, milestoneId: string) =>
    request<void>(`/api/relationships/${characterId}/milestones/${milestoneId}`, { method: "DELETE" }),
  deleteEmotionHistory: (characterId: string, entryId: string) =>
    request<void>(`/api/emotions/${characterId}/history/${entryId}`, { method: "DELETE" }),

  events: (characterId?: string) =>
    request<{ items: EventDto[] }>(`/api/events${characterId === undefined ? "" : `?characterId=${characterId}`}`).then((r) => r.items),
  createEvent: (input: { characterId: string; type: string; title: string; description?: string; importance?: number; dueAt?: string | null }) =>
    request<EventDto>("/api/events", { method: "POST", body: JSON.stringify(input) }),
  completeEvent: (id: string) => request<EventDto>(`/api/events/${id}/complete`, { method: "POST" }),
  cancelEvent: (id: string) => request<EventDto>(`/api/events/${id}/cancel`, { method: "POST" }),
  deleteEvent: (id: string) => request<void>(`/api/events/${id}`, { method: "DELETE" }),

  tasks: (characterId?: string) =>
    request<{ items: TaskDto[] }>(`/api/tasks${characterId === undefined ? "" : `?characterId=${characterId}`}`).then((r) => r.items),
  createTask: (input: { characterId: string; kind: string; executeAt: string }) =>
    request<TaskDto>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  completeTask: (id: string) => request<TaskDto>(`/api/tasks/${id}/complete`, { method: "POST" }),
  cancelTask: (id: string) => request<TaskDto>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  runTasks: () => request<{ due: number; completed: number; failed: number }>("/api/tasks/run", { method: "POST" }),

  schedulerStatus: () => request<SchedulerStatusDto>("/api/scheduler/status"),
  schedulerJobs: () => request<{ items: JobDto[] }>("/api/scheduler/jobs").then((r) => r.items),
  schedulerTick: () => request<{ scheduler: { due: number; ran: number }; tasks: { due: number } }>("/api/scheduler/tick", { method: "POST" }),
  setJobEnabled: (id: string, enabled: boolean) => request<JobDto>(`/api/scheduler/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  runJobNow: (id: string) => request<{ outcome: string; reason: string }>(`/api/scheduler/jobs/${id}/run`, { method: "POST" }),
  /** 删除一条定时提醒（系统自己的调度任务不允许删，后端会明确拒绝） */
  deleteJob: (id: string) => request<void>(`/api/scheduler/jobs/${id}`, { method: "DELETE" }),

  proactiveSettings: () =>
    request<{ policy: ProactivePolicyDto; eligibility: Array<{ characterId: string; characterName: string; decision: { allowed: boolean; blockedReason: string | null } }> }>(
      "/api/proactive/settings",
    ),
  updateProactiveSettings: (patch: Partial<ProactivePolicyDto>) =>
    request<{ policy: ProactivePolicyDto }>("/api/proactive/settings", { method: "PUT", body: JSON.stringify(patch) }),
  proactiveDecisions: (characterId?: string) =>
    request<{ items: ProactiveDecisionDto[] }>(`/api/proactive/decisions${characterId === undefined ? "" : `?characterId=${characterId}`}`).then((r) => r.items),
  proactivePreview: (characterId: string, reason: string) =>
    request<{ decision: ProactiveDecisionDto; text: string | null }>("/api/proactive/preview", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual", reason }),
    }),
  proactiveTrigger: (characterId: string) =>
    request<{ decision: ProactiveDecisionDto; text: string | null }>("/api/proactive/trigger", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual" }),
    }),

  // ---- 微信通道（Phase 4，仅文字消息）----
  weixinStatus: () => request<WeixinStatusDto>("/api/channels/weixin/status"),
  weixinStartLogin: () => request<WeixinLoginDto>("/api/channels/weixin/login", { method: "POST" }),
  weixinPollLogin: (sessionId: string) => request<WeixinLoginDto>(`/api/channels/weixin/login/${sessionId}`),
  weixinSubmitCode: (sessionId: string, code: string) =>
    request<WeixinLoginDto>(`/api/channels/weixin/login/${sessionId}/verify-code`, { method: "POST", body: JSON.stringify({ code }) }),
  weixinCompleteLogin: (sessionId: string) =>
    request<{ accountId: string; displayName: string }>(`/api/channels/weixin/login/${sessionId}/complete`, { method: "POST" }),
  weixinCancelLogin: (sessionId: string) =>
    request<{ cancelled: boolean }>(`/api/channels/weixin/login/${sessionId}/cancel`, { method: "POST" }),
  weixinRemoveAccount: (accountId: string) => request<void>(`/api/channels/weixin/accounts/${accountId}`, { method: "DELETE" }),

  /** QQ 机器人：状态、保存配置、重连、断开、清密钥（密钥只进不出） */
  qqStatus: () => request<QqStatusDto>("/api/channels/qq/status"),
  qqSaveConfig: (input: { appId: string; clientSecret?: string; sandbox?: boolean }) =>
    request<{ ok: boolean }>("/api/channels/qq/config", { method: "PUT", body: JSON.stringify(input) }),
  qqReconnect: () => request<{ ok: boolean }>("/api/channels/qq/reconnect", { method: "POST" }),
  qqDisconnect: () => request<{ ok: boolean }>("/api/channels/qq/disconnect", { method: "POST" }),
  qqClearCredentials: () => request<{ ok: boolean }>("/api/channels/qq/credentials", { method: "DELETE" }),
  weixinRelogin: (accountId: string) =>
    request<{ ok: boolean; reason: string | null }>(`/api/channels/weixin/accounts/${accountId}/relogin`, { method: "POST" }),

  subscribeEvents: (onEvent: (event: StreamEvent) => void): (() => void) => {
    const source = new EventSource("/api/events/stream");
    const names = ["message.new", "message.delta", "conversation.updated", "character.created", "channel.status"];
    for (const name of names) {
      source.addEventListener(name, (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as { name: string; payload: StreamEvent["payload"] };
          onEvent({ name: parsed.name, payload: parsed.payload ?? {} });
        } catch {
          onEvent({ name, payload: {} });
        }
      });
    }
    return () => source.close();
  },
};
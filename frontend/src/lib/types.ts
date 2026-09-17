export interface CharacterDto {
  id: string;
  name: string;
  slug: string;
  /** 头像：指向 MediaStorage 的引用；没上传头像时为 null */
  avatarMediaId: string | null;
  /** 定义版本数：编辑一次 +1，历史版本保留（已有会话仍绑定旧版本） */
  versionCount: number;
  /** 角色定义：本程序自己的模型（改它会产生新版本，已有会话仍用旧版本） */
  definition: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    systemPrompt: string;
    firstMessage: string;
  };
  state: {
    emotion: { primary: string; intensity: number };
    activity: { label: string };
    location: { label: string };
    energy: number;
    autonomyLevel: string;
  };
}


export interface ConversationDto {
  id: string;
  characterId: string;
  title: string;
  lastMessageAt: string | null;
  /** 会话来源：web / weixin —— 来源写在会话上，不靠"最后一条消息从哪来"推断 */
  source: "web" | "weixin" | string;
  channel: string;
  /** 列表预览用的最后一条消息文本 */
  lastMessageText: string | null;
  /** Phase 5：会话冻结的角色版本（改卡不影响已有会话） */
  characterVersionId?: string | null;
  /** 渠道聊天里"现在在跟谁聊"（微信里用「切换角色 X」换过之后就有值） */
  activeCharacterId?: string | null;
}

/** 与后端 Core 的通用媒体模型对应（Phase 4.5-A）。 */
export interface MediaReferenceDto {
  mediaId: string | null;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  origin: "channel" | "generated" | "external";
  status: "pending" | "available" | "failed" | "expired";
  url: { kind: "internal" | "external"; value: string } | null;
}

export type MessagePartDto =
  | { kind: "text"; text: string }
  | { kind: "quote"; ref: { providerMessageId: string; text: string | null; status: string } }
  | { kind: "image"; media: MediaReferenceDto; caption?: string }
  | {
      kind: "audio";
      media: MediaReferenceDto;
      transcript?: string;
      /** Phase 4.5-D3：语音转写状态（与 media.status 独立） */
      transcription?: {
        status: "pending" | "processing" | "completed" | "failed";
        text: string | null;
        language: string | null;
        durationMs: number | null;
        confidence: number | null;
        provider: string | null;
        model: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        updatedAt: string;
        cached: boolean;
      };
      caption?: string;
    }
  | { kind: "video"; media: MediaReferenceDto; caption?: string }
  | { kind: "file"; media: MediaReferenceDto; caption?: string }
  | { kind: string; [key: string]: unknown };

/** Phase 4.5-D4：消息级语音合成状态（与转写状态彼此独立） */
export interface TtsStateDto {
  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  mediaId: string | null;
  mimeType: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  provider: string | null;
  model: string | null;
  voice: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cached: boolean;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: "user" | "character" | "system" | "tool";
  text: string;
  /** Phase 4.5-D4：这条回复的语音状态（没有语音时为 undefined） */
  tts?: TtsStateDto;
  /** 统一富内容片段；老消息只有 text 时该字段为 [{kind:"text"}] */
  parts?: MessagePartDto[];
  status: "partial" | "completed" | "failed";
  errorText: string | null;
  createdAt: string;
}

export interface ProviderDto {
  id: string;
  kind: "openai-compatible" | "ollama" | "echo";
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  requiresCredential: boolean;
  hasCredential: boolean;
  timeoutMs: number;
  enabled: boolean;
}

export interface RoutingItemDto {
  taskType: string;
  configured: { providerId: string | null; model: string | null } | null;
  resolved: { providerId: string; model: string };
}

export interface UsageSummaryDto {
  taskType: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number | null;
  avgLatencyMs: number;
}

export interface MemoryDto {
  id: string;
  scope: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
  characterId: string | null;
  conversationId: string | null;
  sourceMessageId: string | null;
  reinforcement: number;
  accessCount: number;
  status: string;
  createdAt: string;
}

export interface MemoryHitDto {
  memory: MemoryDto;
  score: number;
  components: { fts: number; importance: number; recency: number; reinforcement: number };
}

export interface ContextSectionDto {
  kind: string;
  priority: number;
  title: string;
  role: string;
  tokenEstimate: number;
  truncated: boolean;
  text: string;
}

export interface ContextPreviewDto {
  model: { providerId: string; model: string };
  totalTokens: number;
  budgetTokens: number;
  sections: ContextSectionDto[];
  dropped: Array<{ kind: string; reason: string; detail: string }>;
  memoryHits: Array<{ memoryId: string; score: number }>;
}
export interface RelationshipItemDto {
  characterId: string;
  characterName: string;
  stage: string;
  dimensions: {
    familiarity: number;
    trust: number;
    affection: number;
    intimacy: number;
    respect: number;
    dependence: number;
  };
  updatedAt: string;
}

export interface EmotionStateDto {
  primary: string;
  secondary: string | null;
  intensity: number;
  valence: number;
  arousal: number;
  energy: number;
  reason: string;
  startedAt: string;
}

export interface EmotionHistoryItemDto {
  id: string;
  before: EmotionStateDto | null;
  after: EmotionStateDto;
  reason: string;
  source: string;
  createdAt: string;
  intensity: number;
}

export interface EmotionViewDto {
  emotion: EmotionStateDto;
  mood: string;
  scheduleState: string;
  activity: { label: string };
  location: { label: string };
  energy: number;
  lastInteractionAt: string | null;
  history: EmotionHistoryItemDto[];
}

export interface EventDto {
  id: string;
  characterId: string;
  type: string;
  title: string;
  description: string;
  status: "planned" | "active" | "completed" | "cancelled" | "expired";
  importance: number;
  dueAt: string | null;
  occurredAt: string | null;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  characterId: string;
  kind: string;
  /** 任务载荷：用户用自然语言创建的任务把标题放在这里（沿用既有 schema，不新增列） */
  payload?: { title?: string } & Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  priority: number;
  executeAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  eventId: string | null;
}

export interface JobDto {
  id: string;
  characterId: string | null;
  kind: string;
  triggerType: string;
  cronExpr: string | null;
  intervalMs: number | null;
  nextRunAt: string;
  lastRunAt: string | null;
  enabled: boolean;
  status: string;
  /** 定时提醒的原文与目标渠道（channel: web / weixin）都在这里 */
  payload?: Record<string, unknown>;
}

export interface ProactivePolicyDto {
  enabled: boolean;
  autonomy: "passive" | "low" | "normal" | "high" | "autonomous";
  quietHours: { enabled: boolean; start: string; end: string };
  dailyLimit: number;
  cooldownMs: number;
  inactivityThresholdMs: number;
}

export interface ProactiveDecisionDto {
  id: string;
  triggerKind: string;
  triggerReason: string;
  decision: "sent" | "blocked" | "failed" | "skipped";
  blockedReason: string | null;
  autonomy: string | null;
  model: string | null;
  messageId: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
}

export interface SchedulerStatusDto {
  runner: { running: boolean; intervalMs: number; ticks: number; lastTickAt: string | null; lastError: string | null };
  jobs: number;
  enabled: number;
  failing: number;
  nextJobs: Array<{ id: string; kind: string; nextRunAt: string; triggerType: string; enabled: boolean }>;
  lastExecution: string | null;
  pendingTasks: number;
  failedTasks: number;
}
/** QQ 渠道状态（密钥永远不在这里） */
export interface QqStatusDto {
  configured: boolean;
  appId: string | null;
  sandbox: boolean | null;
  baseUrl: string | null;
  credentialsSaved: boolean;
  session: {
    state: "not_configured" | "disconnected" | "connecting" | "connected" | "reconnecting" | "credential_invalid" | "stopped";
    lastError: string | null;
    lastEventAt: string | null;
    consecutiveFailures: number;
    gatewaySessions: number;
  };
  token: { state: "none" | "valid" | "expired"; expiresAt: string | null };
  health: { state: string; accounts: number; message: string | null };
  accounts: Array<{ id: string; externalAccountId: string; displayName: string; status: string }>;
}

export interface WeixinAccountDto {
  accountId: string;
  displayName: string;
  state: "disconnected" | "connecting" | "connected" | "reconnecting" | "credential_invalid" | "stopped";
  loggedIn: boolean;
  requiresRelogin: boolean;
  lastError: string | null;
  consecutiveFailures: number;
  lastEventAt: string | null;
}

export interface WeixinLoginDto {
  sessionId: string;
  phase:
    | "waiting_scan"
    | "scanned"
    | "need_verifycode"
    | "verify_code_blocked"
    | "expired"
    | "redirected"
    | "already_bound"
    | "logged_in"
    | "failed"
    | "cancelled";
  qrcode: string | null;
  qrcodeImageContent: string | null;
  needsVerifyCode: boolean;
  message: string;
  refreshCount: number;
  expiresAt: string;
}

export interface WeixinStatusDto {
  enabled: boolean;
  accounts: WeixinAccountDto[];
  health: { state: string; message: string | null };
}
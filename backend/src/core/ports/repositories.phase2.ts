import type {
  Memory,
  MemoryLink,
  MemoryQuery,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "../model/memory.ts";
import type { ContextSnapshotRecord } from "../model/context.ts";
import type { ModelUsageInput, ModelUsageRecord, ProviderConfig, ModelRoute } from "../model/usage.ts";
import type { CharacterId, ConversationId, MessageId, UserId } from "../model/ids.ts";
import type { TaskType } from "../model/task.ts";

/** 记忆持久化端口。抽取与写库解耦：抽取产出候选，写库由本端口负责。 */
export interface MemoryRepository {
  insert(memory: Memory): void;
  getById(id: string): Memory | null;
  findByHash(input: {
    scope: MemoryScope;
    contentHash: string;
    characterId: CharacterId | null;
    userId: UserId | null;
  }): Memory | null;
  update(memory: Memory): void;
  touchAccess(ids: string[], at: string): void;
  delete(id: string): void;
  setStatus(id: string, status: MemoryStatus, supersededBy?: string | null): void;
  list(filter: {
    userId?: UserId | null;
    characterId?: CharacterId | null;
    conversationId?: ConversationId | null;
    scope?: MemoryScope;
    type?: MemoryType;
    status?: MemoryStatus;
    limit: number;
    offset?: number;
  }): Memory[];
  count(filter?: { characterId?: CharacterId | null; status?: MemoryStatus }): number;
  /** 关键词候选（FTS5）；没有命中时返回空数组，由调用方决定回退策略。 */
  searchByText(query: MemoryQuery): Array<{ memory: Memory; ftsScore: number }>;
  protectedMemories(input: { userId: UserId | null; characterId: CharacterId | null; limit: number }): Memory[];

  insertLink(link: MemoryLink): void;
  listLinks(fromMemoryId: string): MemoryLink[];
  deleteLinks(fromMemoryId: string): void;

  /**
   * 会话被删除时的记忆处理（**只影响这一个会话**）：
   * - scope = "conversation" 且属于该会话的记忆属于这个会话 → 删除；
   * - 其它记忆（user / character / world 等长期记忆）只解除 conversation_id 引用 → **保留**；
   * - 指向该会话 / 它的消息的记忆链接一并清掉，避免悬空。
   */
  forgetConversation(conversationId: ConversationId): { deletedMemories: number; detachedMemories: number };
}

export interface SummaryRepository {
  insert(summary: {
    id: string;
    conversationId: ConversationId;
    fromMessageId: MessageId;
    toMessageId: MessageId;
    summary: string;
    tokenEstimate: number | null;
    model: string | null;
    providerId: string | null;
    createdAt: string;
  }): void;
  latest(conversationId: ConversationId): SummaryRecord | null;
  list(conversationId: ConversationId, limit: number): SummaryRecord[];
  count(conversationId: ConversationId): number;
}

export interface SummaryRecord {
  id: string;
  conversationId: ConversationId;
  fromMessageId: MessageId;
  toMessageId: MessageId;
  summary: string;
  tokenEstimate: number | null;
  model: string | null;
  providerId: string | null;
  createdAt: string;
}

export interface ContextSnapshotRepository {
  insert(snapshot: ContextSnapshotRecord): void;
  getById(id: string): ContextSnapshotRecord | null;
  latestForMessage(messageId: MessageId): ContextSnapshotRecord | null;
  listByConversation(conversationId: ConversationId, limit: number): ContextSnapshotRecord[];
  count(): number;
}

export interface ModelUsageRepository {
  insert(id: string, usage: ModelUsageInput, createdAt: string): ModelUsageRecord;
  listRecent(limit: number): ModelUsageRecord[];
  summary(sinceIso: string): Array<{
    taskType: TaskType;
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number | null;
    avgLatencyMs: number;
  }>;
}

export interface ProviderConfigRepository {
  upsert(config: ProviderConfig): void;
  get(id: string): ProviderConfig | null;
  list(): ProviderConfig[];
  delete(id: string): void;

  upsertRoute(route: ModelRoute): void;
  getRoute(taskType: TaskType): ModelRoute | null;
  listRoutes(): ModelRoute[];
  deleteRoute(taskType: TaskType): void;
  /** 删 provider 时顺手删掉指向它的路由，避免留下"指向不存在 provider"的悬空路由 */
  deleteRoutesByProvider(providerId: string): void;
}

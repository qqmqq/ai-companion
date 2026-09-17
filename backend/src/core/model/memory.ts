import type { CharacterId, ConversationId, MessageId, UserId } from "./ids.ts";

/** 记忆作用域：报告 §8.1 的分层用同一张表 + scope 表达。 */
export type MemoryScope = "global" | "user" | "character" | "conversation" | "event" | "world";

export type MemoryType =
  | "fact"
  | "preference"
  | "identity"
  | "event"
  | "promise"
  | "emotion_peak"
  | "summary";

export type MemoryStatus = "active" | "merged" | "archived" | "forgotten";

export interface Memory {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  contentHash: string;
  importance: number; // 0..1
  confidence: number; // 0..1
  userId: UserId | null;
  characterId: CharacterId | null;
  conversationId: ConversationId | null;
  sourceMessageId: MessageId | null;
  tags: string[];
  /** 被反复提及时累加，用于强化 */
  reinforcement: number;
  accessCount: number;
  lastAccessedAt: string | null;
  /** 语义去重用的可选向量；Phase 2 默认 NULL，仅留字段 */
  embedding: number[] | null;
  supersededBy: string | null;
  status: MemoryStatus;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 抽取阶段的产物：还没有 id、还没入库（抽取与写库解耦）。 */
export interface MemoryCandidate {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
  occurredAt: string;
}

export type MemoryLinkRelation =
  | "same_event"
  | "same_subject"
  | "causes"
  | "contradicts"
  | "supersedes"
  | "derived_from";

export type MemoryLinkTarget = "memory" | "message" | "character" | "user" | "conversation";

export interface MemoryLink {
  id: string;
  fromMemoryId: string;
  relation: MemoryLinkRelation;
  targetType: MemoryLinkTarget;
  targetId: string;
  weight: number;
  createdAt: string;
}

export interface MemoryQuery {
  text: string;
  userId?: UserId | null;
  characterId?: CharacterId | null;
  conversationId?: ConversationId | null;
  scopes?: MemoryScope[];
  limit: number;
  /** 是否把长期事实（identity/promise）无条件优先纳入 */
  includeProtected?: boolean;
}

export interface MemoryHit {
  memory: Memory;
  score: number;
  components: { fts: number; importance: number; recency: number; reinforcement: number };
}

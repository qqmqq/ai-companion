import type { TaskType } from "./task.ts";

/**
 * 上下文分区：每一块都有优先级与来源，便于按预算取舍与事后审计。
 * 优先级数字越小越先保留（P0 最高）。
 */
export type ContextSectionKind =
  | "current_message" // P0
  | "proactive_intent" // 主动消息：为什么现在要说话
  | "app_instructions" // 应用级系统约束（永远最前）
  | "character_system_prompt" // 角色自己的 system prompt
  | "character_definition"
  | "recent_conversation"
  | "runtime_state"
  | "emotion_state"
  | "relationship_state"
  | "memories"
  | "events"
  | "conversation_summary"
  | "background";

export interface ContextSection {
  kind: ContextSectionKind;
  priority: number;
  title: string;
  role: "system" | "user" | "assistant";
  text: string;
  tokenEstimate: number;
  /** 溯源：命中的记忆 id、消息 id 等（用于快照与调试） */
  sourceIds: string[];
  truncated: boolean;
}

export interface ContextBundle {
  sections: ContextSection[];
  totalTokens: number;
  budgetTokens: number;
  dropped: Array<{ kind: ContextSectionKind; reason: "over_budget" | "duplicate"; detail: string }>;
  memoryHits: Array<{ memoryId: string; score: number; reason: string }>;
  summaryId: string | null;
  /** 本次上下文用于普通回复还是主动消息 */
  source: "conversation" | "proactive";
  /** 主动消息的触发原因（可解释性） */
  triggerReason: string | null;
}

export interface ContextSnapshotInput {
  conversationId: string;
  characterId: string;
  messageId: string;
  taskType: TaskType;
  providerId: string | null;
  model: string | null;
  bundle: ContextBundle;
}

export interface ContextSnapshotRecord {
  id: string;
  conversationId: string;
  characterId: string;
  messageId: string;
  taskType: string;
  providerId: string | null;
  model: string | null;
  totalTokens: number;
  budgetTokens: number;
  sections: Array<{
    kind: string;
    priority: number;
    title: string;
    tokenEstimate: number;
    sourceIds: string[];
    truncated: boolean;
  }>;
  memoryIds: string[];
  dropped: ContextBundle["dropped"];
  source: string;
  triggerReason: string | null;
  createdAt: string;
}
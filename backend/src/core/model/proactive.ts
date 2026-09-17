import type { CharacterId, ConversationId, MessageId, UserId } from "./ids.ts";

/** 自主等级：0 = 完全被动，1 = 最主动。 */
export type AutonomyLevel = "passive" | "low" | "normal" | "high" | "autonomous";

export const AUTONOMY_ORDER: AutonomyLevel[] = ["passive", "low", "normal", "high", "autonomous"];

export interface QuietHours {
  enabled: boolean;
  /** "23:00" 形式，跨夜表示 23:00 → 08:00 */
  start: string;
  end: string;
}

export interface ProactivePolicy {
  enabled: boolean;
  autonomy: AutonomyLevel;
  quietHours: QuietHours;
  dailyLimit: number;
  cooldownMs: number;
  /** 用户多久没说话才算"冷淡期"（用于闲置触发） */
  inactivityThresholdMs: number;
}

export const DEFAULT_PROACTIVE_POLICY: ProactivePolicy = {
  enabled: true,
  autonomy: "normal",
  quietHours: { enabled: true, start: "23:00", end: "08:00" },
  dailyLimit: 3,
  cooldownMs: 30 * 60 * 1000,
  inactivityThresholdMs: 24 * 60 * 60 * 1000,
};

export type ProactiveDecisionValue = "sent" | "blocked" | "failed" | "skipped";

export type ProactiveBlockedReason =
  | "disabled"
  | "autonomy_passive"
  | "quiet_hours"
  | "daily_limit"
  | "cooldown"
  | "not_eligible"
  | "no_conversation"
  | "generation_failed"
  | "send_failed"
  | "empty_generation";

/** 主动消息决策审计：为什么触发 / 为什么没触发。 */
export interface ProactiveDecision {
  id: string;
  userId: UserId;
  characterId: CharacterId;
  conversationId: ConversationId | null;
  jobId: string | null;
  triggerKind: string;
  triggerReason: string;
  decision: ProactiveDecisionValue;
  blockedReason: ProactiveBlockedReason | null;
  autonomy: AutonomyLevel | null;
  providerId: string | null;
  model: string | null;
  messageId: MessageId | null;
  contextSnapshotId: string | null;
  latencyMs: number | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 触发评估结果：先规则判断，再决定要不要花钱调用模型。 */
export interface ProactiveTriggerEvaluation {
  eligible: boolean;
  triggerKind: string;
  reason: string;
  /** 供 ContextEngine 使用的"为什么要主动说话" */
  proactiveIntent: string;
}

export interface ProactivePolicyDecision {
  allowed: boolean;
  blockedReason: ProactiveBlockedReason | null;
  detail: Record<string, unknown>;
}

export interface ProactiveResult {
  decision: ProactiveDecision;
  message: MessageId | null;
  text: string | null;
}

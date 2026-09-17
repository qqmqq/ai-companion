import type { CharacterId, ConversationId, MessageId, UserId } from "./ids.ts";

/**
 * 情绪标签是开放集合：内置常见标签，但允许任意字符串，
 * 避免"只能表达 6 种情绪"的硬编码。
 */
export const BUILTIN_EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "calm",
  "sad",
  "lonely",
  "tired",
  "angry",
  "fear",
  "surprise",
  "shy",
  "worried",
  "grateful",
] as const;

export type BuiltinEmotion = (typeof BUILTIN_EMOTIONS)[number];
export type EmotionLabel = BuiltinEmotion | (string & {});

/** 短期状态：与关系（长期）并列但独立。 */
export interface EmotionState {
  primary: EmotionLabel;
  secondary: EmotionLabel | null;
  /** 0..1 */
  intensity: number;
  /** -1..1 愉悦度 */
  valence: number;
  /** 0..1 唤醒度 */
  arousal: number;
  /** 0..1 精力（与情绪相关但独立，供日程/主动消息使用） */
  energy: number;
  reason: string;
  source: string;
  startedAt: string;
  /** 半衰期：到点后向基线回落 */
  halfLifeMs: number;
}

/** 模型/规则产出的情绪变化意图（不直接写库）。 */
export interface EmotionChange {
  primary?: EmotionLabel;
  secondary?: EmotionLabel | null;
  intensity?: number;
  valence?: number;
  arousal?: number;
  energy?: number;
  reason: string;
  source: string;
  triggerKind?: string;
  sourceMessageId?: MessageId | null;
  conversationId?: ConversationId | null;
}

export interface EmotionHistoryEntry {
  id: string;
  characterId: CharacterId;
  userId: UserId | null;
  before: EmotionState | null;
  after: EmotionState;
  reason: string;
  source: string;
  triggerKind: string | null;
  sourceMessageId: string | null;
  conversationId: string | null;
  intensity: number;
  createdAt: string;
}

export function neutralEmotion(at: string): EmotionState {
  return {
    primary: "neutral",
    secondary: null,
    intensity: 0.2,
    valence: 0,
    arousal: 0.3,
    energy: 0.8,
    reason: "initial",
    source: "system",
    startedAt: at,
    halfLifeMs: 60 * 60 * 1000,
  };
}

import type { CharacterId, UserId } from "./ids.ts";

/** 关系维度：长期状态。与 Memory（发生过什么）、Emotion（短期状态）严格区分。 */
export interface RelationshipDimensions {
  familiarity: number;
  trust: number;
  affection: number;
  intimacy: number;
  respect: number;
  dependence: number;
}

export type RelationshipDimension = keyof RelationshipDimensions;

export const RELATIONSHIP_DIMENSIONS: RelationshipDimension[] = [
  "familiarity",
  "trust",
  "affection",
  "intimacy",
  "respect",
  "dependence",
];

export type RelationshipStage = "stranger" | "acquaintance" | "friend" | "close" | "beloved" | "strained";

export interface Relationship extends RelationshipDimensions {
  id: string;
  userId: UserId;
  characterId: CharacterId;
  stage: RelationshipStage;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipMilestone {
  id: string;
  relationshipId: string;
  key: string;
  label: string;
  at: string;
}

export interface RelationshipChangeRecord {
  id: string;
  relationshipId: string;
  dimension: RelationshipDimension;
  beforeValue: number;
  afterValue: number;
  delta: number;
  clamped: boolean;
  reason: string;
  source: string;
  sourceMessageId: string | null;
  createdAt: string;
}

/** 模型/事件只能产出这个结构，不能直接写数据库数值。 */
export type RelationshipChangeSource =
  | "conversation"
  | "event"
  | "proactive"
  | "scheduler"
  | "user_manual"
  | "system";

export interface RelationshipChange {
  dimension: RelationshipDimension;
  delta: number;
  reason: string;
  source: RelationshipChangeSource;
  sourceMessageId?: string | null;
}

export interface RelationshipChangeOutcome {
  changed: RelationshipDimension[];
  clamped: RelationshipDimension[];
  relationship: Relationship;
  milestonesAdded: RelationshipMilestone[];
}

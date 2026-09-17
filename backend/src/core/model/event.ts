import type { CharacterId, MessageId, UserId } from "./ids.ts";

export type EventType =
  | "important_conversation"
  | "promise"
  | "future_plan"
  | "anniversary"
  | "user_info"
  | "relationship_change"
  | "shared_experience"
  | "character_life"
  | "custom";

/** 生命周期：不能只有一张表而没有状态流转。 */
export type EventStatus = "planned" | "active" | "completed" | "cancelled" | "expired";

export const EVENT_STATUSES: EventStatus[] = ["planned", "active", "completed", "cancelled", "expired"];

export type EventSource = "conversation" | "proactive" | "memory" | "user_manual" | "scheduler" | "system";

export interface CompanionEvent {
  id: string;
  userId: UserId;
  characterId: CharacterId;
  type: EventType;
  title: string;
  description: string;
  status: EventStatus;
  importance: number;
  occurredAt: string | null;
  scheduledAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  /** iCal RRULE 子集（生日 / 纪念日） */
  recurrence: string | null;
  source: EventSource;
  sourceMessageId: MessageId | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EventFilters {
  userId?: UserId | null;
  characterId?: CharacterId | null;
  status?: EventStatus;
  type?: EventType;
  /** 到期时间在 [from, to] 之间 */
  dueFrom?: string | null;
  dueTo?: string | null;
  limit?: number;
}

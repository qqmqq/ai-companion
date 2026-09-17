import type { CharacterId, MessageId, UserId } from "./ids.ts";

/**
 * 工作项。注意：与"模型路由的 TaskType"（core/model/task.ts）不是一回事——
 * TaskType 决定用哪个模型，WorkTask 是角色需要执行的一件事。
 * 表名用 work_tasks 也是为了避免两个概念在代码里混淆。
 */
export type WorkTaskKind =
  | "proactive_message"
  | "memory_extract"
  | "summarize"
  | "event_reminder"
  | "custom";

export type WorkTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkTask {
  id: string;
  userId: UserId;
  characterId: CharacterId;
  kind: WorkTaskKind;
  status: WorkTaskStatus;
  priority: number;
  payload: Record<string, unknown>;
  executeAt: string;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  eventId: string | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 事件可以派生任务：Event 是"发生/将要发生的事"，Task 是"要去做的动作"。 */
export interface WorkTaskFromEventInput {
  eventId: string;
  kind: WorkTaskKind;
  executeAt: string;
  payload?: Record<string, unknown>;
  priority?: number;
}

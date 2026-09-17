import type { CharacterId, UserId } from "./ids.ts";

export type JobTriggerType = "once" | "interval" | "cron_like" | "idle" | "event";

export type JobStatus = "idle" | "running" | "failed" | "disabled";

/** 错过触发时间的处理策略：skip 顺延、run_once 立刻补跑一次、drop 丢弃 */
export type MisfirePolicy = "skip" | "run_once" | "drop";

export interface ScheduledJob {
  id: string;
  userId: UserId;
  characterId: CharacterId | null;
  kind: string;
  triggerType: JobTriggerType;
  runAt: string | null;
  cronExpr: string | null;
  intervalMs: number | null;
  nextRunAt: string;
  lastRunAt: string | null;
  enabled: boolean;
  status: JobStatus;
  misfirePolicy: MisfirePolicy;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface JobRunOutcome {
  jobId: string;
  kind: string;
  outcome: "ran" | "skipped" | "failed";
  reason: string;
  nextRunAt: string | null;
}

export interface SchedulerRunSummary {
  at: string;
  due: number;
  ran: number;
  skipped: number;
  failed: number;
  outcomes: JobRunOutcome[];
}

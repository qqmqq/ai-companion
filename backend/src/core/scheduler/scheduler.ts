import type { JobRunOutcome, ScheduledJob, SchedulerRunSummary } from "../model/schedule.ts";
import type { ScheduledJobRepository } from "../ports/repositories.phase3.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import { nextDailyOccurrence } from "./time-of-day.ts";

export interface JobHandlerResult {
  outcome: "ran" | "skipped" | "failed";
  reason: string;
  detail?: Record<string, unknown>;
}

export type JobHandler = (job: ScheduledJob) => Promise<JobHandlerResult>;

export interface SchedulerDeps {
  jobs: ScheduledJobRepository;
  clock: Clock;
  logger: Logger;
  publisher: DomainEventPublisher;
  /** 判定"迟到多久算 misfire"，默认 1 小时 */
  misfireThresholdMs?: number;
}

/**
 * 调度器只做三件事：什么时候检查、哪些 job 到期、条件是否满足。
 * 它不生成消息、不调用 LLM —— 那是 JobHandler（ProactiveService）的事。
 * 全部基于注入的 Clock，因此可以用 FakeClock 精确测试"10:00 不触发 / 12:00 触发 / 不重复触发"。
 */
export function createScheduler(deps: SchedulerDeps) {
  const handlers = new Map<string, JobHandler>();
  const misfireThresholdMs = deps.misfireThresholdMs ?? 60 * 60 * 1000;

  function computeNextRun(job: ScheduledJob, fromMs: number): { nextRunAt: string | null; disable: boolean } {
    const from = new Date(fromMs);
    switch (job.triggerType) {
      case "once":
        return { nextRunAt: null, disable: true };
      case "interval":
      case "idle": {
        const interval = job.intervalMs ?? 30 * 60 * 1000;
        return { nextRunAt: new Date(fromMs + interval).toISOString(), disable: false };
      }
      case "cron_like": {
        const next = job.cronExpr === null ? null : nextDailyOccurrence(from, job.cronExpr);
        return next === null ? { nextRunAt: null, disable: true } : { nextRunAt: next.toISOString(), disable: false };
      }
      case "event":
        // 事件型 job 由业务显式触发（runNow），不参与时间轮询
        return { nextRunAt: null, disable: true };
    }
  }

  return {
    registerHandler(kind: string, handler: JobHandler): void {
      handlers.set(kind, handler);
    },

    listJobs(): ScheduledJob[] {
      return deps.jobs.list({ limit: 200 });
    },

    nextJobs(limit = 5): ScheduledJob[] {
      return deps.jobs.list({ enabledOnly: true, limit });
    },

    getJob(id: string): ScheduledJob | null {
      return deps.jobs.get(id);
    },

    createJob(input: Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "status"> & { id?: string }): ScheduledJob {
      const at = deps.clock.nowIso();
      const job: ScheduledJob = {
        ...input,
        id: input.id ?? `job:${Math.random().toString(36).slice(2, 12)}`,
        lastRunAt: null,
        status: input.enabled ? "idle" : "disabled",
        createdAt: at,
        updatedAt: at,
      };
      deps.jobs.insert(job);
      deps.publisher.publish({ name: "job.updated", at, channel: null, payload: { jobId: job.id, kind: job.kind } });
      return job;
    },

    setEnabled(id: string, enabled: boolean): ScheduledJob | null {
      const job = deps.jobs.get(id);
      if (job === null) return null;
      const next: ScheduledJob = {
        ...job,
        enabled,
        status: enabled ? "idle" : "disabled",
        updatedAt: deps.clock.nowIso(),
      };
      deps.jobs.update(next);
      return next;
    },

    deleteJob(id: string): void {
      deps.jobs.delete(id);
    },

    /** 手动立即执行（不影响 next_run_at 的常规推进）。 */
    async runNow(id: string): Promise<JobRunOutcome | null> {
      const job = deps.jobs.get(id);
      if (job === null) return null;
      const handler = handlers.get(job.kind);
      if (handler === undefined) {
        return { jobId: job.id, kind: job.kind, outcome: "skipped", reason: "no handler", nextRunAt: job.nextRunAt };
      }
      const nowIso = deps.clock.nowIso();
      let outcome: JobRunOutcome;
      try {
        const result = await handler(job);
        outcome = { jobId: job.id, kind: job.kind, outcome: result.outcome, reason: result.reason, nextRunAt: job.nextRunAt };
      } catch (error) {
        outcome = { jobId: job.id, kind: job.kind, outcome: "failed", reason: (error as Error).message, nextRunAt: job.nextRunAt };
      }
      deps.jobs.update({ ...job, lastRunAt: nowIso, updatedAt: nowIso });
      return outcome;
    },

    /** 一次 tick：只处理到期 job，单个 job 失败不影响其它 job。 */
    async tick(limit = 20): Promise<SchedulerRunSummary> {
      const now = deps.clock.now();
      const nowIso = now.toISOString();
      const due = deps.jobs.listDue(nowIso, limit);
      const outcomes: JobRunOutcome[] = [];
      let ran = 0;
      let skipped = 0;
      let failed = 0;

      for (const job of due) {
        const handler = handlers.get(job.kind);
        const lateMs = now.getTime() - Date.parse(job.nextRunAt);
        const isMisfire = lateMs > misfireThresholdMs;

        let outcome: JobRunOutcome["outcome"] = "skipped";
        let reason = "no handler";
        let detail: Record<string, unknown> = {};

        if (handler === undefined) {
          skipped += 1;
        } else if (isMisfire && job.misfirePolicy === "drop") {
          skipped += 1;
          reason = `misfire dropped (late ${Math.round(lateMs / 60000)}min)`;
        } else {
          try {
            const result = await handler(job);
            outcome = result.outcome;
            reason = result.reason;
            detail = result.detail ?? {};
            if (result.outcome === "ran") ran += 1;
            else if (result.outcome === "failed") failed += 1;
            else skipped += 1;
          } catch (error) {
            outcome = "failed";
            reason = (error as Error).message;
            failed += 1;
          }
        }

        const advanced = computeNextRun(job, now.getTime());
        const nextJob: ScheduledJob = {
          ...job,
          lastRunAt: nowIso,
          nextRunAt: advanced.nextRunAt ?? job.nextRunAt,
          enabled: advanced.disable ? false : job.enabled,
          status: outcome === "failed" ? "failed" : "idle",
          updatedAt: nowIso,
        };
        deps.jobs.update(nextJob);
        deps.publisher.publish({
          name: "job.updated",
          at: nowIso,
          channel: null,
          payload: { jobId: job.id, kind: job.kind, outcome, reason },
        });
        outcomes.push({ jobId: job.id, kind: job.kind, outcome, reason, nextRunAt: advanced.nextRunAt });
        if (detail["blocked"] === true) {
          deps.logger.debug("job ran but action was blocked", { jobId: job.id, reason });
        }
      }

      const summary: SchedulerRunSummary = { at: nowIso, due: due.length, ran, skipped, failed, outcomes };
      deps.publisher.publish({
        name: "scheduler.tick",
        at: nowIso,
        channel: null,
        payload: { due: due.length, ran, skipped, failed },
      });
      return summary;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;

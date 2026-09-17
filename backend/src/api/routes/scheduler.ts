import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { DomainError } from "../../core/model/errors.ts";

const JobSchema = z.object({
  characterId: z.string().nullable().default(null),
  kind: z.enum(["proactive_message", "scheduled_message", "event_maintenance", "task_runner"]),
  triggerType: z.enum(["once", "interval", "cron_like", "idle", "event"]),
  runAt: z.string().nullable().default(null),
  cronExpr: z.string().max(40).nullable().default(null),
  intervalMs: z.number().int().min(1000).max(86_400_000).nullable().default(null),
  nextRunAt: z.string().min(1),
  enabled: z.boolean().default(true),
  misfirePolicy: z.enum(["skip", "run_once", "drop"]).default("skip"),
  payload: z.record(z.unknown()).default({}),
});

export function registerSchedulerRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/scheduler/status", async () => {
    const runner = container.schedulerRunner.status();
    const jobs = container.services.scheduler.listJobs();
    const recent = container.repos.workTasks.list({ limit: 200 });
    return {
      runner,
      jobs: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
      failing: jobs.filter((job) => job.status === "failed").length,
      nextJobs: container.services.scheduler.nextJobs(5).map((job) => ({
        id: job.id,
        kind: job.kind,
        nextRunAt: job.nextRunAt,
        triggerType: job.triggerType,
        enabled: job.enabled,
      })),
      lastExecution: jobs
        .map((job) => job.lastRunAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null,
      pendingTasks: recent.filter((task) => task.status === "pending").length,
      failedTasks: recent.filter((task) => task.status === "failed").length,
    };
  });

  /** 手动 tick：演示与排查用，语义与真实定时器完全一致。 */
  app.post("/api/scheduler/tick", async () => {
    const summary = await container.services.scheduler.tick();
    const tasks = await container.services.tasks.runDue();
    return { scheduler: summary, tasks };
  });

  app.get("/api/scheduler/jobs", async () => {
    return { items: container.services.scheduler.listJobs() };
  });

  app.post("/api/scheduler/jobs", async (request, reply) => {
    const body = parseOrThrow(JobSchema, request.body);
    if (body.triggerType === "cron_like" && (body.cronExpr === null || !/^\d{1,2}:\d{2}$/.test(body.cronExpr))) {
      throw new DomainError("invalid_input", "cron_like 需要 HH:MM 形式的 cronExpr");
    }
    if ((body.triggerType === "interval" || body.triggerType === "idle") && body.intervalMs === null) {
      throw new DomainError("invalid_input", "interval/idle 需要 intervalMs");
    }
    const job = container.services.scheduler.createJob({
      userId: container.user.id,
      characterId: body.characterId,
      kind: body.kind,
      triggerType: body.triggerType,
      runAt: body.runAt,
      cronExpr: body.cronExpr,
      intervalMs: body.intervalMs,
      nextRunAt: body.nextRunAt,
      enabled: body.enabled,
      misfirePolicy: body.misfirePolicy,
      payload: body.payload,
    });
    reply.code(201);
    return job;
  });

  app.patch("/api/scheduler/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(z.object({ enabled: z.boolean() }), request.body);
    const job = container.services.scheduler.setEnabled(id, body.enabled);
    if (job === null) throw new DomainError("not_found", `job not found: ${id}`);
    return job;
  });

  /**
   * 删除调度任务。
   *
   * 只允许删**用户自己要求的提醒**（scheduled_message）。系统自己的调度任务
   * （主动消息 / 事件维护 / 任务执行）删掉就再也回不来了 —— 默认任务的种子逻辑只在"一条都没有"时才跑，
   * 删掉一条等于永久停摆。这类任务只能用「停用」（PATCH enabled=false）或去「主动消息」页调策略。
   */
  app.delete("/api/scheduler/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = container.services.scheduler.getJob(id);
    if (job === null) throw new DomainError("not_found", `job not found: ${id}`);
    if (job.kind !== "scheduled_message") {
      throw new DomainError(
        "invalid_input",
        "这条是系统自己的调度任务（主动消息 / 事件维护 / 任务执行），删除会让对应功能永久停摆；请改用「停用」。",
        { details: { kind: job.kind } },
      );
    }
    container.services.scheduler.deleteJob(id);
    container.repos.audit.append({
      actor: "user",
      action: "scheduled_job.deleted",
      targetType: "scheduled_job",
      targetId: id,
      detail: { kind: job.kind, message: (job.payload as { message?: unknown }).message ?? null },
    });
    reply.code(204);
    return null;
  });

  app.post("/api/scheduler/jobs/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    const outcome = await container.services.scheduler.runNow(id);
    if (outcome === null) throw new DomainError("not_found", `job not found: ${id}`);
    return outcome;
  });
}

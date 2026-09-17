import type { WorkTask, WorkTaskFromEventInput, WorkTaskKind } from "../model/work.ts";
import type { EventRepository, WorkTaskRepository } from "../ports/repositories.phase3.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import type { CharacterId, UserId } from "../model/ids.ts";
import { DomainError, notFound } from "../model/errors.ts";
import { uuidv7 } from "../../util/ids.ts";

/** 任务执行器由外部注入：TaskService 只负责状态机，不认识具体业务。 */
export type TaskHandler = (task: WorkTask) => Promise<{ ok: boolean; detail?: Record<string, unknown>; error?: string }>;

export interface TaskRunSummary {
  at: string;
  due: number;
  completed: number;
  failed: number;
  outcomes: Array<{ taskId: string; kind: string; outcome: "completed" | "failed" | "skipped"; error?: string }>;
}

export function createTaskService(deps: {
  tasks: WorkTaskRepository;
  events: EventRepository;
  handlers: Map<WorkTaskKind | string, TaskHandler>;
  publisher: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}) {
  function require(id: string): WorkTask {
    const task = deps.tasks.get(id);
    if (task === null) throw notFound("task", id);
    return task;
  }

  function save(task: WorkTask): WorkTask {
    deps.tasks.update(task);
    deps.publisher.publish({
      name: "task.updated",
      at: task.updatedAt,
      channel: null,
      payload: { taskId: task.id, status: task.status, kind: task.kind },
    });
    return task;
  }

  return {
    create(input: {
      userId: UserId;
      characterId: CharacterId;
      kind: WorkTaskKind;
      executeAt: string;
      payload?: Record<string, unknown>;
      priority?: number;
      eventId?: string | null;
      jobId?: string | null;
      maxAttempts?: number;
    }): WorkTask {
      const at = deps.clock.nowIso();
      const task: WorkTask = {
        id: uuidv7(),
        userId: input.userId,
        characterId: input.characterId,
        kind: input.kind,
        status: "pending",
        priority: input.priority ?? 5,
        payload: input.payload ?? {},
        executeAt: input.executeAt,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        eventId: input.eventId ?? null,
        jobId: input.jobId ?? null,
        createdAt: at,
        updatedAt: at,
      };
      deps.tasks.insert(task);
      deps.publisher.publish({ name: "task.created", at, channel: null, payload: { taskId: task.id, kind: task.kind } });
      return task;
    },

    /**
     * 事件派生任务：Event 是"将要发生的事"，Task 是"要去做的事"。
     * 例如 用户生日(Event) → 提前准备祝福(Task)。
     */
    createFromEvent(input: WorkTaskFromEventInput & { userId?: UserId; characterId?: CharacterId }): WorkTask | null {
      const event = deps.events.get(input.eventId);
      if (event === null) throw notFound("event", input.eventId);
      const existing = deps.tasks
        .list({ characterId: event.characterId, limit: 200 })
        .find((task) => task.eventId === event.id && task.kind === input.kind && task.status === "pending");
      if (existing !== undefined) return null; // 幂等：同一事件同一类任务只派生一次
      return this.create({
        userId: input.userId ?? event.userId,
        characterId: input.characterId ?? event.characterId,
        kind: input.kind,
        executeAt: input.executeAt,
        payload: { ...(input.payload ?? {}), eventId: event.id, eventTitle: event.title, eventType: event.type },
        priority: input.priority ?? 3,
        eventId: event.id,
      });
    },

    get: require,

    list(filters: { characterId?: CharacterId | null; status?: WorkTask["status"]; limit?: number }): WorkTask[] {
      return deps.tasks.list({ ...filters, limit: filters.limit ?? 100 });
    },

    complete(id: string): WorkTask {
      const task = require(id);
      if (task.status === "completed") return task;
      return save({ ...task, status: "completed", finishedAt: deps.clock.nowIso(), updatedAt: deps.clock.nowIso() });
    },

    cancel(id: string): WorkTask {
      const task = require(id);
      if (task.status === "completed" || task.status === "cancelled") return task;
      return save({ ...task, status: "cancelled", finishedAt: deps.clock.nowIso(), updatedAt: deps.clock.nowIso() });
    },

    delete(id: string): void {
      require(id);
      deps.tasks.delete(id);
    },

    /** 执行所有到期任务；单个失败不影响其它任务（失败的记录原因并等待重试）。 */
    async runDue(limit = 20): Promise<TaskRunSummary> {
      const at = deps.clock.nowIso();
      const due = deps.tasks.listDue(at, limit);
      const outcomes: TaskRunSummary["outcomes"] = [];
      let completed = 0;
      let failed = 0;

      for (const task of due) {
        const handler = deps.handlers.get(task.kind);
        if (handler === undefined) {
          outcomes.push({ taskId: task.id, kind: task.kind, outcome: "skipped", error: "no handler" });
          continue;
        }
        const running = save({
          ...task,
          status: "running",
          startedAt: at,
          attempts: task.attempts + 1,
          updatedAt: at,
        });
        try {
          const result = await handler(running);
          if (result.ok) {
            completed += 1;
            save({ ...running, status: "completed", finishedAt: deps.clock.nowIso(), updatedAt: deps.clock.nowIso() });
            outcomes.push({ taskId: task.id, kind: task.kind, outcome: "completed" });
          } else {
            failed += 1;
            const message = result.error ?? "handler reported failure";
            save({
              ...running,
              status: running.attempts >= running.maxAttempts ? "failed" : "pending",
              lastError: message,
              updatedAt: deps.clock.nowIso(),
            });
            outcomes.push({ taskId: task.id, kind: task.kind, outcome: "failed", error: message });
          }
        } catch (error) {
          failed += 1;
          const message = (error as Error).message;
          const nextStatus = running.attempts >= running.maxAttempts ? "failed" : "pending";
          save({ ...running, status: nextStatus, lastError: message, updatedAt: deps.clock.nowIso() });
          deps.logger.warn("task handler threw", { taskId: task.id, kind: task.kind, error: message });
          outcomes.push({ taskId: task.id, kind: task.kind, outcome: "failed", error: message });
        }
      }

      return { at, due: due.length, completed, failed, outcomes };
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;

export function assertKnownTaskKind(kind: string): void {
  const known: WorkTaskKind[] = ["proactive_message", "memory_extract", "summarize", "event_reminder", "custom"];
  if (!known.includes(kind as WorkTaskKind)) {
    throw new DomainError("invalid_input", `未知任务类型: ${kind}`);
  }
}

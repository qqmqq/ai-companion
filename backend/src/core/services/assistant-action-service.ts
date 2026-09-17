import type { CharacterId, ConversationId, UserId } from "../model/ids.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/logger.ts";
import type { ConversationRepository } from "../ports/repositories.ts";
import type { createEventService } from "./event-service.ts";
import type { createTaskService } from "./task-service.ts";
import type { ScheduledMessageService } from "./scheduled-message-service.ts";
import type { ActionIntent, CancelTarget } from "./action-intent.ts";
import type { ScheduleWhen } from "./schedule-time.ts";
import { formatLocal, localTimeZone, resolveRunAt } from "./schedule-time.ts";

/**
 * 「自然语言 → 结构化动作 → 后台对象」的应用服务层。
 *
 * 三类对象严格分开（绝不都塞进 scheduled_jobs）：
 *   将要发生的事 → events（EventService）
 *   要去完成的事 → work_tasks（TaskService）
 *   未来由系统主动发消息 → scheduled_jobs（ScheduledMessageService → Scheduler）
 *
 * 模型只能产出意图；所有写入都经过这里，失败时返回"没有创建成功"的话术，绝不假确认。
 */
const NEWLINE = String.fromCharCode(10);

export interface ActionSuccess {
  ok: true;
  kind: "event" | "task" | "schedule" | "cancel" | "query";
  id: string | null;
  receipt: string;
  detail: Record<string, unknown>;
}

export interface ActionFailure {
  ok: false;
  errorCategory: string;
  receipt: string;
}

export type ActionResult = ActionSuccess | ActionFailure;

export function createAssistantActionService(deps: {
  events: ReturnType<typeof createEventService>;
  tasks: ReturnType<typeof createTaskService>;
  scheduledMessages: ScheduledMessageService;
  conversations: ConversationRepository;
  clock: Clock;
  logger: Logger;
}) {
  function localAt(now: Date, hour: number, minute: number, dayOffset: number): string {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0).toISOString();
  }

  /**
   * 没给具体钟点时的兜底：默认"今天 23:00"。
   * 如果今天 23:00 已经过去（例如深夜才提这件事），就用"明天 09:00"——
   * 否则任务一建出来就已经过期，会被任务执行器立刻标成完成。
   */
  function defaultToday(now: Date): string {
    const tonight = localAt(now, 23, 0, 0);
    if (Date.parse(tonight) > now.getTime()) return tonight;
    return localAt(now, 9, 0, 1);
  }

  function resolveWhen(when: ScheduleWhen | null, now: Date, fallback: string): { runAt: string; cronExpr: string | null; timezone: string } {
    if (when === null) return { runAt: fallback, cronExpr: null, timezone: localTimeZone() };
    const resolved = resolveRunAt(when, now, localTimeZone());
    if (resolved.runAt === null && resolved.cronExpr === null) return { runAt: fallback, cronExpr: null, timezone: resolved.timezone };
    return { runAt: resolved.runAt ?? fallback, cronExpr: resolved.cronExpr, timezone: resolved.timezone };
  }

  function rangeOf(range: "today" | "tomorrow" | "all" | null, now: Date): { from: string; to: string; label: string } {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (range === "tomorrow") {
      const from = new Date(start.getTime() + 86_400_000);
      return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString(), label: "明天" };
    }
    if (range === "today") {
      return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString(), label: "今天" };
    }
    return { from: new Date(start.getTime() - 86_400_000).toISOString(), to: new Date(start.getTime() + 14 * 86_400_000).toISOString(), label: "接下来" };
  }

  function labelOf(iso: string, now: Date): string {
    return formatLocal(iso, now);
  }

  return {
    /** 事件：将要发生的事 */
    createEvent(input: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; intent: ActionIntent }): ActionResult {
      const title = input.intent.title ?? "";
      const now = deps.clock.now();
      const resolved = resolveWhen(input.intent.when, now, defaultToday(now));
      try {
        const event = deps.events.create({
          userId: input.userId,
          characterId: input.characterId,
          type: "future_plan",
          title,
          dueAt: resolved.runAt,
          source: "conversation",
          metadata: { conversationId: input.conversationId, createdFrom: "chat_action", timezone: resolved.timezone },
        });
        deps.logger.info("event created from chat", {
          step: "event.created",
          status: "completed",
          eventId: event.id,
          dueAt: event.dueAt,
          conversationId: input.conversationId,
        });
        return {
          ok: true,
          kind: "event",
          id: event.id,
          receipt: "好的，已经记下了：" + title + " — " + labelOf(resolved.runAt, now) + "。",
          detail: { eventId: event.id, title, dueAt: resolved.runAt, timezone: resolved.timezone },
        };
      } catch (error) {
        deps.logger.warn("event creation failed", {
          step: "event.created",
          status: "failed",
          errorCategory: "create_failed",
          error: (error as Error).message,
        });
        return { ok: false, errorCategory: "event_create_failed", receipt: "我理解这是个安排，但事件没有成功记下来，请再说一次。" };
      }
    },

    /** 任务：要去做的事 */
    createTask(input: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; intent: ActionIntent }): ActionResult {
      const title = input.intent.title ?? "";
      const now = deps.clock.now();
      const resolved = resolveWhen(input.intent.when, now, defaultToday(now));
      try {
        const task = deps.tasks.create({
          userId: input.userId,
          characterId: input.characterId,
          kind: "custom",
          executeAt: resolved.runAt,
          payload: { title, dueAt: resolved.runAt, conversationId: input.conversationId, source: "user_request", timezone: resolved.timezone },
          priority: 4,
        });
        deps.logger.info("work task created from chat", {
          step: "task.created",
          status: "completed",
          taskId: task.id,
          executeAt: task.executeAt,
          conversationId: input.conversationId,
        });
        return {
          ok: true,
          kind: "task",
          id: task.id,
          receipt: "好的，已经记下任务：" + title + "（" + labelOf(resolved.runAt, now) + " 前）。",
          detail: { taskId: task.id, title, executeAt: resolved.runAt, timezone: resolved.timezone },
        };
      } catch (error) {
        deps.logger.warn("work task creation failed", {
          step: "task.created",
          status: "failed",
          errorCategory: "create_failed",
          error: (error as Error).message,
        });
        return { ok: false, errorCategory: "task_create_failed", receipt: "我理解这是你要做的事，但任务没有成功记下来，请再说一次。" };
      }
    },

    /** 定时消息：未来由系统主动发 */
    scheduleMessage(input: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; intent: ActionIntent }): ActionResult {
      const now = deps.clock.now();
      const when = input.intent.when;
      if (when === null) return { ok: false, errorCategory: "no_time", receipt: "你想让我什么时候提醒你？给我一个具体时间就行（例如「10 分钟后」或「晚上 8 点」）。" };
      const resolved = resolveRunAt(when, now, localTimeZone());
      if (resolved.runAt === null && resolved.cronExpr === null) {
        return { ok: false, errorCategory: "bad_time", receipt: "这个时间我没理解清楚，你能说得具体一点吗（例如「10 分钟后」或「晚上 8 点」）？" };
      }
      try {
        const created = deps.scheduledMessages.schedule({
          userId: input.userId,
          characterId: input.characterId,
          conversationId: input.conversationId,
          message: input.intent.message ?? "到点了，主动跟对方说句话。",
          runAt: resolved.runAt,
          cronExpr: resolved.cronExpr,
          timezone: resolved.timezone,
          requestedChannel: input.intent.channelHint,
        });
        const scheduledText = created.cronExpr === null ? labelOf(created.scheduledAt, now) : "每天 " + created.cronExpr;
        return {
          ok: true,
          kind: "schedule",
          id: created.jobId,
          receipt: "好的，" + scheduledText + " 我会发你：「" + created.message + "」。",
          detail: { jobId: created.jobId, runAt: created.scheduledAt, channel: created.channel, message: created.message },
        };
      } catch (error) {
        deps.logger.warn("schedule creation failed", {
          step: "schedule.create",
          status: "failed",
          errorCategory: "create_failed",
          error: (error as Error).message,
        });
        return { ok: false, errorCategory: "schedule_create_failed", receipt: "我理解你要定时，但这次定时任务没有创建成功，请再说一次，我重新设置。" };
      }
    },

    /** 取消：按 target 找最近的一条（提醒 / 任务 / 安排） */
    cancel(input: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; target: CancelTarget | null }): ActionResult {
      const now = deps.clock.now();
      const target: CancelTarget = input.target ?? "any";
      const trySchedule = (): ActionResult | null => {
        const cancelled = deps.scheduledMessages.cancelLatest(input.userId, { conversationId: input.conversationId });
        if (cancelled === null) return null;
        const when = cancelled.cronExpr === null ? labelOf(cancelled.scheduledAt, now) : "每天 " + cancelled.cronExpr;
        return { ok: true, kind: "cancel", id: cancelled.jobId, receipt: "好的，原定 " + when + " 的提醒已经取消了。", detail: { cancelled: "schedule", jobId: cancelled.jobId } };
      };
      const tryTask = (): ActionResult | null => {
        const pending = deps.tasks.list({ characterId: input.characterId, status: "pending", limit: 100 }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const task = pending[0];
        if (task === undefined) return null;
        deps.tasks.cancel(task.id);
        const title = typeof task.payload.title === "string" ? task.payload.title : "任务";
        return { ok: true, kind: "cancel", id: task.id, receipt: "好的，任务「" + title + "」已经取消。", detail: { cancelled: "task", taskId: task.id } };
      };
      const tryEvent = (): ActionResult | null => {
        const planned = deps.events
          .list({ characterId: input.characterId, limit: 100 })
          .filter((event) => event.status === "planned" || event.status === "active")
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const event = planned[0];
        if (event === undefined) return null;
        deps.events.cancel(event.id);
        return { ok: true, kind: "cancel", id: event.id, receipt: "好的，安排「" + event.title + "」已经取消。", detail: { cancelled: "event", eventId: event.id } };
      };
      const order = target === "schedule" ? [trySchedule] : target === "task" ? [tryTask] : target === "event" ? [tryEvent] : [trySchedule, tryTask, tryEvent];
      for (const attempt of order) {
        const result = attempt();
        if (result !== null && result.ok) {
          deps.logger.info("cancelled from chat", { step: "action.cancel", status: "completed", target, id: result.id });
          return result;
        }
      }
      return { ok: false, errorCategory: "nothing_to_cancel", receipt: "我没有找到可以取消的提醒或安排。" };
    },

    /** 查询：把已有的 events / work_tasks / scheduled_jobs 读出来回答（模型不碰数据库） */
    query(input: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; range: "today" | "tomorrow" | "all" | null; target: CancelTarget | null }): ActionResult {
      const now = deps.clock.now();
      const range = rangeOf(input.range, now);
      const target: CancelTarget = input.target ?? "any";
      const lines: string[] = [];

      if (target === "any" || target === "event") {
        const events = deps.events
          .list({ characterId: input.characterId, limit: 100 })
          .filter((event) => (event.status === "planned" || event.status === "active") && event.dueAt !== null && event.dueAt >= range.from && event.dueAt < range.to)
          .sort((a, b) => Date.parse(String(a.dueAt)) - Date.parse(String(b.dueAt)));
        for (const event of events) {
          lines.push("安排：" + event.title + "（" + labelOf(String(event.dueAt), now) + "）");
        }
      }
      if (target === "any" || target === "task") {
        const tasks = deps.tasks
          .list({ characterId: input.characterId, status: "pending", limit: 100 })
          .filter((task) => task.executeAt >= range.from && task.executeAt < range.to)
          .sort((a, b) => Date.parse(a.executeAt) - Date.parse(b.executeAt));
        for (const task of tasks) {
          const title = typeof task.payload.title === "string" ? task.payload.title : task.kind;
          lines.push("任务：" + title + "（" + labelOf(task.executeAt, now) + " 前）");
        }
      }
      if (target === "any" || target === "schedule") {
        const pending = deps.scheduledMessages.listPending(input.userId, { conversationId: input.conversationId });
        for (const item of pending) {
          const when = item.cronExpr === null ? labelOf(item.scheduledAt, now) : "每天 " + item.cronExpr;
          lines.push("提醒：" + when + " 发「" + item.message + "」");
        }
      }

      if (lines.length === 0) {
        return { ok: true, kind: "query", id: null, receipt: range.label + "没有已记录的安排或任务。", detail: { items: 0, range: input.range } };
      }
      const numbered = lines.map((line, index) => String(index + 1) + ") " + line).join(NEWLINE);
      return {
        ok: true,
        kind: "query",
        id: null,
        receipt: range.label + "有 " + String(lines.length) + " 项：" + NEWLINE + numbered,
        detail: { items: lines.length, range: input.range, lines, label: range.label },
      };
    },
  };
}

/**
 * 把动作结果转成**只含事实**的系统说明，注入给角色模型，让角色自己措辞。
 * 不含任何固定礼貌模板（"好的，我会…"）；语气由角色人设决定。
 */
export function actionNote(result: ActionResult, now: Date): string {
  const t = (iso: unknown): string => (typeof iso === "string" ? formatLocal(iso, now) : "?");
  const head = "[系统动作结果] ";
  if (!result.ok) {
    return head + "状态=失败 原因=" + result.errorCategory + "。请用你自己的语气告诉用户这件事没有成功，绝不能声称已经设置/记下。";
  }
  const d = result.detail;
  if (result.kind === "schedule") {
    return head + "动作=定时消息 状态=成功 时间=" + t(d.runAt) + " 内容=" + String(d.message ?? "") + " 渠道=" + String(d.channel ?? "") + "。请用你自己的语气自然确认。";
  }
  if (result.kind === "event") {
    return head + "动作=事件 状态=成功 标题=" + String(d.title ?? "") + " 时间=" + t(d.dueAt) + "。请用你自己的语气自然确认。";
  }
  if (result.kind === "task") {
    return head + "动作=任务 状态=成功 标题=" + String(d.title ?? "") + " 截止=" + t(d.executeAt) + "。请用你自己的语气自然确认。";
  }
  if (result.kind === "cancel") {
    return head + "动作=取消 状态=成功 取消了=" + String(d.cancelled ?? "") + "。请用你自己的语气告诉用户取消结果。";
  }
  if (result.kind === "query") {
    const lines = Array.isArray(d.lines) ? (d.lines as string[]) : [];
    return head + "动作=查询 状态=成功 范围=" + String(d.label ?? "") + " 结果如下（如果没有内容就如实说没有）：" + NEWLINE + lines.map((line) => "- " + line).join(NEWLINE);
  }
  return head + "状态=成功。";
}

export type AssistantActionService = ReturnType<typeof createAssistantActionService>;


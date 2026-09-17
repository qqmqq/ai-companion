import type { CharacterId, ConversationId, UserId } from "../model/ids.ts";
import type { ChannelKind } from "../model/channel.ts";
import type { ScheduledJob } from "../model/schedule.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/logger.ts";
import type { ConversationRepository } from "../ports/repositories.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { DomainError, notFound } from "../model/errors.ts";

/**
 * 「定时消息」应用能力：聊天层唯一被允许创建定时消息的入口。
 *
 * - 复用已有 Scheduler（scheduled_jobs + Scheduler.createJob），**不新建第二套定时器**；
 * - 模型只产出结构化的 when/message，落到数据库这一步始终在这里；
 * - 渠道默认取会话本身的渠道（网页会话→网页，微信会话→微信），不偷偷改投微信。
 */
export interface ScheduleMessageRequest {
  userId: UserId;
  characterId: CharacterId;
  conversationId: ConversationId;
  /** 到时间要发出去的原文 */
  message: string;
  /** 一次性触发时间（ISO）；与 cronExpr 二选一 */
  runAt?: string | null;
  /** 周期表达（"HH:mm"），给"每天 X 点"用 */
  cronExpr?: string | null;
  /** 记录用途：解释绝对时间是按哪个时区算的 */
  timezone: string;
  /**
   * 用户明确要求换渠道时的**提示值**（不透明字符串）。
   * 这里不直接当投递渠道用：由应用层去解析（找不到对应会话就仍发回原会话）。
   */
  requestedChannel?: string | null;
}

export interface ScheduledMessageView {
  jobId: string;
  scheduledAt: string;
  status: "pending";
  channel: ChannelKind;
  conversationId: ConversationId;
  message: string;
  cronExpr: string | null;
}

export const SCHEDULED_MESSAGE_KIND = "scheduled_message";

interface ScheduledMessagePayload {
  message: string;
  channel: ChannelKind;
  conversationId: ConversationId;
  conversationRef: string;
  accountId: string | null;
  timezone: string;
  requestedAt: string;
  source: "user_request";
  requestedChannel: string | null;
}

export function readScheduledMessagePayload(job: ScheduledJob): ScheduledMessagePayload | null {
  const payload = job.payload as Partial<ScheduledMessagePayload>;
  if (typeof payload.message !== "string" || payload.message.trim().length === 0) return null;
  if (typeof payload.conversationId !== "string" || payload.conversationId.length === 0) return null;
  if (typeof payload.channel !== "string") return null;
  return {
    message: payload.message,
    channel: payload.channel,
    conversationId: payload.conversationId,
    conversationRef: typeof payload.conversationRef === "string" ? payload.conversationRef : "",
    accountId: typeof payload.accountId === "string" ? payload.accountId : null,
    timezone: typeof payload.timezone === "string" ? payload.timezone : "local",
    requestedAt: typeof payload.requestedAt === "string" ? payload.requestedAt : job.createdAt,
    source: "user_request",
    requestedChannel: typeof payload.requestedChannel === "string" ? payload.requestedChannel : null,
  };
}

export function createScheduledMessageService(deps: {
  scheduler: Scheduler;
  conversations: ConversationRepository;
  clock: Clock;
  logger: Logger;
}) {
  function view(job: ScheduledJob): ScheduledMessageView {
    const payload = readScheduledMessagePayload(job);
    return {
      jobId: job.id,
      scheduledAt: job.runAt ?? job.nextRunAt,
      status: "pending",
      channel: (payload?.channel ?? "web") as ChannelKind,
      conversationId: (payload?.conversationId ?? "") as ConversationId,
      message: payload?.message ?? "",
      cronExpr: job.cronExpr,
    };
  }

  function pendingJobs(userId: UserId, filter: { characterId?: CharacterId | null; conversationId?: ConversationId | null } = {}): ScheduledJob[] {
    return deps.scheduler
      .listJobs()
      .filter((job) => job.kind === SCHEDULED_MESSAGE_KIND && job.userId === userId && job.enabled)
      .filter((job) => (filter.characterId === undefined || filter.characterId === null ? true : job.characterId === filter.characterId))
      .filter((job) => {
        if (filter.conversationId === undefined || filter.conversationId === null) return true;
        return readScheduledMessagePayload(job)?.conversationId === filter.conversationId;
      })
      // 最近创建的在最前："取消刚才的提醒"语义 = 取消最近设置的那条，而不是最快到点的那条
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  return {
    /** 创建一条定时消息；返回 jobId 与预计发送时间 */
    schedule(input: ScheduleMessageRequest): ScheduledMessageView {
      const conversation = deps.conversations.getById(input.conversationId);
      if (conversation === null) throw notFound("conversation", input.conversationId);
      const message = input.message.trim();
      if (message.length === 0) throw new DomainError("invalid_input", "定时消息内容不能为空");
      const runAt = input.runAt ?? null;
      const cronExpr = input.cronExpr ?? null;
      if (runAt === null && cronExpr === null) throw new DomainError("invalid_input", "定时消息必须给出时间");

      const at = deps.clock.nowIso();
      const channel = conversation.channel;
      const payload: ScheduledMessagePayload = {
        message,
        channel,
        conversationId: conversation.id,
        conversationRef: conversation.conversationId,
        accountId: conversation.accountId,
        timezone: input.timezone,
        requestedAt: at,
        source: "user_request",
        requestedChannel: input.requestedChannel ?? null,
      };
      const job = deps.scheduler.createJob({
        userId: input.userId,
        characterId: input.characterId,
        kind: SCHEDULED_MESSAGE_KIND,
        triggerType: cronExpr === null ? "once" : "cron_like",
        runAt,
        cronExpr,
        intervalMs: null,
        nextRunAt: runAt ?? at,
        enabled: true,
        // 电脑关机错过时间：回来补发一次，而不是静默丢掉用户的提醒
        misfirePolicy: "run_once",
        payload: { ...payload },
      });
      deps.logger.info("scheduled message created", {
        step: "schedule.create",
        status: "completed",
        jobId: job.id,
        channel,
        conversationId: conversation.id,
        runAt: job.runAt,
        cronExpr,
        timezone: input.timezone,
      });
      return view(job);
    },

    listPending(userId: UserId, filter: { characterId?: CharacterId | null; conversationId?: ConversationId | null } = {}): ScheduledMessageView[] {
      return pendingJobs(userId, filter).map(view);
    },

    /** 取消最近一条待发定时消息（"取消刚才的提醒"） */
    cancelLatest(userId: UserId, filter: { characterId?: CharacterId | null; conversationId?: ConversationId | null } = {}): ScheduledMessageView | null {
      const job = pendingJobs(userId, filter)[0] ?? null;
      if (job === null) return null;
      deps.scheduler.setEnabled(job.id, false);
      deps.logger.info("scheduled message cancelled", {
        step: "schedule.cancel",
        status: "completed",
        jobId: job.id,
      });
      return view(job);
    },

    cancel(jobId: string): boolean {
      const job = deps.scheduler.getJob(jobId);
      if (job === null || job.kind !== SCHEDULED_MESSAGE_KIND) return false;
      deps.scheduler.setEnabled(jobId, false);
      return true;
    },
  };
}

export type ScheduledMessageService = ReturnType<typeof createScheduledMessageService>;

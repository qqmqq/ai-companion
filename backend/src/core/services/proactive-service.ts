import type {
  ProactiveBlockedReason,
  ProactiveDecision,
  ProactivePolicy,
  ProactivePolicyDecision,
  ProactiveResult,
  ProactiveTriggerEvaluation,
} from "../model/proactive.ts";
import { DEFAULT_PROACTIVE_POLICY, AUTONOMY_ORDER } from "../model/proactive.ts";
import type { ProactiveDecisionRepository, ScheduledJobRepository, EventRepository } from "../ports/repositories.phase3.ts";
import type { SettingsRepository } from "../ports/repositories.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { CharacterService } from "./character-service.ts";
import type { EmotionService } from "./emotion-service.ts";
import type { MessageWriter } from "../ports/message-writer.ts";
import type { ProactiveOutbound } from "../ports/outbound.ts";
import type { ContextEngine } from "../context/context-engine.ts";
import type { TaskLLM } from "../ports/task-llm.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import type { CharacterId, ConversationId, UserId } from "../model/ids.ts";
import type { WorkTask } from "../model/work.ts";
import type { ConversationRepository, MessageRepository } from "../ports/repositories.ts";
import { isWithinWindow } from "../scheduler/time-of-day.ts";
import { uuidv7, randomToken } from "../../util/ids.ts";

export interface ProactiveServiceDeps {
  settings: SettingsRepository;
  decisions: ProactiveDecisionRepository;
  conversations: ConversationRepository;
  conversationService: ConversationService;
  characters: CharacterService;
  messages: MessageRepository;
  events: EventRepository;
  jobs: ScheduledJobRepository;
  emotion: EmotionService;
  context: ContextEngine;
  taskLLM: TaskLLM;
  messageWriter: MessageWriter;
  outbound: ProactiveOutbound;
  publisher: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}

/**
 * 主动消息。
 *
 * 铁律（顺序不可调换）：
 *   触发评估（确定性） → 策略闸门（静音时段/每日上限/冷却/自主等级） → 才允许调用模型 → 发送。
 * 任何一步不通过都**不调用 LLM**，并把 blocked_reason 记入 proactive_decisions。
 */
export function createProactiveService(deps: ProactiveServiceDeps) {
  function policy(): ProactivePolicy {
    return {
      enabled: deps.settings.get<boolean>("proactive.enabled", DEFAULT_PROACTIVE_POLICY.enabled),
      autonomy: deps.settings.get<ProactivePolicy["autonomy"]>("proactive.autonomy", DEFAULT_PROACTIVE_POLICY.autonomy),
      quietHours: deps.settings.get<ProactivePolicy["quietHours"]>("proactive.quietHours", DEFAULT_PROACTIVE_POLICY.quietHours),
      dailyLimit: deps.settings.get<number>("proactive.dailyLimit", DEFAULT_PROACTIVE_POLICY.dailyLimit),
      cooldownMs: deps.settings.get<number>("proactive.cooldownMs", DEFAULT_PROACTIVE_POLICY.cooldownMs),
      inactivityThresholdMs: deps.settings.get<number>(
        "proactive.inactivityThresholdMs",
        DEFAULT_PROACTIVE_POLICY.inactivityThresholdMs,
      ),
    };
  }

  function updatePolicy(patch: Partial<ProactivePolicy>): ProactivePolicy {
    const at = deps.clock.nowIso();
    if (patch.enabled !== undefined) deps.settings.put("proactive.enabled", patch.enabled, at);
    if (patch.autonomy !== undefined) deps.settings.put("proactive.autonomy", patch.autonomy, at);
    if (patch.quietHours !== undefined) deps.settings.put("proactive.quietHours", patch.quietHours, at);
    if (patch.dailyLimit !== undefined) deps.settings.put("proactive.dailyLimit", Math.max(0, Math.floor(patch.dailyLimit)), at);
    if (patch.cooldownMs !== undefined) deps.settings.put("proactive.cooldownMs", Math.max(0, patch.cooldownMs), at);
    if (patch.inactivityThresholdMs !== undefined) {
      deps.settings.put("proactive.inactivityThresholdMs", Math.max(60_000, patch.inactivityThresholdMs), at);
    }
    return policy();
  }

  /** 自主等级直接决定"允许多主动"：passive 完全不发，low 收紧到每天 1 条且冷却翻倍。 */
  function effectivePolicy(base: ProactivePolicy): { dailyLimit: number; cooldownMs: number } {
    switch (base.autonomy) {
      case "passive":
        return { dailyLimit: 0, cooldownMs: base.cooldownMs };
      case "low":
        return { dailyLimit: Math.min(1, base.dailyLimit), cooldownMs: base.cooldownMs * 2 };
      case "normal":
        return { dailyLimit: base.dailyLimit, cooldownMs: base.cooldownMs };
      case "high":
        return { dailyLimit: base.dailyLimit + 1, cooldownMs: Math.floor(base.cooldownMs / 2) };
      case "autonomous":
        return { dailyLimit: base.dailyLimit + 2, cooldownMs: Math.floor(base.cooldownMs / 3) };
    }
  }

  function checkPolicy(characterId: CharacterId, now: Date = deps.clock.now()): ProactivePolicyDecision {
    const base = policy();
    const effective = effectivePolicy(base);
    const detail: Record<string, unknown> = {
      autonomy: base.autonomy,
      dailyLimit: effective.dailyLimit,
      cooldownMs: effective.cooldownMs,
      now: now.toISOString(),
    };

    if (!base.enabled) return { allowed: false, blockedReason: "disabled", detail };
    if (base.autonomy === "passive" || AUTONOMY_ORDER.indexOf(base.autonomy) < 0) {
      return { allowed: false, blockedReason: "autonomy_passive", detail };
    }
    if (base.quietHours.enabled && isWithinWindow(now, base.quietHours.start, base.quietHours.end)) {
      detail["quietHours"] = `${base.quietHours.start}-${base.quietHours.end}`;
      return { allowed: false, blockedReason: "quiet_hours", detail };
    }
    const dayStart = new Date(now.getTime());
    dayStart.setHours(0, 0, 0, 0);
    const sentToday = deps.decisions.countSince(characterId, dayStart.toISOString());
    detail["sentToday"] = sentToday;
    if (sentToday >= effective.dailyLimit) {
      return { allowed: false, blockedReason: "daily_limit", detail };
    }
    const lastSentAt = deps.decisions.lastSentAt(characterId);
    if (lastSentAt !== null) {
      const elapsed = now.getTime() - Date.parse(lastSentAt);
      detail["sinceLastSentMs"] = elapsed;
      if (elapsed < effective.cooldownMs) {
        return { allowed: false, blockedReason: "cooldown", detail };
      }
    }
    return { allowed: true, blockedReason: null, detail };
  }

  /** 触发评估：全部是确定性规则，不消耗任何模型调用。 */
  function evaluateTrigger(input: {
    userId: UserId;
    characterId: CharacterId;
    triggerKind: string;
    reason?: string;
  }): ProactiveTriggerEvaluation {
    const now = deps.clock.now();
    const policyValue = policy();
    const conversation = findConversation(input.userId, input.characterId);

    switch (input.triggerKind) {
      case "idle_check": {
        if (conversation === null) {
          return { eligible: false, triggerKind: input.triggerKind, reason: "还没有会话", proactiveIntent: "" };
        }
        const lastUserAt = deps.messages.lastMessageAt(conversation.id, "user");
        if (lastUserAt === null) {
          return { eligible: false, triggerKind: input.triggerKind, reason: "用户还没说过话", proactiveIntent: "" };
        }
        const idleMs = now.getTime() - Date.parse(lastUserAt);
        if (idleMs < policyValue.inactivityThresholdMs) {
          return {
            eligible: false,
            triggerKind: input.triggerKind,
            reason: `用户才安静了 ${Math.round(idleMs / 60000)} 分钟`,
            proactiveIntent: "",
          };
        }
        return {
          eligible: true,
          triggerKind: input.triggerKind,
          reason: `用户已经 ${Math.round(idleMs / 3_600_000)} 小时没有说话了`,
          proactiveIntent: `对方已经 ${Math.round(idleMs / 3_600_000)} 小时没来找你，你想问候一下。`,
        };
      }
      case "scheduled_window":
        return {
          eligible: conversation !== null,
          triggerKind: input.triggerKind,
          reason: input.reason ?? "到了约定的时间点",
          proactiveIntent: input.reason ?? "到了这个时间点，你想主动说句话。",
        };
      case "event_due": {
        const dueSoon = deps.events.list({
          characterId: input.characterId,
          dueFrom: now.toISOString(),
          dueTo: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          limit: 1,
        });
        const event = dueSoon[0];
        if (event === undefined) {
          return { eligible: false, triggerKind: input.triggerKind, reason: "近期没有到期事件", proactiveIntent: "" };
        }
        return {
          eligible: true,
          triggerKind: input.triggerKind,
          reason: `事件即将发生：${event.title}`,
          proactiveIntent: `你记得「${event.title}」就要到了，想提醒或聊一聊这件事。`,
        };
      }
      case "task":
        return {
          eligible: conversation !== null,
          triggerKind: input.triggerKind,
          reason: input.reason ?? "任务触发的主动消息",
          proactiveIntent: input.reason ?? "你有一件想主动跟对方说的事。",
        };
      case "manual":
      default:
        return {
          eligible: conversation !== null,
          triggerKind: input.triggerKind,
          reason: input.reason ?? "手动触发",
          proactiveIntent: input.reason ?? "你想主动跟对方说句话。",
        };
    }
  }

  function findConversation(userId: UserId, characterId: CharacterId) {
    return (
      deps.conversations
        .listByUser(userId, 100)
        .filter((conversation) => conversation.characterId === characterId && conversation.status === "active")
        .sort((a, b) => Date.parse(b.lastMessageAt ?? b.createdAt) - Date.parse(a.lastMessageAt ?? a.createdAt))[0] ?? null
    );
  }

  function record(input: {
    userId: UserId;
    characterId: CharacterId;
    conversationId: ConversationId | null;
    jobId: string | null;
    triggerKind: string;
    triggerReason: string;
    decision: ProactiveDecision["decision"];
    blockedReason: ProactiveBlockedReason | null;
    autonomy: ProactivePolicy["autonomy"] | null;
    providerId: string | null;
    model: string | null;
    messageId: string | null;
    contextSnapshotId: string | null;
    latencyMs: number | null;
    detail: Record<string, unknown>;
  }): ProactiveDecision {
    const decision: ProactiveDecision = { id: uuidv7(), createdAt: deps.clock.nowIso(), ...input };
    deps.decisions.insert(decision);
    deps.publisher.publish({
      name: "proactive.decided",
      at: decision.createdAt,
      channel: null,
      payload: {
        characterId: input.characterId,
        decision: decision.decision,
        blockedReason: decision.blockedReason,
        triggerKind: decision.triggerKind,
      },
    });
    return decision;
  }

  return {
    policy,
    updatePolicy,
    checkPolicy,
    evaluateTrigger,

    decisions(filters: { characterId?: CharacterId | null; decision?: ProactiveDecision["decision"]; limit?: number }): ProactiveDecision[] {
      return deps.decisions.list({ characterId: filters.characterId ?? null, decision: filters.decision, limit: filters.limit ?? 50 });
    },

    /**
     * 生成（并可选发送）一条主动消息。
     * dryRun = true 时：仍然遵守全部策略，生成内容但不发送、不占用每日额度。
     */
    async propose(input: {
      userId: UserId;
      characterId: CharacterId;
      triggerKind: string;
      reason?: string;
      jobId?: string | null;
      dryRun?: boolean;
    }): Promise<ProactiveResult> {
      const dryRun = input.dryRun === true;
      const evaluation = evaluateTrigger({
        userId: input.userId,
        characterId: input.characterId,
        triggerKind: input.triggerKind,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      const base = policy();

      if (!evaluation.eligible) {
        const decision = record({
          userId: input.userId,
          characterId: input.characterId,
          conversationId: findConversation(input.userId, input.characterId)?.id ?? null,
          jobId: input.jobId ?? null,
          triggerKind: evaluation.triggerKind,
          triggerReason: evaluation.reason,
          decision: "skipped",
          blockedReason: "not_eligible",
          autonomy: base.autonomy,
          providerId: null,
          model: null,
          messageId: null,
          contextSnapshotId: null,
          latencyMs: null,
          detail: { stage: "eligibility" },
        });
        return { decision, message: null, text: null };
      }

      // 关键：策略不通过时绝不调用模型
      const policyDecision = checkPolicy(input.characterId);
      if (!policyDecision.allowed && !(dryRun && policyDecision.blockedReason === "cooldown")) {
        const decision = record({
          userId: input.userId,
          characterId: input.characterId,
          conversationId: findConversation(input.userId, input.characterId)?.id ?? null,
          jobId: input.jobId ?? null,
          triggerKind: evaluation.triggerKind,
          triggerReason: evaluation.reason,
          decision: "blocked",
          blockedReason: policyDecision.blockedReason,
          autonomy: base.autonomy,
          providerId: null,
          model: null,
          messageId: null,
          contextSnapshotId: null,
          latencyMs: null,
          detail: { stage: "policy", ...policyDecision.detail },
        });
        return { decision, message: null, text: null };
      }

      const conversation = findConversation(input.userId, input.characterId);
      if (conversation === null) {
        const decision = record({
          userId: input.userId,
          characterId: input.characterId,
          conversationId: null,
          jobId: input.jobId ?? null,
          triggerKind: evaluation.triggerKind,
          triggerReason: evaluation.reason,
          decision: "blocked",
          blockedReason: "no_conversation",
          autonomy: base.autonomy,
          providerId: null,
          model: null,
          messageId: null,
          contextSnapshotId: null,
          latencyMs: null,
          detail: { stage: "conversation" },
        });
        return { decision, message: null, text: null };
      }

      const started = deps.clock.now().getTime();
      // dry-run 不写库：预览不能在真实会话历史里留下一条"其实没发出去"的消息
      const placeholder = dryRun
        ? {
            id: `preview-${uuidv7()}`,
            conversationId: conversation.id,
            role: "character" as const,
            parts: [{ kind: "text" as const, text: "" }],
            textRender: "",
            replyToId: null,
            providerMessageId: null,
            tokenCount: null,
            status: "completed" as const,
            errorText: null,
            source: "proactive" as const,
            createdAt: deps.clock.nowIso(),
            editedAt: null,
            branchOfId: null,
          }
        : deps.messageWriter.begin({ conversationId: conversation.id, source: "proactive" });

      try {
        const built = await deps.context.build({
          conversation,
          userId: input.userId,
          incomingMessage: null,
          taskType: "proactive",
          source: "proactive",
          proactiveIntent: evaluation.proactiveIntent,
          triggerReason: evaluation.reason,
        });
        const messages = deps.context.toChatMessages(built.bundle);
        const response = await deps.taskLLM.chat(
          "proactive",
          // 预算别省：200 tokens 时"先想再答"的模型会把预算烧在思考上、正文为空，
          // 主动消息就会以「生成内容为空」失败（同一类事故在到点提醒上已经踩过）
          { model: built.model.model, messages, maxOutputTokens: 600, temperature: 0.8 },
          { conversationId: conversation.id, messageId: placeholder.id },
        );
        const text = response.text.trim();

        if (text.length === 0) {
          deps.messageWriter.finalize({ messageId: placeholder.id, text: "", status: "failed", errorText: "生成内容为空" });
          const decision = record({
            userId: input.userId,
            characterId: input.characterId,
            conversationId: conversation.id,
            jobId: input.jobId ?? null,
            triggerKind: evaluation.triggerKind,
            triggerReason: evaluation.reason,
            decision: "failed",
            blockedReason: "empty_generation",
            autonomy: base.autonomy,
            providerId: built.model.providerId,
            model: built.model.model,
            messageId: placeholder.id,
            contextSnapshotId: built.snapshotId,
            latencyMs: deps.clock.now().getTime() - started,
            detail: { stage: "generate" },
          });
          return { decision, message: placeholder.id, text: null };
        }

        if (dryRun) {
          // 预览：记录决策与快照，但不落库、不发送、不占额度
          const built2 = built;
          const decision = record({
            userId: input.userId,
            characterId: input.characterId,
            conversationId: conversation.id,
            jobId: input.jobId ?? null,
            triggerKind: evaluation.triggerKind,
            triggerReason: evaluation.reason,
            decision: "skipped",
            blockedReason: null,
            autonomy: base.autonomy,
            providerId: built2.model.providerId,
            model: built2.model.model,
            messageId: null,
            contextSnapshotId: built2.snapshotId,
            latencyMs: deps.clock.now().getTime() - started,
            detail: { stage: "dry_run", dryRun: true, preview: text, sent: false },
          });
          return { decision, message: null, text };
        }

        deps.messageWriter.finalize({ messageId: placeholder.id, text, status: "completed" });

        const outbound = await deps.outbound.send({
          target: {
            channel: conversation.channel,
            accountId: conversation.accountId,
            conversationRef: conversation.conversationId,
          },
          text,
          messageId: placeholder.id,
          idempotencyKey: randomToken(12),
        });

        const decision = record({
          userId: input.userId,
          characterId: input.characterId,
          conversationId: conversation.id,
          jobId: input.jobId ?? null,
          triggerKind: evaluation.triggerKind,
          triggerReason: evaluation.reason,
          decision: outbound.delivered ? "sent" : "failed",
          blockedReason: outbound.delivered ? null : "send_failed",
          autonomy: base.autonomy,
          providerId: built.model.providerId,
          model: built.model.model,
          messageId: placeholder.id,
          contextSnapshotId: built.snapshotId,
          latencyMs: deps.clock.now().getTime() - started,
          detail: { stage: "send", providerMessageId: outbound.providerMessageId, error: outbound.error },
        });
        deps.logger.info("proactive message sent", {
          characterId: input.characterId,
          triggerKind: evaluation.triggerKind,
          chars: text.length,
        });
        return { decision, message: placeholder.id, text };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!dryRun) {
          deps.messageWriter.finalize({ messageId: placeholder.id, text: "", status: "failed", errorText: message });
        }
        const decision = record({
          userId: input.userId,
          characterId: input.characterId,
          conversationId: conversation.id,
          jobId: input.jobId ?? null,
          triggerKind: evaluation.triggerKind,
          triggerReason: evaluation.reason,
          decision: "failed",
          blockedReason: "generation_failed",
          autonomy: base.autonomy,
          providerId: null,
          model: null,
          messageId: placeholder.id,
          contextSnapshotId: null,
          latencyMs: deps.clock.now().getTime() - started,
          detail: { stage: "generate", error: message },
        });
        deps.logger.warn("proactive generation failed", { characterId: input.characterId, error: message });
        return { decision, message: placeholder.id, text: null };
      }
    },

    /** 供 TaskService / Scheduler 作为处理器使用：失败不抛出，改为返回失败结果。 */
    async handleTask(task: WorkTask): Promise<{ ok: boolean; detail?: Record<string, unknown>; error?: string }> {
      const triggerKind = typeof task.payload.triggerKind === "string" ? task.payload.triggerKind : "task";
      const result = await this.propose({
        userId: task.userId,
        characterId: task.characterId,
        triggerKind,
        reason: typeof task.payload.reason === "string" ? task.payload.reason : undefined,
        jobId: task.jobId,
      });
      if (result.decision.decision === "sent" || result.decision.decision === "skipped") {
        return { ok: true, detail: { decisionId: result.decision.id, decision: result.decision.decision } };
      }
      return {
        ok: false,
        detail: { decisionId: result.decision.id, blockedReason: result.decision.blockedReason },
        error: result.decision.blockedReason ?? "proactive failed",
      };
    },
  };
}

export type ProactiveService = ReturnType<typeof createProactiveService>;
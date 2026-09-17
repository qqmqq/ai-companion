import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStack } from "../helpers/chat-stack.ts";

const HOUR = 3600 * 1000;

/** 把时钟固定到"本地正午"再写入用户消息，避免本地时间与 UTC 起点互相倒推造成的时间倒流。 */
function preparedStack(options: Parameters<typeof createChatStack>[0] = {}) {
  const stack = createChatStack({ chatReply: "（主动）我记得你只喝深烘豆。", ...options });
  stack.clock.setLocal(12, 0);
  stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "我先去忙了" }]);
  return stack;
}

test("quiet hours block proactive messages and never call the model", async () => {
  const stack = preparedStack();
  try {
    stack.clock.setLocal(23, 30); // 默认静音时段 23:00 ~ 08:00
    const before = stack.requests.length;
    const result = await stack.proactive.propose({
      userId: stack.userId,
      characterId: stack.characterId,
      triggerKind: "scheduled_window",
      reason: "晚安问候",
    });
    assert.equal(result.decision.decision, "blocked");
    assert.equal(result.decision.blockedReason, "quiet_hours");
    assert.equal(stack.requests.length, before, "被策略拦住时绝不能调用模型");
    assert.equal(stack.outbound.sent.length, 0);
  } finally {
    stack.close();
  }
});

test("daily limit stops further proactive messages for the day", async () => {
  const stack = preparedStack();
  try {
    stack.proactive.updatePolicy({ dailyLimit: 1, cooldownMs: 0 });

    const first = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(first.decision.decision, "sent");

    const second = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(second.decision.decision, "blocked");
    assert.equal(second.decision.blockedReason, "daily_limit");

    // 第二天额度重置
    stack.clock.setLocal(12, 0, 1);
    const third = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(third.decision.decision, "sent", "新的一天额度应重置");
  } finally {
    stack.close();
  }
});

test("cooldown prevents back-to-back proactive messages", async () => {
  const stack = preparedStack();
  try {
    stack.clock.setLocal(12, 0);
    stack.proactive.updatePolicy({ dailyLimit: 5, cooldownMs: 2 * HOUR });
    const first = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(first.decision.decision, "sent");

    stack.clock.advance(10 * 60 * 1000);
    const tooSoon = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(tooSoon.decision.blockedReason, "cooldown");

    stack.clock.advance(3 * HOUR);
    const later = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(later.decision.decision, "sent");
  } finally {
    stack.close();
  }
});

test("autonomy level scales how proactive the character is allowed to be", async () => {
  const stack = preparedStack();
  try {
    stack.clock.setLocal(12, 0);
    stack.proactive.updatePolicy({ dailyLimit: 2, cooldownMs: 0, autonomy: "passive" });
    const passive = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(passive.decision.blockedReason, "autonomy_passive");
    assert.equal(stack.outbound.sent.length, 0);

    stack.proactive.updatePolicy({ autonomy: "low" });
    const low = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(low.decision.decision, "sent");
    const lowSecond = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(lowSecond.decision.blockedReason, "daily_limit", "low 自主等级把每日上限收紧到 1");

    stack.clock.advance(24 * HOUR);
    stack.proactive.updatePolicy({ autonomy: "high" });
    const highFirst = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    const highSecond = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(highFirst.decision.decision, "sent");
    assert.equal(highSecond.decision.decision, "sent", "high 自主等级允许更多主动消息（上限 +1）");
  } finally {
    stack.close();
  }
});

test("idle trigger only fires after the user has been away long enough", async () => {
  const stack = preparedStack();
  try {
    stack.proactive.updatePolicy({ dailyLimit: 5, cooldownMs: 0, inactivityThresholdMs: 24 * HOUR });

    const tooEarly = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "idle_check" });
    assert.equal(tooEarly.decision.decision, "skipped");
    assert.equal(tooEarly.decision.blockedReason, "not_eligible");

    stack.clock.advance(30 * HOUR);
    const result = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "idle_check" });
    assert.equal(result.decision.decision, "sent");
    assert.match(result.decision.triggerReason, /小时/);
  } finally {
    stack.close();
  }
});

test("dry run respects policy, generates nothing when blocked, and never consumes the daily quota", async () => {
  const stack = preparedStack();
  try {
    stack.proactive.updatePolicy({ dailyLimit: 1, cooldownMs: 0 });

    const preview = await stack.proactive.propose({
      userId: stack.userId,
      characterId: stack.characterId,
      triggerKind: "scheduled_window",
      dryRun: true,
    });
    assert.equal(preview.decision.decision, "skipped");
    assert.equal(preview.decision.detail["dryRun"], true);
    assert.ok((preview.text ?? "").length > 0, "dry-run 也要给出真实生成结果");
    assert.equal(stack.outbound.sent.length, 0, "dry-run 绝不发送");

    // 预览不占用额度：真正的发送仍然可以成功
    const actual = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(actual.decision.decision, "sent");

    stack.clock.setLocal(23, 30);
    const quietPreview = await stack.proactive.propose({
      userId: stack.userId,
      characterId: stack.characterId,
      triggerKind: "scheduled_window",
      dryRun: true,
    });
    assert.equal(quietPreview.decision.blockedReason, "quiet_hours", "dry-run 同样受静音时段约束");
  } finally {
    stack.close();
  }
});

test("a successful proactive message is persisted with source=proactive and audited end to end", async () => {
  const stack = preparedStack();
  try {
    stack.proactive.updatePolicy({ dailyLimit: 3, cooldownMs: 0 });
    const result = await stack.proactive.propose({
      userId: stack.userId,
      characterId: stack.characterId,
      triggerKind: "scheduled_window",
      reason: "到了午饭时间",
    });

    assert.equal(result.decision.decision, "sent");
    const messages = stack.messages.listByConversation(stack.conversationId);
    const proactive = messages.filter((message) => message.source === "proactive");
    assert.equal(proactive.length, 1, "主动消息必须落库");
    assert.equal(proactive[0]?.role, "character");
    assert.equal(proactive[0]?.status, "completed");
    assert.match(proactive[0]?.textRender ?? "", /深烘豆/);

    // 上下文快照必须能区分主动消息并记录触发原因
    const snapshots = stack.snapshots.listByConversation(stack.conversationId, 10);
    const proactiveSnapshot = snapshots.find((snapshot) => snapshot.source === "proactive");
    assert.ok(proactiveSnapshot !== undefined, "主动消息必须有独立快照");
    assert.equal(proactiveSnapshot?.taskType, "proactive");
    assert.match(proactiveSnapshot?.triggerReason ?? "", /午饭/);
    assert.ok(
      proactiveSnapshot?.sections.some((section) => section.kind === "proactive_intent"),
      "主动上下文必须包含「为什么说话」这一段",
    );

    // 用量必须记在 proactive 任务上
    const usage = stack.usage.listRecent(20);
    assert.ok(usage.some((record) => record.taskType === "proactive"));
    assert.equal(result.decision.messageId, proactive[0]?.id);
    assert.equal(stack.outbound.sent.length, 1);
    assert.match(stack.outbound.sent[0]?.text ?? "", /深烘豆/);
  } finally {
    stack.close();
  }
});

test("generation failure is recorded and does not throw out of the service", async () => {
  const stack = preparedStack({ failChat: true });
  try {
    stack.proactive.updatePolicy({ dailyLimit: 3, cooldownMs: 0 });
    const result = await stack.proactive.propose({ userId: stack.userId, characterId: stack.characterId, triggerKind: "scheduled_window" });
    assert.equal(result.decision.decision, "failed");
    assert.equal(result.decision.blockedReason, "generation_failed");
    assert.equal(stack.outbound.sent.length, 0);

    const messages = stack.messages.listByConversation(stack.conversationId);
    const failed = messages.filter((message) => message.source === "proactive");
    assert.equal(failed[0]?.status, "failed", "失败的主动消息不能留成 partial");
    assert.ok((failed[0]?.errorText ?? "").length > 0);

    // 失败不占额度，但会被冷却外的重试允许
    stack.clock.advance(10 * 60 * 1000);
    const decisions = stack.proactive.decisions({ characterId: stack.characterId, limit: 10 });
    assert.equal(decisions[0]?.decision, "failed");
  } finally {
    stack.close();
  }
});

test("scheduler tick drives proactive messages end to end (trigger → policy → model → channel)", async () => {
  const stack = preparedStack();
  try {
    stack.proactive.updatePolicy({ dailyLimit: 2, cooldownMs: 0 });
    const job = stack.scheduler.createJob({
      userId: stack.userId,
      characterId: stack.characterId,
      kind: "proactive_message",
      triggerType: "cron_like",
      runAt: null,
      cronExpr: "12:00",
      intervalMs: null,
      nextRunAt: stack.clock.nowIso(),
      enabled: true,
      misfirePolicy: "skip",
      payload: { triggerKind: "scheduled_window", reason: "午间问候" },
    });

    const summary = await stack.scheduler.tick();
    assert.equal(summary.due, 1);
    assert.equal(summary.ran, 1, "调度器应执行主动消息任务");
    assert.equal(stack.outbound.sent.length, 1);

    // 静音时段：任务照旧到期，但被策略拦住且不调用模型
    stack.clock.setLocal(23, 30);
    const before = stack.requests.length;
    const blocked = await stack.scheduler.runNow(job.id);
    assert.equal(blocked?.outcome, "ran", "任务被执行了，只是动作被策略拦住");
    assert.match(blocked?.reason ?? "", /blocked:quiet_hours/);
    assert.equal(stack.requests.length, before, "静音时段内不得产生模型调用");
  } finally {
    stack.close();
  }
});
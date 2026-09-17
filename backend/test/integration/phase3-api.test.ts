import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import type { Container } from "../../src/app/bootstrap.ts";

interface Ctx {
  baseUrl: string;
  container: Container;
  close: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const server = await createRunningServer();
  return { baseUrl: server.baseUrl, container: server.container, close: server.close };
}

async function api(ctx: Ctx, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(ctx: Ctx, path: string, init?: RequestInit): Promise<T> {
  const response = await api(ctx, path, init);
  assert.ok(response.ok, `${path} → ${response.status} ${await response.clone().text()}`);
  return (await response.json()) as T;
}

async function setupCharacter(ctx: Ctx): Promise<{ characterId: string; conversationId: string }> {
  const character = await json<{ id: string }>(ctx, "/api/characters", {
    method: "POST",
    body: JSON.stringify({
      name: "Aria",
      description: "温柔的咖啡师",
      personality: "耐心",
      scenario: "小镇咖啡馆",
      systemPrompt: "",
      firstMessage: "欢迎回来。",
    }),
  });
  const conversation = await json<{ id: string }>(ctx, "/api/conversations", {
    method: "POST",
    body: JSON.stringify({ characterId: character.id }),
  });
  return { characterId: character.id, conversationId: conversation.id };
}

test("relationship API exposes dimensions, milestones and rate-limited manual changes", async () => {
  const ctx = await setup();
  try {
    const { characterId } = await setupCharacter(ctx);

    const initial = await json<{ items: Array<{ stage: string; dimensions: { trust: number } }> }>(ctx, "/api/relationships");
    assert.equal(initial.items.length, 1);
    assert.equal(initial.items[0]?.stage, "stranger");

    const changed = await json<{ changed: string[]; clamped: string[]; relationship: { trust: number } }>(
      ctx,
      `/api/relationships/${characterId}/changes`,
      { method: "POST", body: JSON.stringify({ changes: [{ dimension: "trust", delta: 100, reason: "手工加满试试" }] }) },
    );
    assert.deepEqual(changed.clamped, ["trust"], "手工调整同样受单次上限约束");
    assert.ok(changed.relationship.trust <= 0.15 + 1e-9, `trust=${changed.relationship.trust} 应被限幅到 +0.05`);

    const detail = await json<{ changes: Array<{ reason: string; source: string }>; milestones: unknown[] }>(
      ctx,
      `/api/relationships/${characterId}`,
    );
    assert.equal(detail.changes[0]?.reason, "手工加满试试");
    assert.equal(detail.changes[0]?.source, "user_manual");

    const invalid = await api(ctx, `/api/relationships/${characterId}/changes`, {
      method: "POST",
      body: JSON.stringify({ changes: [{ dimension: "nope", delta: 0.1, reason: "x" }] }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await ctx.close();
  }
});

test("emotion API returns state, history and accepts a manual stimulus with clamping", async () => {
  const ctx = await setup();
  try {
    const { characterId, conversationId } = await setupCharacter(ctx);

    const before = await json<{ emotion: { primary: string }; mood: string }>(ctx, `/api/emotions/${characterId}`);
    assert.equal(before.emotion.primary, "neutral");

    const stimulated = await json<{ emotion: { primary: string; intensity: number }; entry: { before: unknown; reason: string } }>(
      ctx,
      `/api/emotions/${characterId}/stimulus`,
      { method: "POST", body: JSON.stringify({ primary: "happy", intensity: 5, reason: "手工注入" }) },
    );
    assert.equal(stimulated.emotion.primary, "happy");
    assert.equal(stimulated.emotion.intensity, 1, "越界强度被限幅");
    assert.equal(stimulated.entry.before !== null, true, "必须记录变化前的状态");

    const history = await json<{ items: Array<{ reason: string; source: string }> }>(ctx, `/api/emotions/${characterId}/history`);
    assert.equal(history.items[0]?.reason, "手工注入");
    assert.equal(history.items[0]?.source, "user_manual");

    // 聊天会驱动情绪与关系（确定性信号：这条消息含"开心"）
    await json(ctx, `/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text: "今天好开心，谢谢你陪我" }) });
    const afterChat = await json<{ emotion: { primary: string }; history: unknown[] }>(ctx, `/api/emotions/${characterId}`);
    assert.ok(afterChat.history.length >= 2);
  } finally {
    await ctx.close();
  }
});

test("event + task APIs cover the full lifecycle and derive reminder tasks", async () => {
  const ctx = await setup();
  try {
    const { characterId } = await setupCharacter(ctx);

    const created = await json<{ id: string; status: string }>(ctx, "/api/events", {
      method: "POST",
      body: JSON.stringify({ characterId, type: "promise", title: "周末一起去书店", importance: 0.9, dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
    });
    assert.equal(created.status, "planned");

    const withTasks = await json<{ tasks: Array<{ id: string; kind: string; status: string }> }>(ctx, `/api/events/${created.id}`);
    assert.equal(withTasks.tasks.length, 1, "带到期时间的承诺事件应派生提醒任务");
    assert.equal(withTasks.tasks[0]?.kind, "proactive_message");

    await json(ctx, `/api/events/${created.id}/activate`, { method: "POST" });
    const completed = await json<{ status: string; completedAt: string | null }>(ctx, `/api/events/${created.id}/complete`, { method: "POST" });
    assert.equal(completed.status, "completed");
    assert.ok(completed.completedAt !== null);

    // 完成事件会推动关系（trust 上升）
    const relationship = await json<{ relationship: { trust: number }; changes: Array<{ source: string }> }>(
      ctx,
      `/api/relationships/${characterId}`,
    );
    assert.ok(relationship.changes.some((change) => change.source === "event"), "完成事件必须留下关系流水");

    const manualTask = await json<{ id: string; status: string }>(ctx, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ characterId, kind: "custom", executeAt: new Date(Date.now() - 1000).toISOString() }),
    });
    assert.equal(manualTask.status, "pending");

    const run = await json<{ due: number; completed: number }>(ctx, "/api/tasks/run", { method: "POST" });
    assert.ok(run.due >= 1);

    const cancelled = await json<{ status: string }>(ctx, `/api/tasks/${manualTask.id}/cancel`, { method: "POST" });
    assert.ok(["cancelled", "completed"].includes(cancelled.status));

    const removed = await api(ctx, `/api/events/${created.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
  } finally {
    await ctx.close();
  }
});

test("scheduler API reports status, allows job CRUD and manual ticks", async () => {
  const ctx = await setup();
  const { container } = ctx;
  try {
    const { characterId } = await setupCharacter(ctx);

    const status = await json<{ jobs: number; nextJobs: Array<{ id: string }>; runner: { running: boolean } }>(ctx, "/api/scheduler/status");
    assert.ok(status.jobs >= 1, "启动时应有默认调度任务");

    const job = await json<{ id: string; triggerType: string }>(ctx, "/api/scheduler/jobs", {
      method: "POST",
      body: JSON.stringify({
        characterId,
        kind: "scheduled_message",
        triggerType: "cron_like",
        cronExpr: "22:00",
        nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
        payload: { message: "晚上问候", channel: "web" },
      }),
    });
    assert.equal(job.triggerType, "cron_like");

    const bad = await api(ctx, "/api/scheduler/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "proactive_message", triggerType: "cron_like", cronExpr: "晚上十点", nextRunAt: new Date().toISOString() }),
    });
    assert.equal(bad.status, 400, "非法 cron 表达式必须被拒绝");

    const tick = await json<{ scheduler: { due: number }; tasks: { due: number } }>(ctx, "/api/scheduler/tick", { method: "POST" });
    assert.ok(typeof tick.scheduler.due === "number");

    const disabled = await json<{ enabled: boolean }>(ctx, `/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.enabled, false);

    const removed = await api(ctx, `/api/scheduler/jobs/${job.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204, "用户自己的定时提醒可以删");

    // 系统自己的调度任务（主动消息 / 事件维护）不能删：种子逻辑只在"一条都没有"时才补，删掉就是永久停摆
    const systemJob = container.services.scheduler.listJobs().find((item) => item.kind !== "scheduled_message");
    assert.ok(systemJob !== undefined, "容器里应该有系统调度任务");
    const refused = await api(ctx, `/api/scheduler/jobs/${systemJob.id}`, { method: "DELETE" });
    assert.equal(refused.status, 400);
    const refusal = (await refused.json()) as { error: { message: string } };
    assert.match(refusal.error.message, /停用/);
    assert.ok(container.services.scheduler.getJob(systemJob.id) !== null, "被拒绝之后系统任务必须还在");
  } finally {
    await ctx.close();
  }
});

test("proactive API enforces quiet hours, autonomy and daily limits; preview never sends", async () => {
  const ctx = await setup();
  try {
    const { characterId, conversationId } = await setupCharacter(ctx);
    await json(ctx, `/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text: "我先去忙了，晚点聊" }) });

    // 1) 静音时段（覆盖全天）→ 预览与触发都被拦，且不消耗额度
    await json(ctx, "/api/proactive/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, autonomy: "normal", quietHours: { enabled: true, start: "00:00", end: "23:59" }, dailyLimit: 2, cooldownMs: 0 }),
    });

    const preview = await json<{ decision: { decision: string; blockedReason: string | null } }>(ctx, "/api/proactive/preview", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual", reason: "测试" }),
    });
    assert.equal(preview.decision.decision, "blocked");
    assert.equal(preview.decision.blockedReason, "quiet_hours");

    const blockedTrigger = await json<{ decision: { blockedReason: string | null } }>(ctx, "/api/proactive/trigger", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual" }),
    });
    assert.equal(blockedTrigger.decision.blockedReason, "quiet_hours");

    // 2) 关闭静音时段 → 允许发送
    await json(ctx, "/api/proactive/settings", { method: "PUT", body: JSON.stringify({ quietHours: { enabled: false, start: "23:00", end: "08:00" } }) });
    const sent = await json<{ decision: { decision: string; messageId: string | null } }>(ctx, "/api/proactive/trigger", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual", reason: "手动问候" }),
    });
    assert.equal(sent.decision.decision, "sent");
    assert.ok(sent.decision.messageId !== null);

    const messages = await json<{ items: Array<{ source: string; text: string }> }>(ctx, `/api/conversations/${conversationId}/messages`);
    assert.ok(messages.items.some((message) => message.source === "proactive"), "主动消息必须以 source=proactive 落库");

    // 3) 每日上限：dailyLimit=2 → 第 2 条仍可发，第 3 条被拦
    const second = await json<{ decision: { decision: string } }>(ctx, "/api/proactive/trigger", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual" }),
    });
    assert.equal(second.decision.decision, "sent");
    const limited = await json<{ decision: { blockedReason: string | null } }>(ctx, "/api/proactive/trigger", {
      method: "POST",
      body: JSON.stringify({ characterId, triggerKind: "manual" }),
    });
    assert.equal(limited.decision.blockedReason, "daily_limit", "达到 dailyLimit 后必须拦住");

    // 4) 自主等级 passive
    await json(ctx, "/api/proactive/settings", { method: "PUT", body: JSON.stringify({ autonomy: "passive", dailyLimit: 5 }) });
    const passive = await json<{ eligibility: Array<{ decision: { blockedReason: string | null } }> }>(ctx, "/api/proactive/settings");
    assert.equal(passive.eligibility[0]?.decision.blockedReason, "autonomy_passive");

    // 5) 决策审计可查
    const decisions = await json<{ items: Array<{ decision: string; blockedReason: string | null; triggerReason: string }> }>(
      ctx,
      "/api/proactive/decisions?limit=20",
    );
    assert.ok(decisions.items.length >= 4);
    assert.ok(decisions.items.some((item) => item.decision === "sent"));
    assert.ok(decisions.items.some((item) => item.blockedReason === "quiet_hours"));
    assert.ok(decisions.items.every((item) => item.triggerReason.length > 0), "每条决策都要记录触发原因");
  } finally {
    await ctx.close();
  }
});
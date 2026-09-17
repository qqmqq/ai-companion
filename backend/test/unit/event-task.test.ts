import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../helpers/db.ts";
import { seedFixtures } from "../helpers/memory-stack.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createEventRepository } from "../../src/storage/repositories/events.ts";
import { createWorkTaskRepository } from "../../src/storage/repositories/work-tasks.ts";
import { createRelationshipRepository } from "../../src/storage/repositories/relationships.ts";
import { createEventService, type EventEffectHandlers } from "../../src/core/services/event-service.ts";
import { createTaskService } from "../../src/core/services/task-service.ts";
import { createRelationshipService } from "../../src/core/services/relationship-service.ts";
import { createLogger } from "../../src/app/logger.ts";
import type { WorkTask } from "../../src/core/model/work.ts";

const logger = createLogger({ level: "error", sink: () => {} });

function stack() {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const clock = createFakeClock();
  const eventsRepo = createEventRepository(db);
  const tasksRepo = createWorkTaskRepository(db);
  const relationshipRepo = createRelationshipRepository(db);
  const relationship = createRelationshipService({ relationships: relationshipRepo, events: { publish: () => {} }, logger, clock });
  const effects: EventEffectHandlers = {};
  const eventService = createEventService({ events: eventsRepo, effectHandlers: effects, publisher: { publish: () => {} }, logger, clock });
  const handlers = new Map<string, (task: WorkTask) => Promise<{ ok: boolean; error?: string }>>();
  const taskService = createTaskService({
    tasks: tasksRepo,
    events: eventsRepo,
    handlers,
    publisher: { publish: () => {} },
    logger,
    clock,
  });
  return { db, clock, eventsRepo, tasksRepo, relationship, eventService, taskService, handlers, effects, close: () => db.close() };
}

test("event lifecycle: planned → active → completed, with cancel and expire", async () => {
  const s = stack();
  try {
    const event = s.eventService.create({
      userId: "u1",
      characterId: "c1",
      type: "promise",
      title: "周末一起去书店",
      importance: 0.9,
      dueAt: new Date(Date.parse(s.clock.nowIso()) + 3 * 86_400_000).toISOString(),
    });
    assert.equal(event.status, "planned");
    assert.equal(s.eventService.get(event.id).status, "planned");

    const active = s.eventService.activate(event.id);
    assert.equal(active.status, "active");

    let completedEffect: string | null = null;
    s.effects.onCompleted = (value) => {
      completedEffect = value.id;
    };
    const completed = await s.eventService.complete(event.id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.completedAt !== null);
    assert.equal(completedEffect, event.id, "完成事件必须触发效果回调");

    const cancelled = s.eventService.create({ userId: "u1", characterId: "c1", type: "future_plan", title: "取消计划" });
    assert.equal(s.eventService.cancel(cancelled.id).status, "cancelled");

    const overdue = s.eventService.create({
      userId: "u1",
      characterId: "c1",
      type: "promise",
      title: "早就该做的事",
      dueAt: new Date(Date.parse(s.clock.nowIso()) - 3 * 86_400_000).toISOString(),
    });
    const expired = await s.eventService.expireOverdue(s.clock.nowIso());
    assert.ok(expired.some((item) => item.id === overdue.id));
    assert.equal(s.eventService.get(overdue.id).status, "expired");
  } finally {
    s.close();
  }
});

test("invalid events are rejected and importance is clamped", () => {
  const s = stack();
  try {
    assert.throws(() => s.eventService.create({ userId: "u1", characterId: "c1", type: "promise", title: "   " }), /标题/);
    const event = s.eventService.create({ userId: "u1", characterId: "c1", type: "custom", title: "带权重", importance: 5 });
    assert.equal(event.importance, 1);
  } finally {
    s.close();
  }
});

test("task lifecycle: create → run → complete, failures retry then fail", async () => {
  const s = stack();
  try {
    const task = s.taskService.create({
      userId: "u1",
      characterId: "c1",
      kind: "custom",
      executeAt: s.clock.nowIso(),
    });
    assert.equal(task.status, "pending");

    let calls = 0;
    s.handlers.set("custom", async () => {
      calls += 1;
      return { ok: true };
    });
    const summary = await s.taskService.runDue();
    assert.equal(summary.completed, 1);
    assert.equal(calls, 1);
    assert.equal(s.taskService.get(task.id).status, "completed");

    // 未到时间的任务不该被执行
    const future = s.taskService.create({
      userId: "u1",
      characterId: "c1",
      kind: "custom",
      executeAt: new Date(Date.parse(s.clock.nowIso()) + 3600_000).toISOString(),
    });
    const second = await s.taskService.runDue();
    assert.equal(second.due, 0);
    assert.equal(s.taskService.get(future.id).status, "pending");

    // 失败 → 重试直至 maxAttempts
    const failing = s.taskService.create({ userId: "u1", characterId: "c1", kind: "custom", executeAt: s.clock.nowIso(), maxAttempts: 2 });
    s.handlers.set("custom", async () => ({ ok: false, error: "上游 429" }));
    await s.taskService.runDue();
    assert.equal(s.taskService.get(failing.id).status, "pending", "第一次失败应等待重试");
    assert.equal(s.taskService.get(failing.id).lastError, "上游 429");
    await s.taskService.runDue();
    assert.equal(s.taskService.get(failing.id).status, "failed", "达到上限后标记失败");

    // handler 抛异常不能击穿调度
    const throwing = s.taskService.create({ userId: "u1", characterId: "c1", kind: "custom", executeAt: s.clock.nowIso(), maxAttempts: 1 });
    s.handlers.set("custom", async () => {
      throw new Error("boom");
    });
    const third = await s.taskService.runDue();
    assert.equal(third.failed >= 1, true);
    assert.equal(s.taskService.get(throwing.id).status, "failed");
  } finally {
    s.close();
  }
});

test("cancelling a task stops it from running", async () => {
  const s = stack();
  try {
    const task = s.taskService.create({ userId: "u1", characterId: "c1", kind: "custom", executeAt: s.clock.nowIso() });
    s.taskService.cancel(task.id);
    assert.equal(s.taskService.get(task.id).status, "cancelled");
    const summary = await s.taskService.runDue();
    assert.equal(summary.due, 0);
  } finally {
    s.close();
  }
});

test("events derive tasks exactly once, and completing an event moves the relationship", async () => {
  const s = stack();
  try {
    const event = s.eventService.create({
      userId: "u1",
      characterId: "c1",
      type: "anniversary",
      title: "相识一百天",
      dueAt: new Date(Date.parse(s.clock.nowIso()) + 2 * 3600_000).toISOString(),
    });

    const first = s.taskService.createFromEvent({
      eventId: event.id,
      kind: "proactive_message",
      executeAt: event.dueAt ?? s.clock.nowIso(),
      payload: { triggerKind: "event_due" },
    });
    assert.ok(first !== null);
    const second = s.taskService.createFromEvent({
      eventId: event.id,
      kind: "proactive_message",
      executeAt: event.dueAt ?? s.clock.nowIso(),
    });
    assert.equal(second, null, "同一事件同一类任务只派生一次");

    const before = s.relationship.get("u1", "c1");
    s.effects.onCompleted = (value) => {
      s.relationship.applyChange(value.userId, value.characterId, [
        { dimension: "trust", delta: 0.03, reason: `共同完成：${value.title}`, source: "event" },
      ]);
    };
    await s.eventService.complete(event.id);
    const after = s.relationship.get("u1", "c1");
    assert.ok(after.trust > before.trust, "完成重要事件应提升信任");
    assert.ok(s.relationship.listChanges(after.id, 5).some((change) => change.source === "event"));
  } finally {
    s.close();
  }
});

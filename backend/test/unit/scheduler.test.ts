import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../helpers/db.ts";
import { seedFixtures } from "../helpers/memory-stack.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createScheduledJobRepository } from "../../src/storage/repositories/scheduled-jobs.ts";
import { createScheduler } from "../../src/core/scheduler/scheduler.ts";
import { createLogger } from "../../src/app/logger.ts";

const logger = createLogger({ level: "error", sink: () => {} });

function stack() {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const clock = createFakeClock("2026-03-01T10:00:00.000Z");
  const jobs = createScheduledJobRepository(db);
  const scheduler = createScheduler({ jobs, clock, logger, publisher: { publish: () => {} } });
  return { db, clock, jobs, scheduler, close: () => db.close() };
}

function makeJob(
  scheduler: ReturnType<typeof createScheduler>,
  clock: ReturnType<typeof createFakeClock>,
  overrides: Partial<Parameters<ReturnType<typeof createScheduler>["createJob"]>[0]> = {},
) {
  return scheduler.createJob({
    userId: "u1",
    characterId: "c1",
    kind: "proactive_message",
    triggerType: "once",
    runAt: null,
    cronExpr: null,
    intervalMs: null,
    nextRunAt: clock.nowIso(),
    enabled: true,
    misfirePolicy: "skip",
    payload: {},
    ...overrides,
  });
}

test("due jobs run, not-yet-due jobs do not (FakeClock)", async () => {
  const s = stack();
  try {
    const runs: string[] = [];
    s.scheduler.registerHandler("proactive_message", async (job) => {
      runs.push(job.id);
      return { outcome: "ran", reason: "ok" };
    });

    makeJob(s.scheduler, s.clock, { nextRunAt: new Date(Date.parse(s.clock.nowIso()) + 2 * 3600_000).toISOString() });
    const early = await s.scheduler.tick();
    assert.equal(early.due, 0);
    assert.equal(runs.length, 0, "未到期不能执行");

    s.clock.advance(3 * 3600_000); // 12:00
    const later = await s.scheduler.tick();
    assert.equal(later.due, 1);
    assert.equal(later.ran, 1);
    assert.equal(runs.length, 1, "到点必须执行一次");

    const again = await s.scheduler.tick();
    assert.equal(again.due, 0, "一次性任务执行后不得重复触发");
  } finally {
    s.close();
  }
});

test("interval jobs reschedule next_run_at and never double-fire in the same window", async () => {
  const s = stack();
  try {
    let runs = 0;
    s.scheduler.registerHandler("proactive_message", async () => {
      runs += 1;
      return { outcome: "ran", reason: "ok" };
    });
    const job = makeJob(s.scheduler, s.clock, { triggerType: "interval", intervalMs: 30 * 60 * 1000 });

    await s.scheduler.tick();
    const afterFirst = s.scheduler.getJob(job.id)!;
    assert.equal(runs, 1);
    assert.equal(afterFirst.nextRunAt, new Date(Date.parse(s.clock.nowIso()) + 30 * 60 * 1000).toISOString());

    await s.scheduler.tick();
    assert.equal(runs, 1, "同一时间窗内不应重复执行");

    s.clock.advance(30 * 60 * 1000);
    await s.scheduler.tick();
    assert.equal(runs, 2, "下一个窗口应再次执行");
  } finally {
    s.close();
  }
});

test("once jobs disable themselves; disabled jobs are never picked up", async () => {
  const s = stack();
  try {
    let runs = 0;
    s.scheduler.registerHandler("proactive_message", async () => {
      runs += 1;
      return { outcome: "ran", reason: "ok" };
    });
    const once = makeJob(s.scheduler, s.clock, { triggerType: "once" });
    await s.scheduler.tick();
    assert.equal(s.scheduler.getJob(once.id)?.enabled, false, "一次性任务执行后应停用");

    const disabled = makeJob(s.scheduler, s.clock, { enabled: false });
    s.scheduler.setEnabled(disabled.id, false);
    const summary = await s.scheduler.tick();
    assert.equal(summary.due, 0, "停用的任务不参与调度");
    assert.equal(runs, 1);
  } finally {
    s.close();
  }
});

test("cron_like jobs fire at the configured local time each day", async () => {
  const s = stack();
  try {
    const runs: string[] = [];
    s.scheduler.registerHandler("proactive_message", async () => {
      runs.push(s.clock.nowIso());
      return { outcome: "ran", reason: "ok" };
    });
    // 计划时间用同一个本地时钟推导，避免测试依赖机器时区
    s.clock.setLocal(21, 30);
    const planned = new Date(s.clock.now());
    planned.setHours(22, 0, 0, 0);
    const job = makeJob(s.scheduler, s.clock, {
      triggerType: "cron_like",
      cronExpr: "22:00",
      nextRunAt: planned.toISOString(),
    });

    assert.equal((await s.scheduler.tick()).due, 0, "21:30 不该触发 22:00 的任务");

    s.clock.setLocal(22, 0);
    const fired = await s.scheduler.tick();
    assert.equal(fired.due, 1);
    assert.equal(runs.length, 1);

    const next = s.scheduler.getJob(job.id)!;
    const nextDate = new Date(next.nextRunAt);
    assert.equal(nextDate.getHours(), 22);
    assert.equal(nextDate.getMinutes(), 0);
    assert.ok(Date.parse(next.nextRunAt) > Date.parse(s.clock.nowIso()), "下一次必须是未来时间");

    // 时间倒回同一分钟内不应该再触发一次
    assert.equal((await s.scheduler.tick()).due, 0);
  } finally {
    s.close();
  }
});

test("a failing handler is recorded and does not stop other jobs", async () => {
  const s = stack();
  try {
    s.scheduler.registerHandler("proactive_message", async (job) => {
      if (job.payload["explode"] === true) throw new Error("上游 429");
      return { outcome: "ran", reason: "ok" };
    });
    const bad = makeJob(s.scheduler, s.clock, { payload: { explode: true }, triggerType: "interval", intervalMs: 60_000 });
    const good = makeJob(s.scheduler, s.clock, { triggerType: "interval", intervalMs: 60_000 });

    const summary = await s.scheduler.tick();
    assert.equal(summary.due, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.ran, 1, "一个 job 失败不能阻止其它 job");
    assert.equal(s.scheduler.getJob(bad.id)?.status, "failed");
    const outcomes = summary.outcomes.find((outcome) => outcome.jobId === bad.id);
    assert.match(outcomes?.reason ?? "", /429/);
    assert.ok(s.scheduler.getJob(good.id)?.lastRunAt !== null);
  } finally {
    s.close();
  }
});

test("misfire policy drop skips stale jobs instead of firing a burst", async () => {
  const s = stack();
  try {
    let runs = 0;
    s.scheduler.registerHandler("proactive_message", async () => {
      runs += 1;
      return { outcome: "ran", reason: "ok" };
    });
    makeJob(s.scheduler, s.clock, {
      triggerType: "interval",
      intervalMs: 60_000,
      misfirePolicy: "drop",
      nextRunAt: new Date(Date.parse(s.clock.nowIso()) - 5 * 3600_000).toISOString(),
    });
    const summary = await s.scheduler.tick();
    assert.equal(summary.skipped, 1);
    assert.equal(runs, 0, "过期太久的任务按 drop 策略跳过");
    assert.match(summary.outcomes[0]?.reason ?? "", /misfire/);
  } finally {
    s.close();
  }
});

test("runNow executes immediately without shifting the schedule", async () => {
  const s = stack();
  try {
    let runs = 0;
    s.scheduler.registerHandler("proactive_message", async () => {
      runs += 1;
      return { outcome: "ran", reason: "manual" };
    });
    const job = makeJob(s.scheduler, s.clock, { triggerType: "interval", intervalMs: 3600_000 });
    const before = s.scheduler.getJob(job.id)!.nextRunAt;
    const outcome = await s.scheduler.runNow(job.id);
    assert.equal(outcome?.outcome, "ran");
    assert.equal(runs, 1);
    assert.equal(s.scheduler.getJob(job.id)?.nextRunAt, before, "手动执行不改变下一次计划时间");
  } finally {
    s.close();
  }
});
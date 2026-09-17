import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedReasonLabel,
  decisionLabel,
  formatDuration,
  formatMoment,
  jobKindHint,
  jobKindLabel,
  jobStatusLabel,
  nextRunText,
  proactiveTriggerLabel,
  rawValue,
  taskStatusLabel,
  triggerLabel,
} from "../src/lib/labels.ts";

test("任务种类：内部枚举 → 中文（不显示英文）", () => {
  assert.equal(jobKindLabel("scheduled_message"), "定时消息");
  assert.equal(jobKindLabel("proactive_message"), "主动消息");
  assert.equal(jobKindLabel("event_maintenance"), "事件维护");
  assert.equal(jobKindLabel("task_runner"), "任务执行");
  assert.equal(jobKindLabel("custom"), "自定义任务");
  for (const raw of ["scheduled_message", "proactive_message", "event_maintenance"]) {
    assert.equal(jobKindLabel(raw).includes("_"), false, "中文标签里不能出现下划线枚举");
  }
});

test("触发方式：once / interval / cron_like / idle / event → 中文", () => {
  assert.equal(triggerLabel("once"), "一次性");
  assert.equal(triggerLabel("interval"), "间隔重复");
  assert.equal(triggerLabel("cron_like"), "每天固定时间");
  assert.equal(triggerLabel("idle"), "空闲触发");
  assert.equal(triggerLabel("event"), "事件触发");
});

test("状态：调度任务与工作项都有中文，且停用优先", () => {
  assert.equal(jobStatusLabel({ enabled: true, status: "idle" }), "待机中");
  assert.equal(jobStatusLabel({ enabled: true, status: "running" }), "执行中");
  assert.equal(jobStatusLabel({ enabled: true, status: "failed" }), "执行失败");
  assert.equal(jobStatusLabel({ enabled: false, status: "idle" }), "已停用");
  assert.equal(jobStatusLabel({ enabled: false, status: "failed" }), "已停用", "停用的任务不该显示成执行失败");
  assert.equal(taskStatusLabel("pending"), "待执行");
  assert.equal(taskStatusLabel("running"), "执行中");
  assert.equal(taskStatusLabel("completed"), "已完成");
  assert.equal(taskStatusLabel("failed"), "执行失败");
  assert.equal(taskStatusLabel("cancelled"), "已取消");
});

test("主动消息的触发原因与决策结果都是中文", () => {
  assert.equal(proactiveTriggerLabel("idle_check"), "隔了一段时间没说话");
  assert.equal(proactiveTriggerLabel("scheduled_window"), "到了约定的时间");
  assert.equal(proactiveTriggerLabel("event_due"), "有事情临近了");
  assert.equal(proactiveTriggerLabel("manual"), "你手动触发");
  assert.equal(decisionLabel("sent"), "已发送");
  assert.equal(decisionLabel("failed"), "发送失败");
  assert.equal(blockedReasonLabel("cooldown"), "距上次太近（冷却中）");
  assert.equal(blockedReasonLabel("empty_generation"), "生成内容为空");
  assert.equal(blockedReasonLabel(null), "没有说明");
});

test("时间说明：cron_like 显示成每天几点，不再暴露 cron_like", () => {
  const cron = nextRunText({ enabled: true, triggerType: "cron_like", cronExpr: "22:00", nextRunAt: "2026-09-17T14:00:00.000Z", intervalMs: null });
  assert.equal(cron, "每天 22:00 执行");
  assert.equal(cron.includes("cron"), false);
  const interval = nextRunText({ enabled: true, triggerType: "interval", cronExpr: null, nextRunAt: "2026-09-17T14:00:00.000Z", intervalMs: 1_800_000 });
  assert.match(interval, /每 30 分钟检查一次/);
  const idle = nextRunText({ enabled: true, triggerType: "idle", cronExpr: null, nextRunAt: "2026-09-17T14:00:00.000Z", intervalMs: 1_800_000 });
  assert.match(idle, /自动判断/);
  const off = nextRunText({ enabled: false, triggerType: "once", cronExpr: null, nextRunAt: "2026-09-17T14:00:00.000Z", intervalMs: null });
  // 不能把本地时区的渲染结果写死：CI 跑在 UTC，本机是 UTC+8，写死就会在别处翻车。
  // 用同一个格式化函数算出期望值，断言"它说的是这个时间"，而不是"它是这个字符串"。
  assert.equal(off, "原本定在 " + formatMoment("2026-09-17T14:00:00.000Z"), "停用的也要说清原本的安排，不能只显示一个破折号");
  assert.equal(off.includes("—"), false);
  const offCron = nextRunText({ enabled: false, triggerType: "cron_like", cronExpr: "22:00", nextRunAt: "2026-09-17T14:00:00.000Z", intervalMs: null });
  assert.equal(offCron, "原本每天 22:00 执行", "状态徽标已经写了已停用，这里不重复");
  const offInterval = nextRunText({ enabled: false, triggerType: "interval", cronExpr: null, nextRunAt: "2026-09-17T14:00:00.000Z", intervalMs: 21_600_000 });
  assert.equal(offInterval, "原本每 6 小时检查一次");
  assert.equal(formatDuration(90_000), "2 分钟");
  assert.equal(formatDuration(7_200_000), "2 小时");
});

test("未知枚举：显示中文占位 + 原始值留给调试，绝不 undefined、绝不崩", () => {
  assert.equal(jobKindLabel("brand_new_type"), "未知任务类型");
  assert.equal(triggerLabel("every_full_moon"), "未知触发方式");
  assert.equal(taskStatusLabel("weird_status"), "未知状态");
  assert.equal(proactiveTriggerLabel("mystery"), "未知触发原因");
  assert.equal(decisionLabel("???"), "未知结果");
  assert.equal(blockedReasonLabel("some_new_rule"), "被规则拦下");
  // 原始值只通过 rawValue 暴露给 tooltip / 开发者信息区
  assert.equal(rawValue("brand_new_type"), "brand_new_type");
  assert.equal(rawValue(null), undefined);
  assert.equal(jobKindLabel(undefined), "未知任务类型");
  assert.equal(triggerLabel(null), "未知触发方式");
  assert.equal(taskStatusLabel(""), "未知状态");
  assert.equal(jobKindHint("brand_new_type"), undefined, "未知类型没有说明文案，界面不应显示 undefined");
  assert.equal(formatMoment(null), "—");
  assert.equal(formatMoment("not-a-date"), "—");
});

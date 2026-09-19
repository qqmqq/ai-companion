import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeDayPart,
  describeNowForPrompt,
  describeRelative,
  formatDateWithWeekday,
  formatDateTimeLocal,
  formatShortMoment,
} from "../../src/util/time-format.ts";

/** 固定时区：断言与跑测试的机器无关（CI 在 UTC，本机可能在 UTC+8） */
const TZ = "Asia/Shanghai";
const NOW = "2026-09-19T06:32:00.000Z"; // 本地 2026-09-19 14:32

test("说清「现在」：日期 + 星期 + 时刻 + 时段", () => {
  assert.equal(describeNowForPrompt(NOW, TZ), "2026年9月19日 周六 14:32（下午）");
  assert.equal(describeNowForPrompt("2026-09-19T23:10:00.000Z", TZ), "2026年9月20日 周日 07:10（早上）");
  assert.equal(describeNowForPrompt("not-a-date", TZ), "not-a-date", "解析不了就原样返回，不抛错");
});

test("说清「什么时候」：两种写法各有用途", () => {
  const iso = "2026-09-16T12:14:00.000Z"; // 本地 20:14
  assert.equal(formatDateTimeLocal(iso, TZ), "2026-09-16 20:14");
  assert.equal(formatShortMoment(iso, TZ), "9月16日 20:14");
  assert.equal(formatDateWithWeekday(iso, TZ), "2026年9月16日 周三");
});

test("说清「多久以前」：只用整数量级，像人说的", () => {
  assert.equal(describeRelative("2026-09-19T06:31:30.000Z", NOW), "刚刚");
  assert.equal(describeRelative("2026-09-19T06:20:00.000Z", NOW), "12 分钟前");
  assert.equal(describeRelative("2026-09-19T03:00:00.000Z", NOW), "3 小时前");
  assert.equal(describeRelative("2026-09-18T02:00:00.000Z", NOW), "昨天");
  assert.equal(describeRelative("2026-09-16T12:14:00.000Z", NOW), "2 天前", "不满三天就说两天");
  assert.equal(describeRelative("2026-09-16T06:32:00.000Z", NOW), "3 天前");
  assert.equal(describeRelative("2026-09-08T06:32:00.000Z", NOW), "1 周前");
  assert.equal(describeRelative("2026-08-01T06:32:00.000Z", NOW), "1 个月前");
  assert.equal(describeRelative("2025-01-01T00:00:00.000Z", NOW), "1 年前");
  assert.equal(describeRelative("2026-09-19T07:00:00.000Z", NOW), "（在未来）", "时钟飘一点不该说出「-5 分钟前」");
  assert.equal(describeRelative("not-a-date", NOW), "");
});

test("时段：不同钟点说话的口气不一样", () => {
  const at = (utcHour: number): string => `2026-09-19T${String(utcHour).padStart(2, "0")}:00:00.000Z`;
  // 本地 = UTC+8
  assert.equal(describeDayPart(at(18), TZ), "凌晨");
  assert.equal(describeDayPart(at(23), TZ), "早上");
  assert.equal(describeDayPart(at(2), TZ), "上午");
  assert.equal(describeDayPart(at(4), TZ), "中午");
  assert.equal(describeDayPart(at(6), TZ), "下午");
  assert.equal(describeDayPart(at(10), TZ), "傍晚");
  assert.equal(describeDayPart(at(12), TZ), "晚上");
  assert.equal(describeDayPart(at(15), TZ), "深夜");
  assert.equal(describeDayPart("not-a-date", TZ), "");
});

test("凌晨整点的小时数按 00 写，而不是 24", () => {
  assert.equal(formatDateTimeLocal("2026-09-19T16:05:00.000Z", TZ), "2026-09-20 00:05");
});

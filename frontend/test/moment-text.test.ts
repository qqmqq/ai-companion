import { test } from "node:test";
import assert from "node:assert/strict";
import { describeMoment, describeRelative, formatDateTimeLocal } from "../src/lib/moment-text.ts";

const NOW = new Date("2026-09-19T06:32:00.000Z");
const LOCAL = new Date(2026, 8, 19, 14, 32, 0).toISOString();

test("本地时间写法：2026-09-16 20:14", () => {
  const iso = new Date(2026, 8, 16, 20, 14, 0).toISOString();
  assert.equal(formatDateTimeLocal(iso), "2026-09-16 20:14");
  assert.equal(formatDateTimeLocal("not-a-date"), "not-a-date", "解析不了就原样返回");
});

test("多久以前：整数量级，像人说的", () => {
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
  assert.equal(describeRelative(ago(30_000), NOW), "刚刚");
  assert.equal(describeRelative(ago(12 * 60_000), NOW), "12 分钟前");
  assert.equal(describeRelative(ago(3 * 3_600_000), NOW), "3 小时前");
  assert.equal(describeRelative(ago(30 * 3_600_000), NOW), "昨天");
  assert.equal(describeRelative(ago(3 * 86_400_000), NOW), "3 天前");
  assert.equal(describeRelative(ago(10 * 86_400_000), NOW), "1 周前");
  assert.equal(describeRelative(ago(200 * 86_400_000), NOW), "6 个月前");
  assert.equal(describeRelative(ago(400 * 86_400_000), NOW), "1 年前");
  assert.equal(describeRelative(new Date(NOW.getTime() + 60_000).toISOString(), NOW), "（在未来）");
  assert.equal(describeRelative("not-a-date", NOW), "");
});

test("一句话：时间 + 距今多久", () => {
  const iso = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
  assert.match(describeMoment(iso, NOW), /（3 天前）$/);
  assert.match(describeMoment(iso, NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（3 天前）$/);
  assert.equal(describeMoment("not-a-date", NOW), "not-a-date");
  void LOCAL;
});

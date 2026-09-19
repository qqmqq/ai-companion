/**
 * 给界面用的时间说法：与后端 `util/time-format.ts` 同一套口径（前端独立实现，不能 import 后端源码）。
 * 记忆列表里显示「记于 2026-09-16 20:14（3 天前）」，让"记了多久"这件事看得见。
 */

function pad(value: number): string {
  return value < 10 ? "0" + String(value) : String(value);
}

/** 2026-09-16 20:14（本地时间） */
export function formatDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    String(date.getFullYear()) +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

/** 刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 2 天前 / 1 个月前 / 1 年前 */
export function describeRelative(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return "（在未来）";
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + " 分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + " 小时前";
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return String(days) + " 天前";
  if (days < 30) return String(Math.floor(days / 7)) + " 周前";
  if (days < 365) return String(Math.floor(days / 30)) + " 个月前";
  return String(Math.floor(days / 365)) + " 年前";
}

/** 一句话：2026-09-16 20:14（3 天前） */
export function describeMoment(iso: string, now: Date = new Date()): string {
  const relative = describeRelative(iso, now);
  return formatDateTimeLocal(iso) + (relative.length === 0 ? "" : "（" + relative + "）");
}

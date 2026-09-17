import type { Clock } from "../ports/clock.ts";

/**
 * 时间意图 → 具体触发时间（纯函数，便于直接测试）。
 *
 * 约定：
 * - 相对时间（"1 分钟后"）与时间无关，直接 now + seconds；
 * - 绝对时间（"晚上 8 点"）按**本机时区**的挂钟时间解释，并把时区名记录在 job 上；
 * - 已经过去的"今天 X 点"顺延到明天（不猜"是不是明天"，而是明确顺延并记录）；
 * - "每天 X 点"复用调度器已有的 cron_like（cronExpr = "HH:mm"），不新建定时器。
 */
export interface ScheduleWhen {
  kind: "delay" | "clock";
  seconds?: number | null;
  day?: "today" | "tomorrow" | "daily" | "weekday" | null;
  /** 1 = 周一 … 7 = 周日（day = "weekday" 时使用） */
  weekday?: number | null;
  hour?: number | null;
  minute?: number | null;
}

export interface ResolvedRunAt {
  runAt: string | null;
  cronExpr: string | null;
  /** 供日志与 job payload 记录（不是硬编码 UTC） */
  timezone: string;
}

/** 本机时区名（例如 Asia/Shanghai）；拿不到就退化成 "local" */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
  } catch {
    return "local";
  }
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function resolveRunAt(when: ScheduleWhen, now: Date, timeZone = localTimeZone()): ResolvedRunAt {
  if (when.kind === "delay") {
    const seconds = Math.floor(when.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return { runAt: null, cronExpr: null, timezone: timeZone };
    return { runAt: new Date(now.getTime() + seconds * 1000).toISOString(), cronExpr: null, timezone: timeZone };
  }

  // 只给了日期（"下周一"）没给时间：默认 09:00，并在回执里明确写出来，用户可纠正
  const hour = when.hour ?? (when.day === "weekday" || when.day === "tomorrow" ? 9 : null);
  const minute = when.minute ?? 0;
  if (hour === null || hour === undefined || !Number.isFinite(hour) || hour < 0 || hour > 23) {
    return { runAt: null, cronExpr: null, timezone: timeZone };
  }
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return { runAt: null, cronExpr: null, timezone: timeZone };

  if (when.day === "daily") {
    return { runAt: null, cronExpr: two(hour) + ":" + two(minute), timezone: timeZone };
  }

  // 用本机挂钟时间构造（服务器就是用户自己的机器）
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (when.day === "weekday" && typeof when.weekday === "number" && when.weekday >= 1 && when.weekday <= 7) {
    const target = when.weekday % 7; // 1..7 → JS 的 1..6,0
    let delta = (target - candidate.getDay() + 7) % 7;
    if (delta === 0 && candidate.getTime() <= now.getTime()) delta = 7;
    candidate.setDate(candidate.getDate() + delta);
    return { runAt: candidate.toISOString(), cronExpr: null, timezone: timeZone };
  }
  if (when.day === "tomorrow" || candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return { runAt: candidate.toISOString(), cronExpr: null, timezone: timeZone };
}

/** 给用户看的本地时间（回执/回执式确认里用） */
export function formatLocal(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hhmm = two(date.getHours()) + ":" + two(date.getMinutes());
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return hhmm;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return "明天 " + hhmm;
  return two(date.getMonth() + 1) + "月" + two(date.getDate()) + "日 " + hhmm;
}

export function nowFrom(clock: Clock): Date {
  return clock.now();
}

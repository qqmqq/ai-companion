/**
 * 时间窗计算（本地时钟语义）。
 * 全部是纯函数：给定一个 Date 与配置，返回确定结果，便于用 FakeClock 测试。
 */
export interface TimeOfDay {
  hour: number;
  minute: number;
}

export function parseTimeOfDay(raw: string): TimeOfDay | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function minutesOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

export function toMinutes(time: TimeOfDay): number {
  return time.hour * 60 + time.minute;
}

/** 支持跨夜窗口：23:00 ~ 08:00 表示从当天 23:00 到次日 08:00。 */
export function isWithinWindow(at: Date, startRaw: string, endRaw: string): boolean {
  const start = parseTimeOfDay(startRaw);
  const end = parseTimeOfDay(endRaw);
  if (start === null || end === null) return false;
  const now = minutesOfDay(at);
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return now >= startMinutes && now < endMinutes;
  return now >= startMinutes || now < endMinutes;
}

/** 下一次进入/离开时间窗的时间点（用于把任务安排到窗口外）。 */
export function nextWindowEnd(at: Date, endRaw: string): Date {
  const end = parseTimeOfDay(endRaw);
  if (end === null) return at;
  const result = new Date(at.getTime());
  result.setSeconds(0, 0);
  result.setHours(end.hour, end.minute, 0, 0);
  if (result.getTime() <= at.getTime()) result.setDate(result.getDate() + 1);
  return result;
}

/** 每天固定时刻的下一次触发时间（cron_like 支持 "HH:MM"）。 */
export function nextDailyOccurrence(at: Date, raw: string): Date | null {
  const target = parseTimeOfDay(raw);
  if (target === null) return null;
  const result = new Date(at.getTime());
  result.setSeconds(0, 0);
  result.setHours(target.hour, target.minute, 0, 0);
  if (result.getTime() <= at.getTime()) result.setDate(result.getDate() + 1);
  return result;
}

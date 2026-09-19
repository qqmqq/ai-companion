/**
 * 现实时间 → 给角色看的中文说法。
 *
 * 角色要有时间概念，靠两件事：一是"现在几点"，二是"这件事是什么时候发生的、离现在多久"。
 * 这里只做纯格式化：传入 ISO 字符串与时间基准，输出稳定的中文文本（因此可被用例钉死）。
 *
 * 时区：默认用系统本地时区；需要确定性时显式传 timeZone（测试都这么做）。
 */

function parts(iso: string, timeZone?: string): Record<string, string> {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return {};
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/** 2026-09-16 20:14（本地时间，给模型看的机器可读写法） */
export function formatDateTimeLocal(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  if (p["year"] === undefined) return iso;
  const hour = p["hour"] === "24" ? "00" : (p["hour"] ?? "00");
  return `${p["year"]}-${p["month"]}-${p["day"]} ${hour}:${p["minute"]}`;
}

/** 2026年9月16日 周三 —— 给"现在是…"这类句子用 */
export function formatDateWithWeekday(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  if (p["year"] === undefined) return iso;
  return `${p["year"]}年${String(Number(p["month"]))}月${String(Number(p["day"]))}日 ${p["weekday"] ?? ""}`.trim();
}

/** 9月20日 12:00 —— 说"什么时候"时短一些（年份常常是多余的） */
export function formatShortMoment(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  if (p["year"] === undefined) return iso;
  const hour = p["hour"] === "24" ? "00" : (p["hour"] ?? "00");
  return `${String(Number(p["month"]))}月${String(Number(p["day"]))}日 ${hour}:${p["minute"]}`;
}

/** 一天里的时段：凌晨 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 / 深夜 */
export function describeDayPart(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  const raw = p["hour"];
  // 注意别把「没有小时」当 0：Number("") === 0，会把解析失败说成凌晨
  const hour = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(hour)) return "";
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

/**
 * 离现在多久：刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 3 天前 / 2 周前 / 1 个月前 / 1 年前。
 * 只用整数量级，够角色说人话就行（"三天前"比"3.214 天前"更像人说的）。
 */
export function describeRelative(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return "";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return "（在未来）";
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + " 分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + " 小时前";
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return String(days) + " 天前";
  const weeks = Math.floor(days / 7);
  if (days < 30) return String(weeks) + " 周前";
  const months = Math.floor(days / 30);
  if (days < 365) return String(months) + " 个月前";
  return String(Math.floor(days / 365)) + " 年前";
}

/** 一句话说清"现在"：2026年9月19日 周六 14:32（下午） */
export function describeNowForPrompt(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  if (p["year"] === undefined) return iso;
  const hour = p["hour"] === "24" ? "00" : (p["hour"] ?? "00");
  const dayPart = describeDayPart(iso, timeZone);
  const clock = `${p["year"]}年${String(Number(p["month"]))}月${String(Number(p["day"]))}日 ${p["weekday"] ?? ""} ${hour}:${p["minute"]}`.trim();
  return dayPart.length === 0 ? clock : `${clock}（${dayPart}）`;
}

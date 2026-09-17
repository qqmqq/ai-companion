/**
 * 调度 / 任务的**显示层**中文映射。
 *
 * 原则：
 * - 数据库/API/代码里的稳定枚举一律不改（scheduled_message、once、cron_like…）；
 * - 只有这里负责把它们翻成用户看得懂的中文；
 * - 遇到不认识的取值不显示 undefined、也不崩，统一显示「未知…」并把原始值放进 tooltip 供开发排查。
 */

/** 任务种类（scheduled_jobs.kind / work_tasks.kind） */
export const JOB_KIND_LABELS: Record<string, string> = {
  scheduled_message: "定时消息",
  proactive_message: "主动消息",
  event_maintenance: "事件维护",
  task_runner: "任务执行",
  memory_extract: "记忆整理",
  summarize: "对话摘要",
  event_reminder: "事件提醒",
  custom: "自定义任务",
};

/** 给普通用户的一句话解释（鼠标悬停可见） */
export const JOB_KIND_HINTS: Record<string, string> = {
  scheduled_message: "按你指定的时间，自动发送一条消息。",
  proactive_message: "根据空闲时间、约定时间等条件，由角色主动给你发消息。",
  event_maintenance: "每隔一段时间自动检查事件状态（过期、到期等），不需要你操作。",
  task_runner: "执行已经到点的任务。",
  memory_extract: "从对话里整理值得记住的事。",
  summarize: "把较早的对话压缩成摘要。",
  event_reminder: "事件临近时的提醒。",
  custom: "你自己记下的一件事。",
};

/** 触发方式（scheduled_jobs.trigger_type） */
export const TRIGGER_LABELS: Record<string, string> = {
  once: "一次性",
  interval: "间隔重复",
  cron_like: "每天固定时间",
  idle: "空闲触发",
  event: "事件触发",
};

/** 定时提醒发到哪个渠道（scheduled_jobs.payload.channel） */
export const CHANNEL_LABELS: Record<string, string> = {
  web: "网页",
  weixin: "微信",
};

/** 调度任务状态（scheduled_jobs.status）；enabled=false 时对外一律说「已停用」 */
export const JOB_STATUS_LABELS: Record<string, string> = {
  idle: "待机中",
  running: "执行中",
  failed: "执行失败",
  disabled: "已停用",
};

/** 工作项状态（work_tasks.status） */
export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

/** 主动消息的触发原因（proactive_decisions.trigger_kind） */
export const PROACTIVE_TRIGGER_LABELS: Record<string, string> = {
  idle_check: "隔了一段时间没说话",
  scheduled_window: "到了约定的时间",
  event_due: "有事情临近了",
  task: "任务触发",
  manual: "你手动触发",
};

/** 决策结果（proactive_decisions.decision） */
export const DECISION_LABELS: Record<string, string> = {
  sent: "已发送",
  skipped: "没有发送",
  blocked: "被规则拦下",
  failed: "发送失败",
};

/** 被拦下的具体原因（blocked_reason） */
export const BLOCKED_REASON_LABELS: Record<string, string> = {
  disabled: "主动消息已关闭",
  autonomy_passive: "当前是「完全被动」",
  quiet_hours: "处于静音时段",
  daily_limit: "已达到今日上限",
  cooldown: "距上次太近（冷却中）",
  not_eligible: "现在没有合适的理由",
  no_conversation: "还没有会话",
  generation_failed: "生成失败",
  empty_generation: "生成内容为空",
  send_failed: "发送失败",
  no_character: "还没有角色",
  no_user_message: "你还没说过话",
  inactive_too_short: "才安静了一小会儿",
  no_due_event: "近期没有到期事件",
};

const UNKNOWN = "未知";

function lookup(table: Record<string, string>, value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return UNKNOWN + fallback;
  return table[value] ?? UNKNOWN + fallback;
}

/** 原始内部值：只给 tooltip / 调试区用，不放进正文 */
export function rawValue(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function jobKindLabel(kind: string | null | undefined): string {
  return lookup(JOB_KIND_LABELS, kind, "任务类型");
}

export function jobKindHint(kind: string | null | undefined): string | undefined {
  return typeof kind === "string" ? JOB_KIND_HINTS[kind] : undefined;
}

export function channelLabel(channel: string | null | undefined): string {
  if (typeof channel !== "string" || channel.length === 0) return "聊天里";
  return CHANNEL_LABELS[channel] ?? "聊天里";
}

export function triggerLabel(triggerType: string | null | undefined): string {
  return lookup(TRIGGER_LABELS, triggerType, "触发方式");
}

export function taskStatusLabel(status: string | null | undefined): string {
  return lookup(TASK_STATUS_LABELS, status, "状态");
}

export function proactiveTriggerLabel(kind: string | null | undefined): string {
  return lookup(PROACTIVE_TRIGGER_LABELS, kind, "触发原因");
}

export function decisionLabel(decision: string | null | undefined): string {
  return lookup(DECISION_LABELS, decision, "结果");
}

export function blockedReasonLabel(reason: string | null | undefined): string {
  if (typeof reason !== "string" || reason.length === 0) return "没有说明";
  return BLOCKED_REASON_LABELS[reason] ?? "被规则拦下";
}

/** 任务状态：停用优先（用户更关心"它还跑不跑"） */
export function jobStatusLabel(job: { enabled: boolean; status: string }): string {
  if (!job.enabled) return "已停用";
  return lookup(JOB_STATUS_LABELS, job.status, "状态");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO → 本地可读时间（列表里用） */
export function formatMoment(iso: string | null | undefined): string {
  if (typeof iso !== "string" || iso.length === 0) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/**
 * 这条任务"什么时候会跑"：
 * - cron_like：每天 HH:MM 执行
 * - 间隔重复 / 空闲触发：说明是自动判断，并给出下次时间
 * - 已停用：—
 */
export function nextRunText(job: {
  enabled: boolean;
  triggerType: string;
  cronExpr: string | null;
  nextRunAt: string;
  intervalMs: number | null;
}): string {
  // 停用的任务也要说清"原本是怎么安排的"：只显示一个「—」等于把信息藏了。
  // 统一用「原本…」，不再重复"已停用"三个字 —— 卡片上的状态徽标已经写了。
  if (job.triggerType === "cron_like" && job.cronExpr !== null) {
    return job.enabled ? "每天 " + job.cronExpr + " 执行" : "原本每天 " + job.cronExpr + " 执行";
  }
  if (job.triggerType === "interval" && job.intervalMs !== null) {
    const every = "每 " + formatDuration(job.intervalMs) + "检查一次";
    return job.enabled ? every + "（下次 " + formatMoment(job.nextRunAt) + "）" : "原本" + every;
  }
  if (job.triggerType === "idle") {
    return job.enabled ? "自动判断（下次检查 " + formatMoment(job.nextRunAt) + "）" : "原本是空闲时自动判断";
  }
  return job.enabled ? "下一次执行：" + formatMoment(job.nextRunAt) : "原本定在 " + formatMoment(job.nextRunAt);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return String(minutes) + " 分钟";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return String(hours) + " 小时";
  return String(Math.round(hours / 24)) + " 天";
}

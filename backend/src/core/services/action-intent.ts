import type { TaskLLM } from "../ports/task-llm.ts";
import type { Logger } from "../ports/logger.ts";
import type { ScheduleWhen } from "./schedule-time.ts";
import { formatLocal, localTimeZone } from "./schedule-time.ts";

/**
 * 自然语言 → 结构化动作意图（事件 / 任务 / 定时消息 / 取消 / 查询）。
 *
 * 铁律：
 * 1. 模型只产出**受约束的 JSON**，永远不接触数据库或渠道；
 * 2. 时间由应用层根据"当前时间 + 时区"换算，模型不许自己编日期；
 * 3. 说不清就问（needs_clarification），**绝不猜**；
 * 4. 任何失败都退化成 none —— 解析坏了不能把聊天搞坏。
 *
 * 与三类后台对象的对应关系（三者绝不混为一谈）：
 *   create_event    → events（"将要发生的事"）
 *   create_task     → work_tasks（"要去做的事"）
 *   schedule_message→ scheduled_jobs（"未来由系统主动发消息"）
 */
export type ActionIntentName = "none" | "schedule_message" | "create_event" | "create_task" | "cancel" | "query" | "needs_clarification";

export type CancelTarget = "schedule" | "event" | "task" | "any";

export interface ActionIntent {
  intent: ActionIntentName;
  when: ScheduleWhen | null;
  /** 事件/任务标题 */
  title: string | null;
  /** 定时消息到点要发的原文 */
  message: string | null;
  /** 取消/查询的作用对象 */
  target: CancelTarget | null;
  /** 查询范围：今天 / 明天 / 全部 */
  range: "today" | "tomorrow" | "all" | null;
  /** 用户明确点名渠道时才有值（不透明字符串，Core 不认识具体平台） */
  channelHint: string | null;
}

const NONE: ActionIntent = { intent: "none", when: null, title: null, message: null, target: null, range: null, channelHint: null };

/**
 * 便宜的前置过滤：只有像"要做/有安排/提醒/定时/查询"的消息才调用模型。
 * 宁可宽一点（多一次便宜档调用），也不要漏 —— 漏掉等于"用户提了要求、系统什么也没做"。
 * 注意「我今天很累，明天还要上班」这类情绪表达**不应该**命中。
 */
const HINT = /(提醒|定时|闹钟|日程|安排|订|约|会议|开会|面试|考试|聚会|截止|deadline|记得|别忘|完成|做完|搞定|写完|复习|准备|提交|待办|任务|计划|备课|出发|航班|车票|交作业|晚安|早安|待会|待会儿|晚点|稍后|一会儿|(分钟|小时|秒)(之?后|以后|以内|之内|内)|(今天|明天|后天|下周|下个?月|周[一二三四五六日天]).{0,12}(点|要|去|有|做)|点(钟|半|整))/i;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function normalizeWhen(raw: unknown): ScheduleWhen | null | "invalid" {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return "invalid";
  const when = raw as Record<string, unknown>;
  if (when.kind === "delay") {
    const seconds = clampInt(when.seconds, 1, 30 * 24 * 3600);
    return seconds === null ? "invalid" : { kind: "delay", seconds };
  }
  if (when.kind === "clock") {
    const hour = when.hour === null || when.hour === undefined ? null : clampInt(when.hour, 0, 23);
    const minute = when.minute === null || when.minute === undefined ? 0 : clampInt(when.minute, 0, 59);
    if (hour === null && when.day !== "tomorrow" && when.day !== "weekday") return "invalid";
    if (minute === null) return "invalid";
    const day = when.day === "tomorrow" || when.day === "daily" || when.day === "today" || when.day === "weekday" ? when.day : "today";
    const weekday = when.weekday === null || when.weekday === undefined ? null : clampInt(when.weekday, 1, 7);
    return { kind: "clock", day, weekday, hour, minute };
  }
  return "invalid";
}

function normalize(raw: unknown): ActionIntent {
  if (raw === null || typeof raw !== "object") return NONE;
  const record = raw as Record<string, unknown>;
  const intent = record.intent;
  const channelHint = cleanText(record.channel, 32);

  if (intent === "cancel") {
    const target = record.target === "schedule" || record.target === "event" || record.target === "task" ? record.target : "any";
    return { ...NONE, intent: "cancel", target, channelHint };
  }
  if (intent === "query") {
    const range = record.range === "tomorrow" || record.range === "today" ? record.range : "all";
    const target = record.target === "schedule" || record.target === "event" || record.target === "task" ? record.target : "any";
    return { ...NONE, intent: "query", target, range, channelHint };
  }
  if (intent === "needs_clarification") return { ...NONE, intent: "needs_clarification", channelHint };

  const when = normalizeWhen(record.when);

  if (intent === "schedule_message") {
    if (when === "invalid") return { ...NONE, intent: "needs_clarification", message: cleanText(record.message, 500), channelHint };
    if (when === null) return { ...NONE, intent: "needs_clarification", message: cleanText(record.message, 500), channelHint };
    return { ...NONE, intent: "schedule_message", when, message: cleanText(record.message, 500), channelHint };
  }
  if (intent === "create_event" || intent === "create_task") {
    const title = cleanText(record.title, 200);
    if (title === null) return { ...NONE, intent: "needs_clarification", channelHint };
    // 事件/任务在没有明确钟点时不算错：交给应用层用默认时间（今天 23:00）并在回执里写清楚
    return { ...NONE, intent, title, when: when === "invalid" ? null : when, channelHint };
  }
  return NONE;
}

/** 导出只为诊断（"模型到底看到了什么"）：它是纯函数，不碰任何状态。 */
export function buildPrompt(userText: string, now: Date, timeZone: string): string {
  return [
    "你是助手动作解析器。只输出一个 JSON 对象，不要解释、不要代码块。",
    "当前本地时间：" + formatLocal(now.toISOString(), now) + "（时区 " + timeZone + "）",
    "可选形状（字段名必须完全一致）：",
    '{"intent":"schedule_message","when":{"kind":"delay","seconds":60},"message":"提醒我带伞","channel":null}',
    '{"intent":"schedule_message","when":{"kind":"clock","day":"today","hour":20,"minute":0},"message":"提醒我吃饭"}',
    '{"intent":"create_event","title":"客户会议","when":{"kind":"clock","day":"tomorrow","hour":15,"minute":0}}',
    '{"intent":"create_task","title":"完成论文","when":{"kind":"clock","day":"today","hour":18,"minute":0}}',
    '{"intent":"cancel","target":"schedule|event|task|any"}',
    '{"intent":"query","range":"today|tomorrow|all","target":"schedule|event|task|any"}',
    '{"intent":"needs_clarification"}',
    '{"intent":"none"}',
    "判断规则（先判断有没有「要记下来的事」，再判断是哪一类）：",
    "1. schedule_message=未来由**你**主动发一条消息给对方（例：提醒我带伞、一分钟后给我发消息、晚上8点跟我说晚安）。message 是要发出去的原文。",
    "2. create_event=**将要发生的事 / 安排**（例：明天下午3点有客户会议、周五聚餐、明天面试）。title 是事件名。",
    "3. create_task=**对方自己要去做的事、待办、义务**。只要对方说他/她要去做、要完成、要交、要准备某件事，**一律** create_task，即使句子很随意、即使没有具体钟点。例：今天要完成论文 / 今天把论文完成 / 我要把报告写完 / 下周一交作业 / 晚上得复习。title 用动词短语（如 完成论文）。",
    "4. 只有**纯粹的情绪、感受、闲聊、评价**才是 none（例：我今天很累、明天还要上班、这个菜真好吃）。判断依据是「有没有一件要记下来的事」，不是「有没有出现明天/几点」。",
    "5. 有动作但时间说不清（例：晚点提醒我、过一会儿提醒我）→ needs_clarification，不要猜时间。注意：create_task / create_event 缺具体钟点**不算**说不清，照常输出，hour 不填。",
    "6. 「下周一」这类 → when.day=weekday + weekday(1=周一…7=周日)。",
    "7. 用户明确要求换渠道时 channel 填那个渠道的 kind；否则 null。",
    "用户消息：" + userText,
  ].join(String.fromCharCode(10));
}

export interface ActionIntentDetector {
  /** 便宜的前置过滤（导出便于测试与统计） */
  looksActionable(text: string): boolean;
  detect(text: string): Promise<ActionIntent>;
}

/**
 * 解析这一步的输出预算。
 *
 * 真实事故：deepseek 这类"先想再答"的模型在 200 tokens 下会把 JSON 截成半截（finishReason=length），
 * 甚至直接返回空字符串；而旧代码把"解析不出来"和"模型说 none"当成同一件事，
 * 于是用户明明说了「提醒我…」却什么都没发生，角色还回了一句"我会提醒你"。
 */
const INTENT_MAX_OUTPUT_TOKENS = 600;
const INTENT_RETRY_MAX_OUTPUT_TOKENS = 1200;

export function createActionIntentDetector(deps: { taskLLM: TaskLLM; logger: Logger; clock: () => Date }): ActionIntentDetector {
  async function ask(text: string, now: Date, maxOutputTokens: number): Promise<{ text: string; finishReason: string }> {
    // 模型由 ModelRouter 决定（这里只声明"这是 proactive 档任务"）
    const binding = deps.taskLLM.resolve("proactive");
    const response = await deps.taskLLM.chat("proactive", {
      model: binding.model,
      messages: [{ role: "system", content: buildPrompt(text, now, localTimeZone()) }],
      maxOutputTokens,
      temperature: 0,
    });
    return { text: response.text, finishReason: response.finishReason };
  }

  return {
    looksActionable: (text) => HINT.test(text),
    async detect(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0 || !HINT.test(trimmed)) return NONE;
      try {
        const now = deps.clock();
        let attempt = await ask(trimmed, now, INTENT_MAX_OUTPUT_TOKENS);
        let parsed = extractJson(attempt.text);
        // 只有"模型确实吐出了可解析的 JSON"才算一次可靠的判断；空输出/半截 JSON 一律重问一次
        if (parsed === null) {
          deps.logger.warn("intent output was unusable; asking once more", {
            step: "intent.retry",
            status: "retrying",
            errorCategory: "intent_unparsed",
            rawLength: attempt.text.length,
            finishReason: attempt.finishReason,
          });
          attempt = await ask(trimmed, now, INTENT_RETRY_MAX_OUTPUT_TOKENS);
          parsed = extractJson(attempt.text);
          if (parsed === null) {
            // 两次都问不出结构：承认这一轮没听懂，让角色把话问回来，绝不静默当成"只是闲聊"
            deps.logger.warn("intent output unusable twice; asking the user instead of silently doing nothing", {
              step: "intent.detected",
              status: "failed",
              errorCategory: "intent_unparsed",
              rawLength: attempt.text.length,
              finishReason: attempt.finishReason,
            });
            return { ...NONE, intent: "needs_clarification" };
          }
        }
        const intent = normalize(parsed);
        deps.logger.info("intent detected", {
          step: "intent.detected",
          status: "completed",
          intent: intent.intent,
          whenKind: intent.when === null ? null : intent.when.kind,
          hasTitle: intent.title !== null,
          target: intent.target,
        });
        return intent;
      } catch (error) {
        deps.logger.warn("intent detection failed; treating as normal chat", {
          step: "intent.detected",
          status: "failed",
          errorCategory: "intent_unavailable",
          error: (error as Error).message,
        });
        return NONE;
      }
    },
  };
}

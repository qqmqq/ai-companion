import type { ConversationId } from "../model/ids.ts";
import type { Message } from "../model/message.ts";
import type { SummaryRecord } from "../ports/repositories.phase2.ts";
import type { ConversationRepository, MessageRepository, SettingsRepository } from "../ports/repositories.ts";
import type { SummaryRepository } from "../ports/repositories.phase2.ts";
import type { TaskLLM } from "../ports/task-llm.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import { uuidv7 } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";

export interface SummaryServiceDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  summaries: SummaryRepository;
  taskLLM: TaskLLM;
  settings: SettingsRepository;
  logger: Logger;
  clock: Clock;
}

export interface SummaryPlan {
  run: boolean;
  reason: string;
  candidates: Message[];
  coveredTo: string | null;
}

export const SUMMARY_SYSTEM_PROMPT = [
  "你是一个对话压缩器。把给定的对话片段压缩成简短、事实准确的摘要。",
  "要求：",
  "1. 保留事实、承诺、偏好、情绪转折与关系变化；省略寒暄。",
  "2. 用第三人称陈述，明确区分「用户」与角色名。",
  "3. 不超过 200 字，不要输出标题或 Markdown。",
].join("\n");

/** 触发条件：消息够多，且"未被摘要覆盖"的旧消息够一段。 */
export function planSummary(input: {
  messages: Message[];
  latest: SummaryRecord | null;
  triggerMessages: number;
  keepRecent: number;
  minBatch: number;
}): SummaryPlan {
  const { messages, latest } = input;
  if (messages.length < input.triggerMessages) {
    return { run: false, reason: `belowTrigger:${messages.length}<${input.triggerMessages}`, candidates: [], coveredTo: latest?.toMessageId ?? null };
  }
  const coveredIndex = latest === null ? -1 : messages.findIndex((message) => message.id === latest.toMessageId);
  const afterCovered = coveredIndex >= 0 ? messages.slice(coveredIndex + 1) : messages;
  const candidates = afterCovered.slice(0, Math.max(0, afterCovered.length - input.keepRecent));
  if (candidates.length < input.minBatch) {
    return { run: false, reason: `batchTooSmall:${candidates.length}<${input.minBatch}`, candidates: [], coveredTo: latest?.toMessageId ?? null };
  }
  return { run: true, reason: "ok", candidates, coveredTo: latest?.toMessageId ?? null };
}

export function createSummaryService(deps: SummaryServiceDeps) {
  function plan(conversationId: ConversationId): SummaryPlan {
    const messages = deps.messages.listByConversation(conversationId, { limit: 500 });
    return planSummary({
      messages,
      latest: deps.summaries.latest(conversationId),
      triggerMessages: Math.max(4, deps.settings.get<number>("summary.triggerMessages", 40)),
      keepRecent: Math.max(0, deps.settings.get<number>("summary.keepRecent", 10)),
      minBatch: Math.max(1, deps.settings.get<number>("summary.minBatch", 10)),
    });
  }

  return {
    plan,

    /** 生成并持久化摘要；原始消息永不删除。 */
    async summarize(conversationId: ConversationId): Promise<SummaryRecord | null> {
      const conversation = deps.conversations.getById(conversationId);
      if (conversation === null) return null;
      const planned = plan(conversationId);
      if (!planned.run) return null;

      const transcript = planned.candidates
        .filter((message) => message.role === "user" || message.role === "character")
        .map((message) => `${message.role === "user" ? "用户" : "角色"}：${message.textRender}`)
        .join("\n");

      const binding = deps.taskLLM.resolve("summarization");
      const previous = deps.summaries.latest(conversationId);
      const response = await deps.taskLLM.chat(
        "summarization",
        {
          model: binding.model,
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                previous === null ? "" : `已有摘要：${previous.summary}`,
                "需要压缩的对话片段：",
                transcript,
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
            },
          ],
          temperature: 0,
        },
        { conversationId },
      );

      const summary: SummaryRecord = {
        id: uuidv7(),
        conversationId,
        fromMessageId: planned.candidates[0]!.id,
        toMessageId: planned.candidates[planned.candidates.length - 1]!.id,
        summary: response.text.trim(),
        tokenEstimate: response.usage.completionTokens,
        model: binding.model,
        providerId: binding.providerId,
        createdAt: deps.clock.nowIso(),
      };
      deps.summaries.insert(summary);
      deps.logger.info("conversation summarized", {
        conversationId,
        messages: planned.candidates.length,
        summaryId: summary.id,
      });
      return summary;
    },
  };
}

export type SummaryService = ReturnType<typeof createSummaryService>;
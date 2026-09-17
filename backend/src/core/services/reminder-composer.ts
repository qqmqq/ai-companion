import type { Conversation } from "../model/conversation.ts";
import type { UserId } from "../model/ids.ts";
import type { ContextEngine } from "../context/context-engine.ts";
import type { TaskLLM } from "../ports/task-llm.ts";
import type { Logger } from "../ports/logger.ts";

/**
 * 到点提醒的措辞：**不是把记录原文念一遍，而是让角色用自己的语气把这件事说出来**。
 *
 * 复用的是主动消息那条链路（ContextEngine + 人设/记忆/关系/情绪一起进上下文），
 * 区别只在注入的意图段：从"你想主动说点什么"换成"你答应过要提醒对方这件事"。
 *
 * 失败不在这里吞掉：调用方拿不到文案就退回原文（提醒绝不能因为模型抽风而丢掉）。
 */
/** 措辞这一步的输出预算；重试时给得更宽（见 compose 里的注释） */
const COMPOSE_MAX_OUTPUT_TOKENS = 600;
const COMPOSE_RETRY_MAX_OUTPUT_TOKENS = 1200;

export interface ReminderComposerDeps {
  context: ContextEngine;
  taskLLM: TaskLLM;
  logger: Logger;
}

export function createReminderComposer(deps: ReminderComposerDeps) {
  return {
    /** 生成到点提醒要说的话；模型没给出可用文案时返回空字符串，由调用方决定兜底 */
    async compose(input: { conversation: Conversation; userId: UserId; reminderText: string }): Promise<string> {
      const built = await deps.context.build({
        conversation: input.conversation,
        userId: input.userId,
        incomingMessage: null,
        taskType: "proactive",
        source: "proactive",
        reminderText: input.reminderText,
        triggerReason: input.reminderText,
      });
      const messages = deps.context.toChatMessages(built.bundle);
      /**
       * 输出预算是真事故换来的：200 tokens 对"先想再答"的模型太小，
       * 模型会把预算烧在思考上、正文返回空字符串 —— 那时就会退回记录原文，
       * 用户看到的就是一句「提醒我带伞」，没有人设。
       */
      const ask = async (maxOutputTokens: number) =>
        deps.taskLLM.chat(
          "proactive",
          { model: built.model.model, messages, maxOutputTokens, temperature: 0.8 },
          { conversationId: input.conversation.id, messageId: null },
        );

      let response = await ask(COMPOSE_MAX_OUTPUT_TOKENS);
      let text = response.text.trim();
      if (text.length === 0) {
        deps.logger.warn("reminder wording came back empty; asking once more", {
          step: "schedule.compose",
          status: "retrying",
          errorCategory: "empty_generation",
          finishReason: response.finishReason,
          conversationId: input.conversation.id,
        });
        response = await ask(COMPOSE_RETRY_MAX_OUTPUT_TOKENS);
        text = response.text.trim();
      }
      if (text.length === 0) {
        deps.logger.warn("reminder wording still empty; falling back to the recorded reminder", {
          step: "schedule.compose",
          status: "failed",
          errorCategory: "empty_generation",
          finishReason: response.finishReason,
          conversationId: input.conversation.id,
        });
      }
      return text;
    },
  };
}

export type ReminderComposer = ReturnType<typeof createReminderComposer>;

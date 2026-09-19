import type { Conversation } from "../model/conversation.ts";
import { DomainError, notFound } from "../model/errors.ts";
import type { ConversationId, MessageId, UserId } from "../model/ids.ts";
import type { MediaMessagePart, Message, MessagePart } from "../model/message.ts";
import type { TtsState } from "../model/tts.ts";
import { partsToText } from "../model/message.ts";
import type { ChatMessage } from "../ports/llm-provider.ts";
import type { TaskLLM } from "../ports/task-llm.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { ContextEngine } from "../context/context-engine.ts";
import type {
  CharacterRepository,
  ConversationRepository,
  MessageRepository,
  UserRepository,
} from "../ports/repositories.ts";
import type { SummaryRepository } from "../ports/repositories.phase2.ts";
import type { Clock } from "../ports/clock.ts";
import { uuidv7 } from "../../util/ids.ts";

export interface ConversationServiceDeps {
  /** Phase 5：{{user}} 宏需要用户显示名 */
  users: UserRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  characters: CharacterRepository;
  summaries: SummaryRepository;
  contextEngine: ContextEngine;
  taskLLM: TaskLLM;
  events: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}

export interface PostMessageResult {
  userMessage: Message;
  characterMessage: Message;
}

export interface StreamReplyOptions {
  signal?: AbortSignal;
  /** 每个增量回调；用于 SSE 推送，不参与落库粒度 */
  onDelta?: (chunk: string) => void;
  /** 落库节流（毫秒）：流式过程中不要把每个 chunk 都写库 */
  flushIntervalMs?: number;
  /** 动作执行结果（事实）：注入上下文让角色自然表达，而不是套固定模板 */
  actionNote?: string | null;
}

export function buildSystemPrompt(definition: { name: string; description: string; personality: string; scenario: string; systemPrompt: string }, stateText: string): string {
  return [
    `你是「${definition.name}」。请始终以该角色第一人称说话。`,
    definition.description.length > 0 ? `角色设定：${definition.description}` : "",
    definition.personality.length > 0 ? `性格：${definition.personality}` : "",
    definition.scenario.length > 0 ? `场景：${definition.scenario}` : "",
    definition.systemPrompt.length > 0 ? definition.systemPrompt : "",
    stateText.length > 0 ? `当前状态：${stateText}` : "",
    "约束：不要替用户说话；不要编造用户未提供的事实；不确定时直接说明。",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function createConversationService(deps: ConversationServiceDeps) {
  function requireConversation(id: ConversationId): Conversation {
    const conversation = deps.conversations.getById(id);
    if (conversation === null) throw notFound("conversation", id);
    return conversation;
  }

  /**
   * 开场白（Phase 5 §8/§9）：只在创建会话时写入一条 assistant 消息。
   * 宏 {{user}}/{{char}} 在这里解析；卡片原文一字不改（原文仍在角色版本里）。
   */
  function insertFirstMessage(conversation: Conversation, userId: UserId, at: string): void {
    const versionId = conversation.characterVersionId ?? null;
    if (versionId === null) return;
    const version = deps.characters.getVersion(versionId);
    if (version === null) return;
    const text = version.definition.firstMessage.trim();
    if (text.length === 0) return;
    insertMessage({
      conversationId: conversation.id,
      role: "character",
      parts: [{ kind: "text", text }],
      at,
    });
  }

  function insertMessage(input: {
    conversationId: ConversationId;
    role: Message["role"];
    parts: MessagePart[];
    replyToId?: MessageId | null;
    providerMessageId?: string | null;
    tokenCount?: number | null;
    status?: Message["status"];
    errorText?: string | null;
    source?: Message["source"];
    at?: string;
    branchOfId?: MessageId | null;
  }): Message {
    const at = input.at ?? deps.clock.nowIso();
    const message: Message = {
      id: uuidv7(),
      conversationId: input.conversationId,
      role: input.role,
      parts: input.parts,
      textRender: partsToText(input.parts),
      replyToId: input.replyToId ?? null,
      providerMessageId: input.providerMessageId ?? null,
      tokenCount: input.tokenCount ?? null,
      status: input.status ?? "completed",
      errorText: input.errorText ?? null,
      source: input.source ?? "conversation",
      createdAt: at,
      editedAt: null,
      branchOfId: input.branchOfId ?? null,
    };
    deps.messages.insert(message);
    deps.conversations.touchLastMessage(input.conversationId, at);
    deps.events.publish({
      name: "message.new",
      at,
      channel: null,
      payload: { conversationId: input.conversationId, messageId: message.id, role: message.role },
    });
    return message;
  }

  /** 组装发送给模型的消息：完全由 ContextEngine 决定，业务代码不自己拼历史。 */
  async function prepareChat(input: {
    conversation: Conversation;
    incoming: Message | null;
    userId: UserId;
    actionNote?: string | null;
  }): Promise<{ chat: ChatMessage[]; snapshotId: string | null; model: { providerId: string; model: string } }> {
    const built = await deps.contextEngine.build({
      conversation: input.conversation,
      userId: input.userId,
      incomingMessage: input.incoming,
      taskType: "chat",
      ...(input.actionNote === null || input.actionNote === undefined ? {} : { actionNote: input.actionNote }),
    });
    const messages = deps.contextEngine.toChatMessages(built.bundle).map((message) => ({
      role: message.role,
      content: message.content,
    })) as ChatMessage[];
    return { chat: messages, snapshotId: built.snapshotId, model: built.model };
  }

  async function generate(conversation: Conversation, userId: UserId, incoming: Message | null, actionNote: string | null = null): Promise<Message> {
    const prepared = await prepareChat({ conversation, incoming, userId, actionNote });
    const response = await deps.taskLLM.chat(
      "chat",
      { model: prepared.model.model, messages: prepared.chat },
      { conversationId: conversation.id, messageId: incoming?.id ?? null },
    );
    return insertMessage({
      conversationId: conversation.id,
      role: "character",
      parts: [{ kind: "text", text: response.text }],
      tokenCount: response.usage.completionTokens,
      status: "completed",
    });
  }

  return {
    list(userId: UserId, limit = 50): Conversation[] {
      return deps.conversations.listByUser(userId, limit);
    },

    get(id: ConversationId): Conversation {
      return requireConversation(id);
    },

    ensureConversation(input: {
      userId: UserId;
      characterId: string;
      channel: Conversation["channel"];
      accountId: string | null;
      conversationRef: string;
      title?: string;
    }): Conversation {
      const existing = deps.conversations.findByIdentity(input.channel, input.conversationRef, input.characterId);
      if (existing !== null) return existing;
      const at = deps.clock.nowIso();
      const character = deps.characters.getById(input.characterId);
      const conversation: Conversation = {
        id: uuidv7(),
        userId: input.userId,
        characterId: input.characterId,
        // Phase 5 §20：把角色版本冻结在会话上（改卡不影响已有会话）
        characterVersionId: character?.currentVersionId ?? null,
        channel: input.channel,
        accountId: input.accountId,
        conversationId: input.conversationRef,
        title: input.title ?? input.conversationRef,
        parentConversationId: null,
        status: "active",
        createdAt: at,
        lastMessageAt: null,
      };
      deps.conversations.insert(conversation);
      // Phase 5 §8：开场白只在**创建会话时**落库一次；刷新/重进不会重新生成
      insertFirstMessage(conversation, input.userId, at);
      deps.events.publish({
        name: "conversation.updated",
        at,
        channel: input.channel,
        payload: { conversationId: conversation.id },
      });
      return conversation;
    },

    messages(conversationId: ConversationId, options: { limit?: number; before?: string } = {}): Message[] {
      requireConversation(conversationId);
      return deps.messages.listByConversation(conversationId, options);
    },

    /**
     * 用户消息必须先落库，再进入上下文构建与模型调用。
     *
     * **幂等**：渠道在回复失败后会重投同一批消息（微信就是如此），
     * 没有这道闸门时同一条消息会被反复插入 —— 真实事故：一条消息在会话里出现了 5 次。
     * 有 providerMessageId 且已经落过库，就把那条还回去，不重复插入、不重复发事件。
     */
    appendUserMessage(conversationId: ConversationId, parts: MessagePart[], providerMessageId: string | null = null): Message {
      requireConversation(conversationId);
      if (providerMessageId !== null && providerMessageId.length > 0) {
        const existing = deps.messages.findByProviderMessageId(conversationId, providerMessageId);
        if (existing !== null) {
          deps.logger.info("duplicate inbound message ignored (same provider message id)", {
            step: "inbound.persist_user",
            status: "duplicate",
            conversationId,
            messageId: existing.id,
          });
          return existing;
        }
      }
      return insertMessage({ conversationId, role: "user", parts, providerMessageId, status: "completed" });
    },

    async reply(conversationId: ConversationId, userId: UserId, incoming: Message | null = null, options: { actionNote?: string | null } = {}): Promise<Message> {
      const conversation = requireConversation(conversationId);
      return generate(conversation, userId, incoming, options.actionNote ?? null);
    },

    async postMessage(conversationId: ConversationId, userId: UserId, parts: MessagePart[]): Promise<PostMessageResult> {
      const userMessage = this.appendUserMessage(conversationId, parts);
      const characterMessage = await this.reply(conversationId, userId, userMessage);
      return { userMessage, characterMessage };
    },

    /**
     * 流式回复：整段回复始终只有一条 assistant 消息。
     * partial → completed；中断/失败 → failed（保留已生成的部分，绝不留下"不存在的完整回复"）。
     */
    async streamReply(
      conversationId: ConversationId,
      userId: UserId,
      incoming: Message,
      options: StreamReplyOptions = {},
    ): Promise<Message> {
      const conversation = requireConversation(conversationId);
      const prepared = await prepareChat({ conversation, incoming, userId, actionNote: options.actionNote ?? null });

      const placeholder = insertMessage({
        conversationId,
        role: "character",
        parts: [{ kind: "text", text: "" }],
        status: "partial",
      });

      let text = "";
      const flushIntervalMs = options.flushIntervalMs ?? 150;
      let lastFlush = 0;
      const flush = (force: boolean): void => {
        const now = deps.clock.now().getTime();
        if (!force && now - lastFlush < flushIntervalMs) return;
        lastFlush = now;
        deps.messages.updateStreaming(placeholder.id, {
          parts: [{ kind: "text", text }],
          textRender: text,
          status: "partial",
          errorText: null,
        });
      };

      try {
        for await (const chunk of deps.taskLLM.stream(
          "chat",
          { model: prepared.model.model, messages: prepared.chat, ...(options.signal === undefined ? {} : { signal: options.signal }) },
          { conversationId, messageId: placeholder.id, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        )) {
          // 不提前 break：让流自然结束，provider 的收尾帧（含 usage）才能被记账
          if (chunk.text.length === 0) continue;
          text += chunk.text;
          options.onDelta?.(chunk.text);
          flush(false);
        }
        deps.messages.updateStreaming(placeholder.id, {
          parts: [{ kind: "text", text }],
          textRender: text,
          status: "completed",
          errorText: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.messages.updateStreaming(placeholder.id, {
          parts: [{ kind: "text", text }],
          textRender: text,
          status: "failed",
          errorText: message,
        });
        deps.logger.warn("streaming reply failed", { conversationId, messageId: placeholder.id, error: message });
        throw error;
      }

      const stored = deps.messages.getById(placeholder.id);
      if (stored === null) throw new DomainError("internal", "streamed message disappeared");
      deps.events.publish({
        name: "message.delta",
        at: deps.clock.nowIso(),
        channel: conversation.channel,
        payload: { conversationId, messageId: stored.id, text: stored.textRender, complete: true },
      });
      return stored;
    },

    async regenerate(messageId: MessageId, userId: UserId): Promise<Message> {
      const original = deps.messages.getById(messageId);
      if (original === null) throw notFound("message", messageId);
      if (original.role !== "character") {
        throw new DomainError("invalid_input", "只有角色消息可以重新生成");
      }
      const conversation = requireConversation(original.conversationId);
      const generated = await generate(conversation, userId, null);
      return { ...generated, branchOfId: original.id };
    },

    /**
     * 把生成出来的语音挂到这条助手消息上（Phase 4.5-D4）。
     *
     * 刻意**不**改 text_render：文字回复才是权威内容，语音只是它的一个附加表示；
     * 而且这样也不会把 "[语音]" 混进上下文文本里（上下文只应当看到模型真正说过的话）。
     */
    attachGeneratedSpeech(messageId: MessageId, part: MediaMessagePart, tts: TtsState): Message {
      const message = deps.messages.getById(messageId);
      if (message === null) throw notFound("message", messageId);
      deps.messages.updateEdited(messageId, [...message.parts, part], message.textRender, deps.clock.nowIso());
      deps.messages.setTts(messageId, tts);
      const updated = deps.messages.getById(messageId);
      if (updated === null) throw new DomainError("internal", "message disappeared after attaching speech");
      return updated;
    },

    /** 只更新消息级 TTS 状态（生成中 / 失败 / 跳过），不动任何部件 */
    setSpeechState(messageId: MessageId, tts: TtsState): Message {
      const message = deps.messages.getById(messageId);
      if (message === null) throw notFound("message", messageId);
      deps.messages.setTts(messageId, tts);
      const updated = deps.messages.getById(messageId);
      if (updated === null) throw new DomainError("internal", "message disappeared after speech state update");
      return updated;
    },

    editMessage(messageId: MessageId, parts: MessagePart[]): Message {
      const message = deps.messages.getById(messageId);
      if (message === null) throw notFound("message", messageId);
      deps.messages.updateEdited(messageId, parts, partsToText(parts), deps.clock.nowIso());
      const updated = deps.messages.getById(messageId);
      if (updated === null) throw new DomainError("internal", "message disappeared after edit");
      return updated;
    },

    /**
     * 删除一个会话。**只删这一个会话**：
     * - 消息 / 上下文快照 / 摘要由外键级联删除；
     * - 记忆由调用方（API 层）按"会话作用域"清理，长期记忆不受影响；
     * - 角色、角色版本、账号、渠道游标、凭据一概不动（微信仍然保持登录）。
     */
    remove(conversationId: ConversationId): void {
      const conversation = requireConversation(conversationId);
      deps.conversations.delete(conversation.id);
      deps.logger.info("conversation deleted", {
        step: "conversation.delete",
        status: "completed",
        conversationId: conversation.id,
        channel: conversation.channel,
      });
      deps.events.publish({
        name: "conversation.updated",
        at: deps.clock.nowIso(),
        channel: conversation.channel,
        payload: { conversationId: conversation.id, deleted: true },
      });
    },

    deleteMessage(messageId: MessageId): void {
      const message = deps.messages.getById(messageId);
      if (message === null) throw notFound("message", messageId);
      deps.messages.delete(messageId);
    },

    /** 显式请求生成语音时用：读取一条消息（不存在就抛 not_found） */
    getMessage(messageId: MessageId): Message {
      const message = deps.messages.getById(messageId);
      if (message === null) throw notFound("message", messageId);
      return message;
    },

    setStatus(id: ConversationId, status: Conversation["status"]): Conversation {
      requireConversation(id);
      deps.conversations.setStatus(id, status);
      return requireConversation(id);
    },

    summaries(conversationId: ConversationId, limit = 10) {
      requireConversation(conversationId);
      return deps.summaries.list(conversationId, limit);
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;
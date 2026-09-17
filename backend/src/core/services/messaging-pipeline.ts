import type { InternalMessage, InternalResponse, MediaMessagePart, Message, MessagePart, OutboundPart } from "../model/message.ts";
import type { ChannelRegistry } from "../ports/channel-registry.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { UserId, CharacterId } from "../model/ids.ts";
import type { Conversation } from "../model/conversation.ts";
import type { MessageRepository, SettingsRepository } from "../ports/repositories.ts";
import type { Clock } from "../ports/clock.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { CharacterService } from "./character-service.ts";
import type { SummaryService } from "./summary-service.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import type { EmotionService } from "./emotion-service.ts";
import type { RelationshipService } from "./relationship-service.ts";
import type { CharacterStateService } from "./character-state-service.ts";
import type { RunRegistry } from "../ports/runs.ts";
import type { TranscriptionService } from "./transcription-service.ts";
import type { TtsService } from "./tts-service.ts";
import { sanitizeTtsState, type TtsState } from "../model/tts.ts";
import { randomToken } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";
import type { ActionIntentDetector } from "./action-intent.ts";
import { actionNote as actionNoteOf, type ActionResult, type AssistantActionService } from "./assistant-action-service.ts";
import type { ChatCharacterSwitch } from "./chat-character-switch.ts";

/** 源码里不写转义序列，避免生成不可打印字节 */
const NEWLINE = String.fromCharCode(10);

export interface MessagingPipelineDeps {
  users: { localUserId(): UserId };
  characters: CharacterService;
  conversations: ConversationService;
  summaries: SummaryService;
  memory: MemoryService;
  emotion: EmotionService;
  relationship: RelationshipService;
  characterState: CharacterStateService;
  channels: ChannelRegistry;
  settings: SettingsRepository;
  events: DomainEventPublisher;
  logger: Logger;
  runs: RunRegistry;
  /**
   * 语音转写（Phase 4.5-D3）。**可选**：没有配置 ASR 时整条管线行为与之前完全一致。
   * 转写在落库之前完成，因此模型上下文、记忆抽取看到的都是同一份 parts。
   */
  transcription?: TranscriptionService;
  /**
   * 语音合成（Phase 4.5-D4）。**可选**，且**永远不阻塞文字回复**：
   * 文字先落库、先发送，合成在后台进行；失败只影响"有没有语音"。
   */
  tts?: TtsService;
  /**
   * 「定时消息」意图识别与落库（都**可选**）：没有注入时聊天行为与之前完全一致。
   * 模型只产出结构化意图；真正的 job 创建由 scheduledMessages 负责，模型碰不到数据库。
   */
  actionIntent?: ActionIntentDetector;
  actions?: AssistantActionService;
  /**
   * 渠道聊天里换角色（可选）：注入后，「切换角色 名字」这类口令会被当成命令处理 ——
   * 换人 = 换会话，新会话的第一句话就是那个角色的开场白。
   * 不注入时一切照旧（Web 端有自己的会话列表，不靠口令切换）。
   */
  characterSwitch?: ChatCharacterSwitch;
  /** 定时确认需要把系统回执追加到角色回复上（消息写入仍走仓储端口） */
  messages: MessageRepository;
  clock: Clock;
}

/**
 * 角色消息 → 出站部件。
 * 出站复用同一套通用媒体模型：能否真的发出去由渠道能力决定，
 * 而不是在 Core 里把媒体悄悄换成一句占位文本。
 */
export function toOutboundParts(parts: MessagePart[]): OutboundPart[] {
  const out: OutboundPart[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      out.push({ kind: "text", text: part.text });
      continue;
    }
    if (part.kind === "quote") continue; // 引用是入站概念，不回传出站
    const caption = "caption" in part ? part.caption : undefined;
    out.push({
      kind: part.kind,
      media: part.media,
      ...(caption === undefined ? {} : { caption }),
    });
  }
  return out;
}

export interface HandleInboundOptions {
  /** streaming 模式下每个增量都会回调（用于 SSE） */
  onDelta?: (chunk: string) => void;
  /** 抽取模式：background 不阻塞响应；sync 供测试等待 */
  extraction?: "background" | "sync" | "off";
  signal?: AbortSignal;
}

/**
 * 入站消息的统一处理管线（渠道无关）。
 *
 * 顺序契约（报告 §十五）：用户消息先落库 → ContextEngine → LLM → assistant 落库 → 记忆抽取。
 * 绝不出现"模型已回复但库里没有"或"库里存了不存在的回复"。
 */
export function createMessagingPipeline(deps: MessagingPipelineDeps) {
  /**
   * 入站语音 → 转写。只补充 AudioPart.transcription：
   * - 音频部件本身（media 引用与状态）**原样保留**；
   * - 任何失败都只体现为 transcription.status = "failed"，绝不影响消息处理。
   */
  async function transcribeAudioParts(message: InternalMessage, signal?: AbortSignal): Promise<MessagePart[]> {
    const hasAudio = message.parts.some((part) => part.kind === "audio");
    if (!hasAudio || deps.transcription === undefined) return [...message.parts];
    try {
      const result = await deps.transcription.transcribeInboundMessage(message, signal === undefined ? {} : { signal });
      return result.parts;
    } catch (error) {
      deps.logger.warn("asr stage failed; continuing without transcription", { error: (error as Error).message });
      return [...message.parts];
    }
  }

  /**
   * 把助手回复的文字合成为语音（Phase 4.5-D4）。
   *
   * 顺序契约（与任务书 §4 一致）：
   *   文字回复落库 → 文字回复发送 → （后台）合成 → 音频入库 → 音频作为**第二条消息**发送
   * 失败时：文字回复依然成功，消息级 TTS 状态变成 failed（可观测），不产生任何音频消息。
   */
  async function runSpeech(input: {
    message: InternalMessage;
    conversation: Conversation;
    characterMessage: Message;
    userId: UserId;
  }): Promise<void> {
    const tts = deps.tts;
    if (tts === undefined) return;
    const settings = tts.readSettings();
    if (!settings.enabled || settings.delivery === "text") return;
    const text = input.characterMessage.textRender.trim();
    if (text.length === 0) return;

    const markState = (state: TtsState): void => {
      try {
        deps.conversations.setSpeechState(input.characterMessage.id, state);
        deps.events.publish({
          name: "conversation.updated",
          at: nowIso(),
          channel: input.message.channel,
          payload: { conversationId: input.conversation.id, messageId: input.characterMessage.id, tts: state.status },
        });
      } catch (error) {
        deps.logger.warn("tts state update failed", { error: (error as Error).message });
      }
    };

    markState(sanitizeTtsState({ status: "processing", updatedAt: nowIso() }));

    const result = await tts.synthesizeForText(text, { messageRef: input.characterMessage.id });
    const state = result.state;
    if (state.status !== "completed" || state.mediaId === null) {
      // 失败的合成不产生任何媒体消息，但状态必须可见（绝不是"静默无声"）
      markState(state);
      deps.logger.warn("tts did not produce audio", { errorCode: state.errorCode });
      return;
    }

    /**
     * 语音的最终投递方式：
     * - "voice"：原生语音（既有 D1/D2 出站链路，协议字段一个都不新增）
     * - "file"：音频文件（既有文件链路；人工选择，不是对客户端渲染失败的自动探测）
     */
    const media = {
      mediaId: state.mediaId,
      mimeType: state.mimeType,
      filename: null,
      sizeBytes: null,
      width: null,
      height: null,
      durationMs: state.durationMs,
      origin: "generated" as const,
      status: "available" as const,
      url: { kind: "internal" as const, value: "media:" + state.mediaId },
    };
    const part: MediaMessagePart =
      settings.delivery === "file"
        ? { kind: "file", media: { ...media, filename: "reply.wav" } }
        : { kind: "audio", media };

    try {
      deps.conversations.attachGeneratedSpeech(input.characterMessage.id, part, state);
    } catch (error) {
      deps.logger.warn("attaching generated speech failed", { error: (error as Error).message });
      return;
    }
    deps.events.publish({
      name: "conversation.updated",
      at: nowIso(),
      channel: input.message.channel,
      payload: { conversationId: input.conversation.id, messageId: input.characterMessage.id, tts: "completed" },
    });

    // 音频作为**独立的第二条出站消息**发送：文字消息已经送达，不会被回滚
    const adapter = deps.channels.get(input.message.channel);
    if (adapter === undefined) {
      deps.logger.warn("no channel adapter for generated speech", { channel: input.message.channel });
      return;
    }
    try {
      await adapter.send({
        channel: input.message.channel,
        accountId: input.message.accountId,
        conversationId: input.conversation.conversationId,
        parts: [part],
        replyToProviderMessageId: input.message.externalRef.providerMessageId,
        streaming: { mode: "none", runId: null },
        idempotencyKey: input.characterMessage.id + ":speech",
      });
    } catch (error) {
      deps.logger.warn("sending generated speech failed", { channel: input.message.channel, error: (error as Error).message });
    }
  }

  function scheduleSpeech(input: Parameters<typeof runSpeech>[0]): void {
    void runSpeech(input).catch((error: unknown) => {
      deps.logger.warn("tts stage failed; text reply is unaffected", { error: (error as Error).message });
    });
  }

  /**
   * 入站消息归哪个角色。顺序（每一步都记日志，绝不静默丢弃）：
   *   1) 渠道在 metadata 里明确指定的 characterId
   *   2) 设置里的 defaultCharacterId
   *   3) 兜底：用户的第一个角色 —— 只有一个角色时这就是唯一合理的答案
   * 三步都拿不到才返回 null（调用方会记 STEP FAILED 并丢弃）。
   */
  /**
   * 定时消息意图 → 应用服务。返回要给用户的确认语（null = 这轮不是定时请求）。
   *
   * 关键约束：
   * - 模型只给 when/message，**创建 job 永远走 ScheduledMessageService**（模型不碰数据库）；
   * - 渠道默认跟随当前会话（网页会话→网页，微信会话→微信），用户明确点名时才覆盖；
   * - 时间说不清就问清楚，绝不猜。
   */
  /**
   * 自然语言动作 → 后台对象。返回"这一轮要不要追加系统回执、回执是什么"。
   *
   * 铁律（与任务书 §四/§五/§八 一致）：
   * - 模型只给结构化意图（action-intent.ts），**所有写入都走 AssistantActionService**；
   * - 三类对象分开：事件 → events，任务 → work_tasks，定时消息 → scheduled_jobs；
   * - 只有真正写成功，才有成功回执；失败一律说实话；时间说不清就问，绝不猜。
   */
  async function planActions(input: {
    message: InternalMessage;
    conversation: Conversation;
    characterId: CharacterId;
    userId: UserId;
  }): Promise<{ actionNote: string | null; acted: boolean; actionAttempted: boolean }> {
    const detector = deps.actionIntent;
    const actions = deps.actions;
    if (detector === undefined || actions === undefined) return { actionNote: null, acted: false, actionAttempted: false };

    const text = userTextOf(input.message);
    if (text.length === 0 || !detector.looksActionable(text)) return { actionNote: null, acted: false, actionAttempted: false };

    const intent = await detector.detect(text);
    if (intent.intent === "none") return { actionNote: null, acted: false, actionAttempted: false };

    const where = { userId: input.userId, characterId: input.characterId, conversationId: input.conversation.id };
    const finish = (result: ActionResult): { actionNote: string; acted: boolean; actionAttempted: boolean } => ({
      actionNote: actionNoteOf(result, deps.clock.now()),
      acted: result.ok,
      actionAttempted: true,
    });

    switch (intent.intent) {
      case "needs_clarification":
        return {
          actionNote:
            "[系统动作结果] 状态=需要澄清：这一轮没能确定到底要安排什么事、或者什么时候。请用你自己的语气把话问回来（要记什么、什么时候），不要假装已经安排好了。",
          acted: false,
          actionAttempted: false,
        };
      case "schedule_message":
        return finish(actions.scheduleMessage({ ...where, intent }));
      case "create_event":
        return finish(actions.createEvent({ ...where, intent }));
      case "create_task":
        return finish(actions.createTask({ ...where, intent }));
      case "cancel":
        return finish(actions.cancel({ ...where, target: intent.target }));
      case "query":
        return finish(actions.query({ ...where, range: intent.range, target: intent.target }));
      default:
        return { actionNote: null, acted: false, actionAttempted: false };
    }
  }

  /**
   * 回复里是否在承诺"稍后/几分钟后发消息"。
   *
   * 只在"用户确实要求了定时、但这一轮没有创建任何任务"时才用它兜底：
   * 模型不能因为一句自然语言就让用户以为提醒已经建好了。
   */
  /** 回复里是否在声称"已经设置/记下/会提醒"（用于失败时纠错，不用于成功判断） */
  function looksLikeSuccessClaim(text: string): boolean {
    return /(已经|已|好|行|好的|好呀|好嘞).{0,10}(设置|记下|记住|记好|提醒|发你|告诉你|安排|会提醒)/.test(text);
  }

  /**
   * 回复里是否在承诺"到点会发消息 / 会提醒你"（用于"没建成却承诺"的兜底）。
   *
   * 真实事故：角色回了一句「好的，今天 12:00 我会提醒你：「去行政楼交材料」。」，
   * 而后台什么都没建。旧写法只认"几分钟后/稍后"这种**相对时间**，认不出**钟点**说法，于是假确认漏了出去。
   * 所以这里两种说法都要认：相对时间（几分钟后发你）+ 钟点（今天 12:00 / 中午 / 晚上八点提醒你）。
   */
  function looksLikeSchedulePromise(text: string): boolean {
    const relative = /(分钟|小时|秒|稍后|待会|待会儿|晚点|一会儿)[^。！？]{0,12}(发|提醒|告诉你|叫你|喊你|说)/.test(text);
    if (relative) return true;
    const clock = /(今天|明天|后天|今晚|明早|每天|中午|晚上|早上|下午|上午|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点)[^。！？]{0,16}(提醒|发消息|发你|发给你|告诉你|叫你|喊你|通知你|跟你说)/.test(text);
    if (clock) return true;
    /**
     * 连时间都没提、只承诺"会提醒你"的说法也算。
     * 注意**不能**把泛泛的"好的，我记住了"也算进来：那句话在普通闲聊里到处都是，
     * 认成承诺会往正常聊天里塞更正（回归测试抓到过）。
     */
    return /(会|到时会|到时候|回头|等下)[^。！？]{0,6}(提醒|发消息|发给你|告诉你|通知你|叫你|喊你)/.test(text);
  }

  function userTextOf(message: InternalMessage): string {
    return message.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
  }

  /**
   * 这一轮最终要落库的角色回复：
   * - 建任务成功 → 追加**系统回执**（只有成功才有回执）；
   * - 用户要求了定时但没建成，而模型又自己承诺了 → 追加诚实的更正，绝不留下假确认；
   * - 其它情况原样返回。
   */
  /**

   * 兜底：动作**失败**了，但模型却在回复里声称成功 → 追加一句事实更正。

   * 成功时不再追加任何固定模板：确认语由角色自己根据注入的 actionNote 写。

   */

  function correctFalseSuccess(message: Message, outcome: { actionNote: string | null; acted: boolean; actionAttempted: boolean }, userText: string): Message {
    if (outcome.actionAttempted) {
      if (outcome.acted) return message;
      if (!looksLikeSuccessClaim(message.textRender)) return message;
      deps.logger.warn("action failed but assistant claimed success; appending an honest correction", {
        step: "action.confirm",
        status: "failed",
        errorCategory: "false_success_claim",
      });
      return appendConfirmation(message, "（其实刚才那个没有设置成功，你可以再说一次。）");
    }
    // 没有动作，但用户要求了定时/安排、模型又自己承诺了 → 更正，绝不留下假确认
    const detector = deps.actionIntent;
    if (detector !== undefined && detector.looksActionable(userText) && looksLikeSchedulePromise(message.textRender)) {
      deps.logger.warn("assistant promised a future message but no job was created; appending an honest correction", {
        step: "action.confirm",
        status: "failed",
        errorCategory: "no_action_created",
      });
      return appendConfirmation(message, "（这条定时请求没有真正建立，你可以再说一次。）");
    }
    return message;
  }

  /** 把系统回执追加到角色回复后面（确定性文本，不依赖模型改写） */
  function appendConfirmation(message: Message, confirmation: string): Message {
    const body = message.textRender.trim();
    const text = body.length === 0 ? confirmation : body + NEWLINE + NEWLINE + confirmation;
    deps.messages.updateStreaming(message.id, {
      parts: [{ kind: "text", text }],
      textRender: text,
      status: message.status,
      errorText: message.errorText,
    });
    return deps.messages.getById(message.id) ?? message;
  }

  function resolveCharacterId(message: InternalMessage): CharacterId | null {
    const fromMetadata = message.metadata.characterId;
    if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
      deps.logger.info("inbound message character resolved", {
        step: "inbound.character",
        status: "completed",
        source: "metadata",
        channel: message.channel,
        characterId: fromMetadata,
      });
      return fromMetadata;
    }
    // 这个聊天自己选定过角色（用户在渠道里说过「切换角色 X」）→ 优先于全局默认
    const active = deps.characterSwitch?.readActive(message.channel, message.accountId, message.conversationId) ?? null;
    if (active !== null && deps.characters.get(active).record.id === active) {
      deps.logger.info("inbound message character resolved", {
        step: "inbound.character",
        status: "completed",
        source: "chat-active-character",
        channel: message.channel,
        characterId: active,
      });
      return active;
    }
    const configured = deps.settings.get<string | null>("defaultCharacterId", null);
    if (typeof configured === "string" && configured.length > 0) {
      deps.logger.info("inbound message character resolved", {
        step: "inbound.character",
        status: "completed",
        source: "defaultCharacterId",
        channel: message.channel,
        characterId: configured,
      });
      return configured;
    }
    // 兜底：没有任何显式配置时用用户的第一个角色。
    // 以前这里直接返回 null，于是"没配 defaultCharacterId"的机器上微信消息会被整条丢掉。
    const fallback = deps.characters.list(deps.users.localUserId())[0] ?? null;
    if (fallback !== null) {
      deps.logger.info("inbound message character resolved", {
        step: "inbound.character",
        status: "completed",
        source: "first-character-fallback",
        channel: message.channel,
        characterId: fallback.id,
      });
      return fallback.id;
    }
    return null;
  }

  function resolveConversation(message: InternalMessage, characterId: CharacterId): Conversation {
    const userId = deps.users.localUserId();
    const existing = deps.conversations
      .list(userId, 500)
      .find((c) => c.channel === message.channel && c.conversationId === message.conversationId && c.characterId === characterId);
    if (existing) return existing;
    return deps.conversations.ensureConversation({
      userId,
      characterId,
      channel: message.channel,
      accountId: message.accountId,
      conversationRef: message.conversationId,
    });
  }

  /**
   * 回复之后的反应阶段（背景执行，失败不影响会话）：
   * 1) 运行时状态：记录一次互动
   * 2) 情绪：确定性信号优先，必要时才用廉价模型
   * 3) 关系：按互动质量产生微小变化（服务内部有单次上限）
   */
  async function runReactions(input: {
    userId: UserId;
    characterId: CharacterId;
    conversation: Conversation;
    userMessage: Message;
    characterMessage: Message | null;
  }): Promise<void> {
    deps.characterState.touchInteraction(input.characterId);
    const analysis = await deps.emotion.analyze(input.characterId, {
      text: input.userMessage.textRender,
      conversationId: input.conversation.id,
      sourceMessageId: input.userMessage.id,
      userId: input.userId,
    });
    if (analysis.change !== null) {
      deps.emotion.applyChange(input.characterId, analysis.change, { userId: input.userId });
    }

    const emotion = deps.emotion.get(input.characterId);
    const changes: import("../model/relationship.ts").RelationshipChange[] = [
      { dimension: "familiarity", delta: 0.01, reason: "又一次交谈", source: "conversation", sourceMessageId: input.userMessage.id },
    ];
    if (emotion.valence > 0.3) {
      changes.push({ dimension: "affection" as const, delta: 0.02, reason: "这次聊天让角色感到愉快", source: "conversation" as const, sourceMessageId: input.userMessage.id });
    } else if (emotion.valence < -0.3) {
      changes.push({ dimension: "affection" as const, delta: -0.02, reason: "这次聊天让角色不太舒服", source: "conversation" as const, sourceMessageId: input.userMessage.id });
    }
    if (analysis.change?.primary === "grateful" || analysis.change?.primary === "happy") {
      changes.push({ dimension: "trust" as const, delta: 0.01, reason: "正向互动", source: "conversation" as const, sourceMessageId: input.userMessage.id });
    }
    deps.relationship.applyChange(input.userId, input.characterId, changes);
  }

  /** 抽取是"回复之后"的独立阶段：失败只记日志，绝不影响会话。 */
  async function runExtraction(input: {
    userId: UserId;
    characterId: CharacterId;
    conversation: Conversation;
    userMessage: Message;
    characterMessage: Message | null;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    const characterView = deps.characters.get(input.characterId);
    const user = deps.users.localUserId();
    const history = deps.conversations.messages(input.conversation.id, { limit: 500 });
    const userMessages = history.filter((m) => m.role === "user");
    const previousUserMessage = [...userMessages].reverse().find((m) => m.id !== input.userMessage.id) ?? null;
    const gate = deps.memory.gate({
      conversationId: input.conversation.id,
      userText: input.userText,
      userMessageCount: userMessages.length,
      lastUserMessageAt: previousUserMessage?.createdAt ?? null,
    });
    if (!gate.run) {
      deps.logger.debug("memory extraction skipped", { reason: gate.reason });
      return;
    }
    await deps.memory.extract({
      userId: user,
      characterId: input.characterId,
      conversationId: input.conversation.id,
      userMessageId: input.userMessage.id,
      assistantMessageId: input.characterMessage?.id ?? null,
      userText: input.userText,
      assistantText: input.assistantText,
      characterName: characterView.definition.name,
      userName: "用户",
    });
  }

  function scheduleExtraction(input: Parameters<typeof runExtraction>[0], mode: HandleInboundOptions["extraction"]): void {
    if (mode === "off") return;
    const task = (async () => {
      await runReactions({
        userId: input.userId,
        characterId: input.characterId,
        conversation: input.conversation,
        userMessage: input.userMessage,
        characterMessage: input.characterMessage,
      }).catch((error: unknown) => {
        deps.logger.warn("post-reply reactions failed", { error: (error as Error).message });
      });
      await runExtraction(input);
    })().catch((error: unknown) => {
      deps.logger.warn("memory extraction failed", { error: (error as Error).message });
    });
    if (mode === "sync") return void task;
    void task;
  }

  function buildResponse(input: {
    message: InternalMessage;
    conversation: Conversation;
    characterMessage: Message;
  }): InternalResponse {
    return {
      channel: input.message.channel,
      accountId: input.message.accountId,
      conversationId: input.conversation.conversationId,
      parts: toOutboundParts(input.characterMessage.parts),
      replyToProviderMessageId: input.message.externalRef.providerMessageId,
      streaming: { mode: "none", runId: null },
      idempotencyKey: randomToken(12),
    };
  }

  async function deliver(message: InternalMessage, response: InternalResponse): Promise<void> {
    const adapter = deps.channels.get(message.channel);
    if (adapter === undefined) {
      deps.logger.warn("no channel adapter registered for outbound response", { channel: message.channel });
      return;
    }
    try {
      await adapter.send(response);
    } catch (error) {
      deps.logger.error("channel send failed", { channel: message.channel, error: (error as Error).message });
    }
  }

  return {
    /** 非流式：一次性生成完整回复（其它渠道与测试使用）。 */
    async handleInbound(message: InternalMessage, options: HandleInboundOptions = {}): Promise<InternalResponse | null> {
      const startedAt = Date.now();
      const trace = { step: "inbound.received", status: "completed", channel: message.channel, accountId: message.accountId, conversationRef: message.conversationId, parts: message.parts.length };
      deps.logger.info("inbound message received", trace);
      const userId = deps.users.localUserId();

      /**
       * 渠道里的换角色口令：「切换角色 Kai」「换成 Aria」「角色列表」。
       * 在找角色之前处理 —— 切换之后的会话与角色都可能变，后面的流程按新的来。
       * 换到新角色 = 新会话，会话创建时写入的开场白就是这次要发出去的话。
       */
      if (deps.characterSwitch !== undefined) {
        const command = await deps.characterSwitch.handle({
          userId,
          channel: message.channel,
          accountId: message.accountId,
          conversationRef: message.conversationId,
          text: userTextOf(message),
        });
        if (command !== null) {
          const switched: InternalResponse = {
            channel: message.channel,
            accountId: message.accountId,
            conversationId: command.conversationRef,
            parts: [{ kind: "text", text: command.text }],
            replyToProviderMessageId: message.externalRef.providerMessageId,
            streaming: { mode: "none", runId: null },
            idempotencyKey: "switch:" + message.id,
          };
          await deliver(message, switched);
          deps.logger.info("chat character command handled", {
            step: "chat.character.command",
            status: "completed",
            channel: message.channel,
            characterId: command.characterId,
            newConversation: command.newConversation,
            durationMs: Date.now() - startedAt,
          });
          return switched;
        }
      }

      const characterId = resolveCharacterId(message);
      if (characterId === null) {
        deps.logger.warn("STEP FAILED: inbound message dropped", {
          step: "inbound.character",
          status: "failed",
          errorCategory: "no_character",
          channel: message.channel,
          conversationRef: message.conversationId,
        });
        return null;
      }

      const conversation = resolveConversation(message, characterId);
      deps.logger.info("inbound conversation resolved", {
        step: "inbound.conversation",
        status: "completed",
        channel: message.channel,
        conversationId: conversation.id,
        characterId,
      });
      // 定时消息意图：在生成回复之前处理，这样确认语能跟着这轮回复一起落库
      const action = await planActions({ message, conversation, characterId, userId });
      // 语音先转写（可选阶段）再落库：这样 textRender / 上下文 / 记忆看到的是同一份内容
      const parts: MessagePart[] = await transcribeAudioParts(message, options.signal);
      const userMessage = deps.conversations.appendUserMessage(conversation.id, parts, message.externalRef.providerMessageId);
      deps.logger.info("inbound user message persisted", {
        step: "inbound.persist_user",
        status: "completed",
        conversationId: conversation.id,
        messageId: userMessage.id,
      });
      const replyMessage = await deps.conversations.reply(conversation.id, userId, userMessage, { actionNote: action.actionNote });
      const characterMessage = correctFalseSuccess(replyMessage, action, userTextOf(message));
      deps.logger.info("inbound reply generated", {
        step: "inbound.generate",
        status: characterMessage.status === "completed" ? "completed" : "failed",
        conversationId: conversation.id,
        messageId: characterMessage.id,
        chars: characterMessage.textRender.length,
        durationMs: Date.now() - startedAt,
        ...(characterMessage.status === "completed" ? {} : { errorCategory: "empty_or_failed_generation" }),
      });

      scheduleExtraction(
        {
          userId,
          characterId,
          conversation,
          userMessage,
          characterMessage,
          userText: userMessage.textRender,
          assistantText: characterMessage.textRender,
        },
        // 动作轮次（事件/任务/提醒/查询）不是"值得长期记住的事实"，这几轮不做记忆抽取
        action.actionNote === null ? (options.extraction ?? "background") : "off",
      );

      const response = buildResponse({ message, conversation, characterMessage });
      await deliver(message, response);
      deps.logger.info("inbound reply delivered to channel", {
        step: "inbound.deliver",
        status: "completed",
        channel: message.channel,
        conversationId: conversation.id,
        durationMs: Date.now() - startedAt,
      });
      deps.events.publish({
        name: "conversation.updated",
        at: nowIso(),
        channel: message.channel,
        payload: { conversationId: conversation.id },
      });
      // 文字回复已经落库并送达；语音合成为可选的第二步（失败不影响文字）
      scheduleSpeech({ message, conversation, characterMessage, userId });
      return response;
    },

    /**
     * 流式：立即返回落库 id，增量通过领域事件流出。
     * 一个 run 对应一个 AbortController，可按 runId 取消（客户端断开时使用）。
     */
    async handleInboundStreaming(
      message: InternalMessage,
      options: HandleInboundOptions = {},
    ): Promise<{ conversationId: string; userMessageId: string; runId: string } | null> {
      const userId = deps.users.localUserId();
      const characterId = resolveCharacterId(message);
      if (characterId === null) {
        deps.logger.warn("inbound message dropped: no streaming character bound", { channel: message.channel });
        return null;
      }
      const conversation = resolveConversation(message, characterId);
      const action = await planActions({ message, conversation, characterId, userId });
      const transcribedParts = await transcribeAudioParts(message, options.signal);
      const userMessage = deps.conversations.appendUserMessage(conversation.id, transcribedParts, message.externalRef.providerMessageId);

      const controller = new AbortController();
      const runId = `run:${randomToken(8)}`;
      deps.runs.register(runId, controller);
      if (options.signal !== undefined) {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      void (async () => {
        try {
          const replyMessage = await deps.conversations.streamReply(conversation.id, userId, userMessage, {
            actionNote: action.actionNote,
            signal: controller.signal,
            onDelta: (chunk) => {
              deps.events.publish({
                name: "message.delta",
                at: nowIso(),
                channel: message.channel,
                payload: { conversationId: conversation.id, messageId: userMessage.id, delta: chunk, runId },
              });
              options.onDelta?.(chunk);
            },
          });
          const characterMessage = correctFalseSuccess(replyMessage, action, userTextOf(message));
          if (action.actionNote !== null) {
            // 流式增量已经发出去了，这里把最终定稿再推一次，保证界面上的这条回复包含最新文本
            deps.events.publish({
              name: "message.delta",
              at: nowIso(),
              channel: message.channel,
              payload: { conversationId: conversation.id, messageId: characterMessage.id, runId, complete: true },
            });
          }
          scheduleExtraction(
            {
              userId,
              characterId,
              conversation,
              userMessage,
              characterMessage,
              userText: userMessage.textRender,
              assistantText: characterMessage.textRender,
            },
            action.actionNote === null ? (options.extraction ?? "background") : "off",
          );
          scheduleSpeech({ message, conversation, characterMessage, userId });
          if (deps.settings.get<boolean>("summary.auto", true)) {
            await deps.summaries.summarize(conversation.id).catch((error: unknown) => {
              deps.logger.warn("auto summary failed", { error: (error as Error).message });
            });
          }
        } catch (error) {
          deps.events.publish({
            name: "message.delta",
            at: nowIso(),
            channel: message.channel,
            payload: { conversationId: conversation.id, runId, error: (error as Error).message, complete: true },
          });
        } finally {
          deps.runs.finish(runId);
        }
      })();

      return { conversationId: conversation.id, userMessageId: userMessage.id, runId };
    },
  };
}

export type MessagingPipeline = ReturnType<typeof createMessagingPipeline>;

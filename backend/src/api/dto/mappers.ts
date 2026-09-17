import type { CharacterRecord, CharacterRuntimeState, CharacterDefinition } from "../../core/model/character.ts";
import type { Conversation } from "../../core/model/conversation.ts";
import type { Message } from "../../core/model/message.ts";
import type { Memory } from "../../core/model/memory.ts";
import type { ContextSnapshotRecord } from "../../core/model/context.ts";
import type { ProviderConfig } from "../../core/model/usage.ts";

export interface CharacterDto {
  id: string;
  name: string;
  slug: string;
  avatarMediaId: string | null;
  createdAt: string;
  updatedAt: string;
  definition: CharacterDefinition;
  state: CharacterRuntimeState;
  /** 这个角色一共有多少个定义版本（编辑会新增版本，不覆盖历史） */
  versionCount: number;
}

export function toCharacterDto(input: {
  record: CharacterRecord;
  definition: CharacterDefinition;
  state: CharacterRuntimeState;
  versionCount?: number;
}): CharacterDto {
  return {
    id: input.record.id,
    name: input.record.name,
    slug: input.record.slug,
    avatarMediaId: input.record.avatarMediaId,
    createdAt: input.record.createdAt,
    updatedAt: input.record.updatedAt,
    definition: input.definition,
    state: input.state,
    versionCount: input.versionCount ?? 1,
  };
}

export function toConversationDto(
  conversation: Conversation,
  /** 列表页额外需要的信息（最后一条消息预览、这个聊天当前在跟谁聊）；不传就是纯会话数据 */
  extra: { lastMessageText?: string | null; activeCharacterId?: string | null } = {},
): Record<string, unknown> {
  return {
    id: conversation.id,
    characterId: conversation.characterId,
    /** 会话来源 = 渠道 kind（web / 其它渠道）：写在会话本身上，不靠"最后一条消息从哪来"推断 */
    source: conversation.channel,
    lastMessageText: extra.lastMessageText ?? null,
    /** 渠道聊天里"现在在跟谁聊"：只有渠道侧选过角色时才有值 */
    activeCharacterId: extra.activeCharacterId ?? null,
    // Phase 5：会话冻结的角色版本（改卡不影响旧会话）
    characterVersionId: conversation.characterVersionId ?? null,
    channel: conversation.channel,
    accountId: conversation.accountId,
    conversationRef: conversation.conversationId,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
  };
}

export function toMessageDto(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    parts: message.parts,
    text: message.textRender,
    replyToId: message.replyToId,
    branchOfId: message.branchOfId,
    status: message.status,
    errorText: message.errorText,
    source: message.source,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    // Phase 4.5-D4：语音合成状态（没有语音时字段缺席，前端据此不显示任何语音 UI）
    ...(message.tts === undefined ? {} : { tts: message.tts }),
  };
}

export function toMemoryDto(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    scope: memory.scope,
    type: memory.type,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    tags: memory.tags,
    characterId: memory.characterId,
    conversationId: memory.conversationId,
    sourceMessageId: memory.sourceMessageId,
    reinforcement: memory.reinforcement,
    accessCount: memory.accessCount,
    lastAccessedAt: memory.lastAccessedAt,
    status: memory.status,
    occurredAt: memory.occurredAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function toSnapshotDto(snapshot: ContextSnapshotRecord): Record<string, unknown> {
  return {
    id: snapshot.id,
    conversationId: snapshot.conversationId,
    characterId: snapshot.characterId,
    messageId: snapshot.messageId,
    taskType: snapshot.taskType,
    providerId: snapshot.providerId,
    model: snapshot.model,
    totalTokens: snapshot.totalTokens,
    budgetTokens: snapshot.budgetTokens,
    sections: snapshot.sections,
    memoryIds: snapshot.memoryIds,
    dropped: snapshot.dropped,
    source: snapshot.source,
    triggerReason: snapshot.triggerReason,
    createdAt: snapshot.createdAt,
  };
}

/** Provider 出参：**永不包含密钥**，只告诉前端"是否已配置凭据"。 */
export function toProviderDto(config: ProviderConfig, hasCredential: boolean): Record<string, unknown> {
  return {
    id: config.id,
    kind: config.kind,
    displayName: config.displayName,
    baseUrl: config.baseUrl,
    defaultModel: config.defaultModel,
    requiresCredential: config.requiresCredential,
    hasCredential,
    timeoutMs: config.timeoutMs,
    enabled: config.enabled,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}
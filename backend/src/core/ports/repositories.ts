import type { User } from "../model/user.ts";
import type {
  CharacterDefinition,
  CharacterRecord,
  CharacterRuntimeState,
  CharacterVersion,
} from "../model/character.ts";
import type { Conversation } from "../model/conversation.ts";
import type { Message, MessagePart } from "../model/message.ts";
import type { ChannelAccountInfo, ChannelKind } from "../model/channel.ts";
import type { CharacterId, CharacterVersionId, ConversationId, MessageId, UserId } from "../model/ids.ts";

/**
 * 持久化端口：Core 只依赖这些接口，SQLite 只是其中一种实现。
 * 这样 Core 不 import 任何 storage/channels/providers 的实现文件。
 */

export interface UserRepository {
  ensureLocalUser(): User;
  getById(id: UserId): User | null;
}

export interface CharacterRepository {
  insertCharacter(record: CharacterRecord): void;
  insertVersion(version: CharacterVersion): void;
  getById(id: CharacterId): CharacterRecord | null;
  findBySlug(userId: UserId, slug: string): CharacterRecord | null;
  listByUser(userId: UserId): CharacterRecord[];
  updateCurrentVersion(id: CharacterId, versionId: CharacterVersionId, name: string, at: string): void;
  /** 换头像：只写 mediaId 引用，二进制永远在 MediaStorage */
  updateAvatar(id: CharacterId, mediaId: string | null, at: string): void;
  delete(id: CharacterId): void;

  getVersion(id: CharacterVersionId): CharacterVersion | null;
  listVersions(characterId: CharacterId): CharacterVersion[];

  upsertState(state: CharacterRuntimeState): void;
  getState(characterId: CharacterId): CharacterRuntimeState | null;
}

export interface ConversationRepository {
  insert(conversation: Conversation): void;
  getById(id: ConversationId): Conversation | null;
  findByIdentity(channel: ChannelKind, conversationRef: string, characterId: CharacterId): Conversation | null;
  listByUser(userId: UserId, limit: number): Conversation[];
  touchLastMessage(id: ConversationId, at: string): void;
  setStatus(id: ConversationId, status: Conversation["status"]): void;
  delete(id: ConversationId): void;
}

export interface MessageRepository {
  insert(message: Message): void;
  getById(id: MessageId): Message | null;
  listByConversation(conversationId: ConversationId, options?: { limit?: number; before?: string }): Message[];
  /**
   * 按「渠道给的消息 id」找已经落库的那条（同一条外部消息只该存在一条）。
   * 渠道在失败后会重投同一批消息，靠它做幂等。
   */
  findByProviderMessageId(conversationId: ConversationId, providerMessageId: string): Message | null;
  countByConversation(conversationId: ConversationId): number;
  countByRole(conversationId: ConversationId, role: Message["role"]): number;
  countBySourceSince(conversationId: ConversationId, source: Message["source"], sinceIso: string): number;
  lastMessageAt(conversationId: ConversationId, role?: Message["role"]): string | null;
  /** 最后一条消息本身（渠道重投时判断"这句是不是已经回过了"） */
  lastMessage(conversationId: ConversationId): Message | null;
  /** 会话列表用：最后一条消息的纯文本（没有消息时 null） */
  lastMessageText(conversationId: ConversationId): string | null;
  updateEdited(id: MessageId, parts: MessagePart[], textRender: string, at: string): void;
  /** 流式过程中的就地更新：同一个 message 行反复改写，而不是插入多条。 */
  updateStreaming(
    id: MessageId,
    input: { parts: MessagePart[]; textRender: string; status: Message["status"]; errorText: string | null; tokenCount?: number | null },
  ): void;
  /** 写入消息级 TTS 状态（Phase 4.5-D4）；null 表示清除 */
  setTts(id: MessageId, tts: import("../model/tts.ts").TtsState | null): void;
  /**
   * Phase 4.5-E：把"卡在 processing"的消息级 TTS 状态收敛成 failed(interrupted)。
   * 崩溃/重启后没有后台任务会回来收尾，否则前端会永远显示"语音生成中…"。
   */
  recoverStaleTts(cutoffIso: string, nowIso: string): number;
  delete(id: MessageId): void;
}

export interface ChannelRepository {
  ensureChannel(kind: ChannelKind, enabled: boolean): void;
  setEnabled(kind: ChannelKind, enabled: boolean): void;
  listEnabled(): ChannelKind[];

  upsertAccount(account: ChannelAccountInfo & { boundUserId: string | null }): void;
  listAccounts(kind?: ChannelKind): ChannelAccountInfo[];
  getAccount(id: string): ChannelAccountInfo | null;
  setAccountStatus(id: string, status: ChannelAccountInfo["status"]): void;
  deleteAccount(id: string): void;
}

export interface SettingsRepository {
  get<T>(key: string, fallback: T): T;
  put(key: string, value: unknown, at: string): void;
  all(): Record<string, unknown>;
  delete(key: string): void;
}

export interface AuditEntry {
  id: string;
  actor: "system" | "user" | "character";
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntry, "id" | "createdAt"> & { createdAt?: string }): AuditEntry;
  list(limit: number): AuditEntry[];
}

export type { CharacterDefinition };
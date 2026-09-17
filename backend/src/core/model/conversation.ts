import type { AccountId, CharacterId, ConversationId, UserId } from "./ids.ts";
import type { ChannelKind } from "./channel.ts";

export type ConversationStatus = "active" | "archived";

export interface Conversation {
  id: ConversationId;
  userId: UserId;
  characterId: CharacterId;
  /**
   * Phase 5 §20：会话创建时**冻结**的角色版本。
   * 之后编辑角色卡只会产生新版本，旧会话继续用它开始时的那一版，
   * 因此"改卡"不会静默改变已有对话里角色的行为。
   */
  characterVersionId?: string | null;
  channel: ChannelKind;
  accountId: AccountId | null;
  conversationId: string;
  title: string;
  parentConversationId: ConversationId | null;
  status: ConversationStatus;
  createdAt: string;
  lastMessageAt: string | null;
}

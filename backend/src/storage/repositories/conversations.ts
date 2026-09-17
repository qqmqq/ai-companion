import type { Database } from "../db.ts";
import type { Conversation } from "../../core/model/conversation.ts";
import type { ChannelKind } from "../../core/model/channel.ts";
import type { ConversationRepository } from "../../core/ports/repositories.ts";

const COLUMNS =
  "id, user_id, character_id, channel, account_id, conversation_ref, title, parent_conversation_id, status, created_at, last_message_at, character_version_id";

function map(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: String(row.character_id),
    // Phase 5：老行没有这一列（NULL）→ 退回"角色当前版本"由上层决定
    characterVersionId: row.character_version_id === null || row.character_version_id === undefined ? null : String(row.character_version_id),
    channel: String(row.channel) as ChannelKind,
    accountId: row.account_id === null ? null : String(row.account_id),
    conversationId: String(row.conversation_ref),
    title: String(row.title),
    parentConversationId: row.parent_conversation_id === null ? null : String(row.parent_conversation_id),
    status: String(row.status) as Conversation["status"],
    createdAt: String(row.created_at),
    lastMessageAt: row.last_message_at === null ? null : String(row.last_message_at),
  };
}

export function createConversationRepository(db: Database): ConversationRepository {
  const insertStmt = db.raw.prepare(
    `INSERT INTO conversations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectById = db.raw.prepare(`SELECT ${COLUMNS} FROM conversations WHERE id = ?`);
  const selectIdentity = db.raw.prepare(
    `SELECT ${COLUMNS} FROM conversations WHERE channel = ? AND conversation_ref = ? AND character_id = ?`,
  );
  const listStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM conversations WHERE user_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`,
  );
  const touchStmt = db.raw.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?");
  const statusStmt = db.raw.prepare("UPDATE conversations SET status = ? WHERE id = ?");
  const deleteStmt = db.raw.prepare("DELETE FROM conversations WHERE id = ?");

  return {
    insert: (c) => {
      insertStmt.run(
        c.id,
        c.userId,
        c.characterId,
        c.channel,
        c.accountId,
        c.conversationId,
        c.title,
        c.parentConversationId,
        c.status,
        c.createdAt,
        c.lastMessageAt,
        c.characterVersionId ?? null,
      );
    },
    getById: (id) => {
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    findByIdentity: (channel, conversationRef, characterId) => {
      const row = selectIdentity.get(channel, conversationRef, characterId) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    listByUser: (userId, limit) => (listStmt.all(userId, limit) as Array<Record<string, unknown>>).map(map),
    touchLastMessage: (id, at) => {
      touchStmt.run(at, id);
    },
    setStatus: (id, status) => {
      statusStmt.run(status, id);
    },
    delete: (id) => {
      deleteStmt.run(id);
    },
  };
}

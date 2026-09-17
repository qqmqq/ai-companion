import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import { normalizeMessageParts, type Message, type MessagePart, type MessageRole, type MessageSource, type MessageStatus } from "../../core/model/message.ts";
import { sanitizeTtsState } from "../../core/model/tts.ts";
import type { MessageRepository } from "../../core/ports/repositories.ts";

const COLUMNS =
  "id, conversation_id, role, content_json, text_render, reply_to_id, provider_message_id, token_count, status, error_text, source, created_at, edited_at, branch_of_id";

function map(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as MessageRole,
    // 兼容策略：老行可能是"扁平媒体片段"或只有文本；统一在读取边界规范化，Core 只见到新模型
    parts: normalizeMessageParts(parseJson<unknown>(String(row.content_json), [])).parts,
    textRender: String(row.text_render),
    replyToId: row.reply_to_id === null ? null : String(row.reply_to_id),
    providerMessageId: row.provider_message_id === null ? null : String(row.provider_message_id),
    tokenCount: row.token_count === null ? null : Number(row.token_count),
    status: String(row.status ?? "completed") as MessageStatus,
    source: String(row.source ?? "conversation") as MessageSource,
    errorText: row.error_text === null || row.error_text === undefined ? null : String(row.error_text),
    createdAt: String(row.created_at),
    editedAt: row.edited_at === null ? null : String(row.edited_at),
    branchOfId: row.branch_of_id === null ? null : String(row.branch_of_id),
    // TTS 状态：读取边界同样净化（长度/控制字符/completed 之外不带 mediaId）
    ...(row.tts_json === null || row.tts_json === undefined
      ? {}
      : { tts: sanitizeTtsState(parseJson<Record<string, unknown>>(String(row.tts_json), {})) }),
  };
}

export function createMessageRepository(db: Database): MessageRepository {
  /**
   * Phase 4.5-E：插入时**也要**写 tts_json。
   * 之前 insert 只写 COLUMNS（不含 tts_json），于是"带 tts 状态插入一条消息"会被静默丢弃，
   * 只有随后的 setTts 才真正落库 —— 这是仓库边界的真实数据丢失点（对任何直接调用 insert 的路径都成立）。
   */
  const insertStmt = db.raw.prepare(
    `INSERT INTO messages (${COLUMNS}, tts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 读取时额外带上 Phase 4.5-D4 的 tts_json
  const SELECT_COLUMNS = COLUMNS + ", tts_json";
  const selectById = db.raw.prepare(`SELECT ${SELECT_COLUMNS} FROM messages WHERE id = ?`);
  const listStmt = db.raw.prepare(
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  );
  const listBeforeStmt = db.raw.prepare(
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  );
  const countStmt = db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?");
  const updateStmt = db.raw.prepare(
    "UPDATE messages SET content_json = ?, text_render = ?, edited_at = ? WHERE id = ?",
  );
  const updateTtsStmt = db.raw.prepare("UPDATE messages SET tts_json = ? WHERE id = ?");
  // 注意：LIKE 模式里不能带反斜杠转义（SQLite 默认没有转义字符），否则永远匹配不到
  const staleTtsStmt = db.raw.prepare(
    "UPDATE messages SET tts_json = ? WHERE tts_json IS NOT NULL AND tts_json LIKE '%" + '"status":"processing"' + "%' AND created_at < ?",
  );
  const deleteStmt = db.raw.prepare("DELETE FROM messages WHERE id = ?");
  const countByRoleStmt = db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = ?");
  const countBySourceStmt = db.raw.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND source = ? AND created_at >= ?",
  );
  const lastMessageAtStmt = db.raw.prepare(
    "SELECT created_at FROM messages WHERE conversation_id = ? AND (? IS NULL OR role = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1",
  );
  const lastMessageTextStmt = db.raw.prepare(
    "SELECT text_render FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  );
  const updateStreamingStmt = db.raw.prepare(
    "UPDATE messages SET content_json = ?, text_render = ?, status = ?, error_text = ?, token_count = COALESCE(?, token_count) WHERE id = ?",
  );

  return {
    recoverStaleTts: (cutoffIso, nowIso) => {
      const result = staleTtsStmt.run(
        JSON.stringify(
          sanitizeTtsState({
            status: "failed",
            errorCode: "interrupted",
            errorMessage: "进程在语音合成完成前中断（重启后收敛为可重试的失败态）",
            updatedAt: nowIso,
          }),
        ),
        cutoffIso,
      );
      return Number(result.changes ?? 0);
    },

    setTts: (id, tts) => {
      updateTtsStmt.run(tts === null || tts === undefined ? null : JSON.stringify(sanitizeTtsState(tts)), id);
    },

    insert: (m) => {
      const normalized = normalizeMessageParts(m.parts).parts;
      insertStmt.run(
        m.id,
        m.conversationId,
        m.role,
        JSON.stringify(normalized),
        m.textRender,
        m.replyToId,
        m.providerMessageId,
        m.tokenCount,
        m.status,
        m.errorText,
        m.source,
        m.createdAt,
        m.editedAt,
        m.branchOfId,
        m.tts === undefined || m.tts === null ? null : JSON.stringify(sanitizeTtsState(m.tts)),
      );
    },
    getById: (id) => {
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    listByConversation: (conversationId, options = {}) => {
      const limit = options.limit ?? 200;
      const rows = (
        options.before
          ? listBeforeStmt.all(conversationId, options.before, limit)
          : listStmt.all(conversationId, limit)
      ) as Array<Record<string, unknown>>;
      return rows.map(map);
    },
    countByRole: (conversationId, role) => Number((countByRoleStmt.get(conversationId, role) as { n: number }).n),
    countBySourceSince: (conversationId, source, sinceIso) =>
      Number((countBySourceStmt.get(conversationId, source, sinceIso) as { n: number }).n),
    lastMessageAt: (conversationId, role) => {
      const row = lastMessageAtStmt.get(conversationId, role ?? null, role ?? null) as { created_at: string } | undefined;
      return row === undefined ? null : row.created_at;
    },
    lastMessageText: (conversationId) => {
      const row = lastMessageTextStmt.get(conversationId) as { text_render: string } | undefined;
      return row === undefined ? null : row.text_render;
    },
    updateStreaming: (id, input) => {
      updateStreamingStmt.run(
        JSON.stringify(input.parts),
        input.textRender,
        input.status,
        input.errorText,
        input.tokenCount ?? null,
        id,
      );
    },
    countByConversation: (conversationId) => {
      const row = countStmt.get(conversationId) as { n: number };
      return Number(row.n);
    },
    updateEdited: (id, parts, textRender, at) => {
      updateStmt.run(JSON.stringify(parts), textRender, at, id);
    },
    delete: (id) => {
      deleteStmt.run(id);
    },
  };
}
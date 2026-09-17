import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import type {
  Memory,
  MemoryLink,
  MemoryQuery,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "../../core/model/memory.ts";
import type { MemoryRepository } from "../../core/ports/repositories.phase2.ts";
import type { CharacterId, UserId } from "../../core/model/ids.ts";
import { buildFtsQuery, segmentText } from "../search/cjk.ts";

const COLUMNS =
  "id, scope, type, content, content_hash, importance, confidence, user_id, character_id, conversation_id, source_message_id, tags_json, reinforcement, access_count, last_accessed_at, embedding_json, superseded_by, status, occurred_at, created_at, updated_at";

function map(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    type: String(row.type) as MemoryType,
    content: String(row.content),
    contentHash: String(row.content_hash),
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    userId: row.user_id === null ? null : String(row.user_id),
    characterId: row.character_id === null ? null : String(row.character_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
    tags: parseJson<string[]>(String(row.tags_json), []),
    reinforcement: Number(row.reinforcement),
    accessCount: Number(row.access_count),
    lastAccessedAt: row.last_accessed_at === null ? null : String(row.last_accessed_at),
    embedding: parseJson<number[] | null>(String(row.embedding_json ?? "null"), null),
    supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
    status: String(row.status) as MemoryStatus,
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createMemoryRepository(db: Database): MemoryRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO memories (${COLUMNS}) VALUES (${COLUMNS.split(", ").map(() => "?").join(", ")})`);
  const updateStmt = db.raw.prepare(
    `UPDATE memories SET content = ?, content_hash = ?, importance = ?, confidence = ?, tags_json = ?, reinforcement = ?, access_count = ?, last_accessed_at = ?, embedding_json = ?, superseded_by = ?, status = ?, occurred_at = ?, updated_at = ? WHERE id = ?`,
  );
  const getStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`);
  const findByHashStmt = db.raw.prepare(
    `SELECT ${COLUMNS} FROM memories WHERE scope = ? AND content_hash = ? AND IFNULL(character_id,'') = ? AND IFNULL(user_id,'') = ? LIMIT 1`,
  );
  const deleteStmt = db.raw.prepare("DELETE FROM memories WHERE id = ?");
  const setStatusStmt = db.raw.prepare("UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?");
  const touchStmt = db.raw.prepare(
    "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
  );
  const countStmt = db.raw.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE (? IS NULL OR character_id = ?) AND (? IS NULL OR status = ?)",
  );

  // FTS 维护：独立 FTS 表 + 手动同步（中文逐字切分后入库）
  const ftsInsert = db.raw.prepare("INSERT INTO memories_fts (search_text, memory_id) VALUES (?, ?)");
  const ftsDelete = db.raw.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
  const linkInsert = db.raw.prepare(
    "INSERT INTO memory_links (id, from_memory_id, relation, target_type, target_id, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const linkList = db.raw.prepare(
    "SELECT id, from_memory_id, relation, target_type, target_id, weight, created_at FROM memory_links WHERE from_memory_id = ?",
  );
  const linkDelete = db.raw.prepare("DELETE FROM memory_links WHERE from_memory_id = ?");
  // 会话删除时的链接清理：目标就是该会话、目标是它的消息、或来自"属于该会话的记忆"
  const linkForgetConversation = db.raw.prepare(
    `DELETE FROM memory_links WHERE (target_type = 'conversation' AND target_id = ?)
       OR (target_type = 'message' AND target_id IN (SELECT id FROM messages WHERE conversation_id = ?))
       OR (from_memory_id IN (SELECT id FROM memories WHERE scope = 'conversation' AND conversation_id = ?))`,
  );
  const scopedMemoryIds = db.raw.prepare("SELECT id FROM memories WHERE scope = 'conversation' AND conversation_id = ?");
  const scopedDelete = db.raw.prepare("DELETE FROM memories WHERE scope = 'conversation' AND conversation_id = ?");
  const detachConversation = db.raw.prepare("UPDATE memories SET conversation_id = NULL WHERE conversation_id = ?");

  const buildFilters = (filter: {
    userId?: UserId | null;
    characterId?: CharacterId | null;
    conversationId?: string | null;
    scope?: MemoryScope;
    type?: MemoryType;
    status?: MemoryStatus;
  }): { where: string[]; params: Array<string | number | null> } => {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.characterId !== undefined && filter.characterId !== null) {
      where.push("character_id = ?");
      params.push(filter.characterId);
    }
    if (filter.userId !== undefined && filter.userId !== null) {
      where.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.conversationId !== undefined && filter.conversationId !== null) {
      where.push("conversation_id = ?");
      params.push(filter.conversationId);
    }
    if (filter.scope !== undefined) {
      where.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.type !== undefined) {
      where.push("type = ?");
      params.push(filter.type);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    return { where, params };
  };

  return {
    insert: (memory) => {
      insertStmt.run(
        memory.id,
        memory.scope,
        memory.type,
        memory.content,
        memory.contentHash,
        memory.importance,
        memory.confidence,
        memory.userId,
        memory.characterId,
        memory.conversationId,
        memory.sourceMessageId,
        JSON.stringify(memory.tags),
        memory.reinforcement,
        memory.accessCount,
        memory.lastAccessedAt,
        memory.embedding === null ? null : JSON.stringify(memory.embedding),
        memory.supersededBy,
        memory.status,
        memory.occurredAt,
        memory.createdAt,
        memory.updatedAt,
      );
      ftsInsert.run(segmentText(`${memory.content} ${memory.tags.join(" ")}`), memory.id);
    },
    getById: (id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    findByHash: ({ scope, contentHash, characterId, userId }) => {
      const row = findByHashStmt.get(scope, contentHash, characterId ?? "", userId ?? "") as
        | Record<string, unknown>
        | undefined;
      return row ? map(row) : null;
    },
    update: (memory) => {
      updateStmt.run(
        memory.content,
        memory.contentHash,
        memory.importance,
        memory.confidence,
        JSON.stringify(memory.tags),
        memory.reinforcement,
        memory.accessCount,
        memory.lastAccessedAt,
        memory.embedding === null ? null : JSON.stringify(memory.embedding),
        memory.supersededBy,
        memory.status,
        memory.occurredAt,
        memory.updatedAt,
        memory.id,
      );
      ftsDelete.run(memory.id);
      ftsInsert.run(segmentText(`${memory.content} ${memory.tags.join(" ")}`), memory.id);
    },
    touchAccess: (ids, at) => {
      for (const id of ids) touchStmt.run(at, id);
    },
    delete: (id) => {
      ftsDelete.run(id);
      linkDelete.run(id);
      deleteStmt.run(id);
    },
    setStatus: (id, status, supersededBy = null) => {
      setStatusStmt.run(status, supersededBy, new Date().toISOString(), id);
    },
    list: (filter) => {
      const { where, params } = buildFilters(filter);
      const sql = `SELECT ${COLUMNS} FROM memories ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`;
      const rows = db.raw.prepare(sql).all(...params, filter.limit, filter.offset ?? 0) as Array<Record<string, unknown>>;
      return rows.map(map);
    },
    count: (filter = {}) => {
      const row = countStmt.get(
        filter.characterId ?? null,
        filter.characterId ?? null,
        filter.status ?? null,
        filter.status ?? null,
      ) as { n: number };
      return Number(row.n);
    },
    searchByText: (query: MemoryQuery) => {
      const fts = buildFtsQuery(query.text);
      if (fts === null) return [];
      const { where, params } = buildFilters({
        userId: query.userId ?? null,
        characterId: query.characterId ?? null,
        ...(query.scopes === undefined ? {} : { scope: query.scopes[0] }),
      });
      const scopeClause =
        query.scopes === undefined || query.scopes.length === 0
          ? []
          : [`m.scope IN (${query.scopes.map(() => "?").join(", ")})`];
      const sql = [
        `SELECT ${COLUMNS.split(", ").map((c) => `m.${c}`).join(", ")}, bm25(memories_fts) AS fts_score`,
        "FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id",
        "WHERE memories_fts MATCH ?",
        ...where.map((clause) => `AND m.${clause}`),
        ...scopeClause.map((clause) => `AND ${clause}`),
        "AND m.status = 'active'",
        "ORDER BY bm25(memories_fts) LIMIT ?",
      ].join(" ");
      const allParams: Array<string | number | null> = [
        fts,
        ...params,
        ...(query.scopes ?? []),
        query.limit,
      ];
      try {
        const rows = db.raw.prepare(sql).all(...allParams) as Array<Record<string, unknown>>;
        return rows.map((row) => ({ memory: map(row), ftsScore: Number(row.fts_score ?? 0) }));
      } catch {
        // FTS 语法异常时退化为 LIKE，保证检索不因查询串崩溃
        const like = `%${query.text.trim()}%`;
        const likeSql = [
          `SELECT ${COLUMNS}, 0 AS fts_score FROM memories m`,
          "WHERE m.status = 'active' AND m.content LIKE ?",
          ...where.map((clause) => `AND m.${clause}`),
          "ORDER BY m.importance DESC LIMIT ?",
        ].join(" ");
        const rows = db.raw.prepare(likeSql).all(like, ...params, query.limit) as Array<Record<string, unknown>>;
        return rows.map((row) => ({ memory: map(row), ftsScore: 0 }));
      }
    },
    protectedMemories: ({ userId, characterId, limit }) => {
      const sql = [
        `SELECT ${COLUMNS} FROM memories`,
        "WHERE status = 'active' AND type IN ('identity','promise')",
        "AND (IFNULL(character_id,'') = ? OR character_id IS NULL)",
        "AND (IFNULL(user_id,'') = ? OR user_id IS NULL)",
        "ORDER BY importance DESC, updated_at DESC LIMIT ?",
      ].join(" ");
      const rows = db.raw.prepare(sql).all(characterId ?? "", userId ?? "", limit) as Array<Record<string, unknown>>;
      return rows.map(map);
    },
    insertLink: (link: MemoryLink) => {
      linkInsert.run(link.id, link.fromMemoryId, link.relation, link.targetType, link.targetId, link.weight, link.createdAt);
    },
    listLinks: (fromMemoryId) =>
      (linkList.all(fromMemoryId) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        fromMemoryId: String(row.from_memory_id),
        relation: String(row.relation) as MemoryLink["relation"],
        targetType: String(row.target_type) as MemoryLink["targetType"],
        targetId: String(row.target_id),
        weight: Number(row.weight),
        createdAt: String(row.created_at),
      })),
    deleteLinks: (fromMemoryId) => {
      linkDelete.run(fromMemoryId);
    },
    /**
     * 只清理"属于这个会话"的记忆数据，绝不碰长期记忆：
     * 1) 指向该会话 / 它的消息 / 即将被删的会话作用域记忆的链接；
     * 2) scope = "conversation" 的记忆（它们本来就属于这个会话）——FTS 行要手动删；
     * 3) 其余记忆只把 conversation_id 置空（user/character 级记忆必须活下来）。
     */
    forgetConversation: (conversationId) => {
      linkForgetConversation.run(conversationId, conversationId, conversationId);
      const scoped = scopedMemoryIds.all(conversationId) as Array<Record<string, unknown>>;
      for (const row of scoped) ftsDelete.run(String(row.id));
      const deleted = scopedDelete.run(conversationId);
      const detached = detachConversation.run(conversationId);
      return { deletedMemories: Number(deleted.changes), detachedMemories: Number(detached.changes) };
    },
  };
}

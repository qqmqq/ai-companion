import type { SqlDatabase } from "../../../core/ports/channel-module.ts";

export interface CursorState {
  committed: string;
  pending: string | null;
}

/**
 * 两阶段游标持久化。
 *
 * 关键不变量：只有 batch 内所有该处理的消息都处理完之后才 commit。
 * 如果进程在处理过程中崩溃，pending 仍留在库里——重启后能看出"这一批没跑完"，
 * 而不是像参考实现那样先把游标推进、随后消息永久丢失。
 */
export interface CursorStore {
  load(accountId: string): CursorState;
  savePending(accountId: string, cursor: string): void;
  commit(accountId: string, cursor: string): void;
  /** 崩溃恢复：返回未提交的 pending（有则说明上一批没跑完） */
  pending(accountId: string): string | null;
  reset(accountId: string): void;
}

export function createCursorStore(deps: { db: SqlDatabase; clockNow: () => string; accountScope?: string }): CursorStore {
  const scope = deps.accountScope ?? "poll";
  const selectStmt = deps.db.prepare(
    "SELECT cursor, pending_cursor FROM channel_cursors WHERE account_id = ? AND conversation_ref = ?",
  );
  const upsertPendingStmt = deps.db.prepare(
    `INSERT INTO channel_cursors (account_id, conversation_ref, cursor, pending_cursor, committed_at)
     VALUES (?, ?, '', ?, NULL)
     ON CONFLICT(account_id, conversation_ref) DO UPDATE SET pending_cursor = excluded.pending_cursor`,
  );
  const commitStmt = deps.db.prepare(
    `INSERT INTO channel_cursors (account_id, conversation_ref, cursor, pending_cursor, committed_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(account_id, conversation_ref) DO UPDATE SET cursor = excluded.cursor, pending_cursor = NULL, committed_at = excluded.committed_at`,
  );
  const deleteStmt = deps.db.prepare("DELETE FROM channel_cursors WHERE account_id = ? AND conversation_ref = ?");

  return {
    load(accountId) {
      const row = selectStmt.get(accountId, scope) as { cursor: string; pending_cursor: string | null } | undefined;
      if (row === undefined) return { committed: "", pending: null };
      return { committed: row.cursor ?? "", pending: row.pending_cursor ?? null };
    },
    savePending(accountId, cursor) {
      if (cursor.length === 0) return;
      upsertPendingStmt.run(accountId, scope, cursor);
    },
    commit(accountId, cursor) {
      commitStmt.run(accountId, scope, cursor, deps.clockNow());
    },
    pending(accountId) {
      const row = selectStmt.get(accountId, scope) as { pending_cursor: string | null } | undefined;
      return row?.pending_cursor ?? null;
    },
    reset(accountId) {
      deleteStmt.run(accountId, scope);
    },
  };
}
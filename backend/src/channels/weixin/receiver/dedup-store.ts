import type { SqlDatabase } from "../../../core/ports/channel-module.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import type { Logger } from "../../../core/ports/logger.ts";

/**
 * 消息幂等表。
 * 微信会因为重试/重连/游标恢复而重复投递同一条消息，因此必须以协议消息 ID 去重。
 * ID 是 uint64，一律以字符串存取。
 */
export interface DedupStore {
  /** 首次见到返回 true（应当处理）；重复返回 false（应跳过） */
  claim(accountId: string, messageId: string): boolean;
  /** 处理失败时释放，允许下次重试时重新处理 */
  release(accountId: string, messageId: string): void;
  has(accountId: string, messageId: string): boolean;
  count(accountId: string): number;
  prune(olderThanIso: string): number;
}

export function createDedupStore(deps: { db: SqlDatabase; clock: Clock; logger: Logger; channel: string }): DedupStore {
  const insertStmt = deps.db.prepare(
    "INSERT OR IGNORE INTO channel_message_ids (channel, account_id, message_id, seen_at) VALUES (?, ?, ?, ?)",
  );
  const deleteStmt = deps.db.prepare(
    "DELETE FROM channel_message_ids WHERE channel = ? AND account_id = ? AND message_id = ?",
  );
  const hasStmt = deps.db.prepare(
    "SELECT 1 AS present FROM channel_message_ids WHERE channel = ? AND account_id = ? AND message_id = ?",
  );
  const countStmt = deps.db.prepare(
    "SELECT COUNT(*) AS n FROM channel_message_ids WHERE channel = ? AND account_id = ?",
  );
  const pruneStmt = deps.db.prepare("DELETE FROM channel_message_ids WHERE seen_at < ?");

  return {
    claim(accountId, messageId) {
      const result = insertStmt.run(deps.channel, accountId, messageId, deps.clock.nowIso());
      const changed = Number(result.changes ?? 0);
      if (changed === 0) {
        deps.logger.debug("duplicate message skipped", { accountId });
        return false;
      }
      return true;
    },
    release(accountId, messageId) {
      deleteStmt.run(deps.channel, accountId, messageId);
    },
    has(accountId, messageId) {
      return hasStmt.get(deps.channel, accountId, messageId) !== undefined;
    },
    count(accountId) {
      return Number((countStmt.get(deps.channel, accountId) as { n: number }).n);
    },
    prune(olderThanIso) {
      const result = pruneStmt.run(olderThanIso);
      return Number(result.changes ?? 0);
    },
  };
}
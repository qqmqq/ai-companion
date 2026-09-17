import type { Database } from "../db.ts";
import type { ChannelAccountInfo, ChannelKind } from "../../core/model/channel.ts";
import type { ChannelRepository } from "../../core/ports/repositories.ts";

const ACCOUNT_COLUMNS =
  "id, channel_kind, external_account_id, display_name, status, created_at";

function mapAccount(row: Record<string, unknown>): ChannelAccountInfo {
  return {
    id: String(row.id),
    channel: String(row.channel_kind) as ChannelKind,
    externalAccountId: String(row.external_account_id),
    displayName: String(row.display_name),
    status: String(row.status) as ChannelAccountInfo["status"],
    createdAt: String(row.created_at),
  };
}

export function createChannelRepository(db: Database): ChannelRepository {
  const upsertChannel = db.raw.prepare(
    `INSERT INTO channels (kind, enabled, config_json) VALUES (?, ?, '{}')
     ON CONFLICT(kind) DO UPDATE SET enabled = excluded.enabled`,
  );
  const listEnabled = db.raw.prepare("SELECT kind FROM channels WHERE enabled = 1 ORDER BY kind");
  const upsertAccountStmt = db.raw.prepare(
    `INSERT INTO channel_accounts (id, channel_kind, external_account_id, display_name, status, bound_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_kind, external_account_id) DO UPDATE SET display_name = excluded.display_name, status = excluded.status`,
  );
  const listAccountsStmt = db.raw.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM channel_accounts ORDER BY created_at`);
  const listAccountsByKindStmt = db.raw.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM channel_accounts WHERE channel_kind = ? ORDER BY created_at`,
  );
  const getAccountStmt = db.raw.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM channel_accounts WHERE id = ?`);
  const setStatusStmt = db.raw.prepare("UPDATE channel_accounts SET status = ? WHERE id = ?");
  const deleteStmt = db.raw.prepare("DELETE FROM channel_accounts WHERE id = ?");

  return {
    ensureChannel: (kind, enabled) => {
      upsertChannel.run(kind, enabled ? 1 : 0);
    },
    setEnabled: (kind, enabled) => {
      upsertChannel.run(kind, enabled ? 1 : 0);
    },
    listEnabled: () =>
      (listEnabled.all() as Array<{ kind: string }>).map((row) => row.kind as ChannelKind),
    upsertAccount: (account) => {
      upsertAccountStmt.run(
        account.id,
        account.channel,
        account.externalAccountId,
        account.displayName,
        account.status,
        account.boundUserId,
        account.createdAt,
      );
    },
    listAccounts: (kind) => {
      const rows = (kind ? listAccountsByKindStmt.all(kind) : listAccountsStmt.all()) as Array<Record<string, unknown>>;
      return rows.map(mapAccount);
    },
    getAccount: (id) => {
      const row = getAccountStmt.get(id) as Record<string, unknown> | undefined;
      return row ? mapAccount(row) : null;
    },
    setAccountStatus: (id, status) => {
      setStatusStmt.run(status, id);
    },
    deleteAccount: (id) => {
      deleteStmt.run(id);
    },
  };
}

import type { Database } from "../db.ts";
import type { User } from "../../core/model/user.ts";
import type { UserId } from "../../core/model/ids.ts";
import type { UserRepository } from "../../core/ports/repositories.ts";
import { uuidv7 } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";

export function createUserRepository(db: Database): UserRepository {
  const selectById = db.raw.prepare("SELECT id, display_name, locale, timezone, created_at FROM users WHERE id = ?");
  const selectFirst = db.raw.prepare("SELECT id, display_name, locale, timezone, created_at FROM users ORDER BY created_at LIMIT 1");
  const insert = db.raw.prepare(
    "INSERT INTO users (id, display_name, locale, timezone, created_at) VALUES (?, ?, ?, ?, ?)",
  );

  const map = (row: Record<string, unknown>): User => ({
    id: String(row.id),
    displayName: String(row.display_name),
    locale: String(row.locale),
    timezone: String(row.timezone),
    createdAt: String(row.created_at),
  });

  return {
    ensureLocalUser(): User {
      const existing = selectFirst.get() as Record<string, unknown> | undefined;
      if (existing) return map(existing);
      const user: User = {
        id: uuidv7(),
        displayName: "本机用户",
        locale: "zh-CN",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        createdAt: nowIso(),
      };
      insert.run(user.id, user.displayName, user.locale, user.timezone, user.createdAt);
      return user;
    },
    getById(id: UserId): User | null {
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
  };
}

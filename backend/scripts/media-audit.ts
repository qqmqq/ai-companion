/**
 * 媒体引用一致性审计（Phase 4.5-E）。
 *
 * 只**报告**数据库引用与 MediaStorage 之间的一致性，不删除任何东西：
 *   - missing：数据库引用了但存储里没有
 *   - orphaned：存储里有但没有任何引用（失败/取消的残留，或删除消息后的残留）
 *   - unreadable：sidecar 与字节不一致（含 checksum 校验失败）
 *
 * 用法：node scripts/media-audit.ts [dataDir]
 *   dataDir 缺省用 COMPANION_DATA_DIR 配置（与后端启动一致）。
 */
import { loadConfig } from "../src/app/config.ts";
import { openDatabase } from "../src/storage/db.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { createLogger } from "../src/app/logger.ts";
import { createLocalMediaStorage } from "../src/storage/media/local-media-storage.ts";
import { auditMediaReferences } from "../src/app/media-audit.ts";
import { systemClock } from "../src/core/ports/clock.ts";

const config = loadConfig(process.argv[2] === undefined ? {} : { COMPANION_DATA_DIR: process.argv[2]! });
const logger = createLogger({ level: config.logLevel });
const db = openDatabase({ path: config.databasePath });
try {
  runMigrations(db);
  const storage = createLocalMediaStorage({ dataDir: config.dataDir, logger, clock: systemClock() });
  const result = await auditMediaReferences({ db, mediaStorage: storage, dataDir: config.dataDir, logger });
  process.stdout.write("MEDIA AUDIT\n");
  process.stdout.write("  referenced: " + String(result.referenced) + "\n");
  process.stdout.write("  storedTotal: " + String(result.storedTotal) + "\n");
  process.stdout.write("  missing: " + String(result.missing.length) + "\n");
  process.stdout.write("  orphaned: " + String(result.orphaned.length) + "\n");
  process.stdout.write("  unreadable: " + String(result.unreadable.length) + "\n");
  process.stdout.write("（只报告，不删除任何文件）\n");
} finally {
  db.close();
}

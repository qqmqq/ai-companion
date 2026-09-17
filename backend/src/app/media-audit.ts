import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../storage/db.ts";
import { parseJson } from "../storage/db.ts";
import { normalizeMessageParts } from "../core/model/message.ts";
import type { MediaStorage } from "../core/ports/media-storage.ts";
import type { Logger } from "../core/ports/logger.ts";

/**
 * 媒体引用一致性审计（Phase 4.5-E）。
 *
 * 它回答三个问题：
 * 1. **missing**：数据库引用了某个 mediaId，但 MediaStorage 里没有对应对象；
 * 2. **orphaned**：MediaStorage 里有对象，但没有任何数据库引用指向它；
 * 3. **unreadable**：sidecar 存在但字节缺失/超过上限（读不出来）。
 *
 * 刻意的边界：
 * - **只报告，不删除**。自动删除需要判断"这个媒体将来还会不会被用到"，那需要一套
 *   引用计数与生命周期策略（相当于垃圾回收器）；本阶段明确不做，避免误删用户数据。
 * - 扫描是 O(消息数 + 媒体数) 的一次性动作，只在显式调用（脚本/冒烟/测试）时执行，
 *   不挂在请求路径上。
 */

export interface MediaAuditResult {
  /** 被数据库引用的 mediaId（消息部件 + 转写记录 + 合成记录） */
  referenced: number;
  /** 数据库引用了但存储里找不到（严重：上层会把它当"媒体不存在"处理） */
  missing: string[];
  /** 存储里有但没有任何数据库引用（可能是一次失败/取消留下，或删除消息后的残留） */
  orphaned: string[];
  /** sidecar 与字节不一致/读不出来 */
  unreadable: string[];
  /** 存储里的媒体对象总数 */
  storedTotal: number;
}

interface AuditDeps {
  db: Database;
  mediaStorage: MediaStorage;
  dataDir: string;
  logger?: Logger;
}

/** 从一条消息的 parts 里收集 mediaId（走既有的规范化边界，不直接相信 JSON） */
function mediaIdsFromParts(contentJson: string): string[] {
  const parts = normalizeMessageParts(parseJson<unknown>(contentJson, [])).parts;
  const ids: string[] = [];
  for (const part of parts) {
    if (part.kind === "text" || part.kind === "quote") continue;
    const mediaId = (part as { media?: { mediaId?: string | null } }).media?.mediaId ?? null;
    if (typeof mediaId === "string" && mediaId.length > 0) ids.push(mediaId);
  }
  return ids;
}

/** 列出存储目录里所有 mediaId（目录结构：<dataDir>/media/<前两位>/<id>.bin） */
function listStoredMediaIds(dataDir: string): string[] {
  const root = join(dataDir, "media");
  const ids: string[] = [];
  let shards: string[];
  try {
    shards = readdirSync(root);
  } catch {
    return ids;
  }
  for (const shard of shards) {
    const shardPath = join(root, shard);
    let files: string[];
    try {
      if (!statSync(shardPath).isDirectory()) continue;
      files = readdirSync(shardPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".bin")) continue;
      ids.push(file.slice(0, -4));
    }
  }
  return ids;
}

export async function auditMediaReferences(deps: AuditDeps): Promise<MediaAuditResult> {
  const referenced = new Set<string>();

  const messages = deps.db.raw.prepare("SELECT content_json FROM messages").all() as Array<{ content_json: string }>;
  for (const row of messages) {
    for (const id of mediaIdsFromParts(String(row.content_json))) referenced.add(id);
  }
  const transcriptions = deps.db.raw.prepare("SELECT media_id FROM transcriptions WHERE media_id IS NOT NULL").all() as Array<{ media_id: string }>;
  for (const row of transcriptions) referenced.add(String(row.media_id));
  const syntheses = deps.db.raw.prepare("SELECT media_id FROM tts_syntheses WHERE media_id IS NOT NULL").all() as Array<{ media_id: string }>;
  for (const row of syntheses) referenced.add(String(row.media_id));

  const stored = listStoredMediaIds(deps.dataDir);
  const storedSet = new Set(stored);

  const missing: string[] = [];
  for (const id of referenced) {
    if (!storedSet.has(id)) missing.push(id);
  }
  const orphaned = stored.filter((id) => !referenced.has(id));

  const unreadable: string[] = [];
  for (const id of stored) {
    const asset = await deps.mediaStorage.get(id);
    if (asset === null) unreadable.push(id);
  }

  const result: MediaAuditResult = {
    referenced: referenced.size,
    missing,
    orphaned,
    unreadable,
    storedTotal: stored.length,
  };
  deps.logger?.info("media reference audit", {
    referenced: result.referenced,
    storedTotal: result.storedTotal,
    missing: result.missing.length,
    orphaned: result.orphaned.length,
    unreadable: result.unreadable.length,
  });
  return result;
}

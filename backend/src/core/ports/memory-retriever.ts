import type { MemoryHit, MemoryQuery } from "../model/memory.ts";

/**
 * 记忆检索端口。
 * Phase 2 唯一实现是 FTS5（关键词 + 重要性 + 时间衰减）。
 * 未来可加 VectorMemoryRetriever / HybridMemoryRetriever，Core 不需要改动。
 */
export interface MemoryRetriever {
  readonly id: string;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
}

import type { MemoryHit, MemoryQuery } from "../../core/model/memory.ts";
import type { MemoryRetriever } from "../../core/ports/memory-retriever.ts";
import type { MemoryRepository } from "../../core/ports/repositories.phase2.ts";
import { DEFAULT_SCORE_WEIGHTS, normalizeFtsRank, scoreMemory, type MemoryScoreWeights } from "../../core/memory/scoring.ts";

export interface FtsMemoryRetrieverDeps {
  memories: MemoryRepository;
  weights?: MemoryScoreWeights;
  now?: () => number;
}

/**
 * Phase 2 默认检索器：FTS5 关键词命中 + 重要性 + 时间衰减 + 强化。
 * 向量检索留到后续：实现同一个 MemoryRetriever 接口即可替换。
 */
export function createFtsMemoryRetriever(deps: FtsMemoryRetrieverDeps): MemoryRetriever {
  const weights = deps.weights ?? DEFAULT_SCORE_WEIGHTS;
  const now = deps.now ?? (() => Date.now());

  return {
    id: "fts5",
    async search(query: MemoryQuery): Promise<MemoryHit[]> {
      // searchByText 已按 bm25 从优到劣返回，这里按名次折算相关度分量。
      const candidates = deps.memories.searchByText(query);
      const nowMs = now();
      const scored = candidates.map(({ memory }, index) => {
        const { score, components } = scoreMemory(
          { memory, ftsRank: normalizeFtsRank(index, candidates.length), nowMs },
          weights,
        );
        return { memory, score, components };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, query.limit);
    },
  };
}

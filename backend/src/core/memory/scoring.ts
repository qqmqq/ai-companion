import type { Memory } from "../model/memory.ts";

/** 记忆评分权重：策略属于 Core，机制（FTS5 查询）属于基础设施。 */
export interface MemoryScoreWeights {
  fts: number;
  importance: number;
  recency: number;
  reinforcement: number;
}

export const DEFAULT_SCORE_WEIGHTS: MemoryScoreWeights = {
  fts: 0.45,
  importance: 0.3,
  recency: 0.2,
  reinforcement: 0.05,
};

/** 报告 §8.4：不同重要度对应不同半衰期；identity / promise 不衰减。 */
export function halfLifeDays(memory: Pick<Memory, "type" | "importance">): number | null {
  if (memory.type === "identity" || memory.type === "promise") return null;
  if (memory.importance >= 0.8) return 90;
  return 7;
}

export function recencyScore(memory: Pick<Memory, "type" | "importance" | "occurredAt">, nowMs: number): number {
  const halfLife = halfLifeDays(memory);
  if (halfLife === null) return 1;
  const ageMs = Math.max(0, nowMs - Date.parse(memory.occurredAt));
  const ageDays = ageMs / 86_400_000;
  return Math.exp((-ageDays * Math.LN2) / halfLife);
}

/**
 * 关键词相关度归一化到 0..1。
 *
 * 必须按名次归一化，不能直接用 bm25 数值：bm25 的量级随语料规模与文档长度变化
 * （小语料里常见 1e-6 量级），用 x/(x+1) 之类的公式会把关键词命中直接抹平。
 * 检索器已按 bm25 排序，这里只把名次映射成分数。
 */
export function normalizeFtsRank(index: number, total: number): number {
  if (total <= 1) return 1;
  if (index < 0) return 1;
  if (index >= total) return 0;
  return 1 - index / (total - 1);
}

export interface ScoreComponents {
  fts: number;
  importance: number;
  recency: number;
  reinforcement: number;
}

export function scoreMemory(
  input: { memory: Memory; ftsRank: number; nowMs: number },
  weights: MemoryScoreWeights = DEFAULT_SCORE_WEIGHTS,
): { score: number; components: ScoreComponents } {
  const components: ScoreComponents = {
    fts: Math.min(1, Math.max(0, input.ftsRank)),
    importance: Math.min(1, Math.max(0, input.memory.importance)),
    recency: recencyScore(input.memory, input.nowMs),
    reinforcement: Math.min(1, Math.max(0, (input.memory.reinforcement - 1) / 2)),
  };
  const score =
    components.fts * weights.fts +
    components.importance * weights.importance +
    components.recency * weights.recency +
    components.reinforcement * weights.reinforcement;
  return { score, components };
}

/**
 * 简易启发式重要性：用于没有模型时也能给出合理初值，
 * 以及在抽取结果缺少 importance 时兜底。真正的判断由 memory_extraction 模型给出。
 */
export function heuristicImportance(content: string, type: string): number {
  const text = content.trim();
  if (type === "identity" || type === "promise") return 0.95;
  const strong = /(生日|纪念日|答应|承诺|约定|记住|重要|永远|第一次|梦想|害怕|过敏|生病|禁忌)/u;
  const medium = /(喜欢|讨厌|习惯|经常|每天|工作|学校|家人|朋友|梦想)/u;
  if (strong.test(text)) return 0.85;
  if (medium.test(text)) return 0.6;
  if (text.length <= 8) return 0.2;
  return 0.35;
}

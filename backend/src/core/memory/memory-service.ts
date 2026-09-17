import type {
  Memory,
  MemoryCandidate,
  MemoryHit,
  MemoryLinkRelation,
  MemoryQuery,
  MemoryScope,
  MemoryStatus,
} from "../model/memory.ts";
import type { MemoryRepository } from "../ports/repositories.phase2.ts";
import type { SettingsRepository } from "../ports/repositories.ts";
import type { MemoryRetriever } from "../ports/memory-retriever.ts";
import type { TaskLLM } from "../ports/task-llm.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import type { CharacterId, ConversationId, MessageId, UserId } from "../model/ids.ts";
import { uuidv7 } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";
import { buildExtractionMessages, looksWorthExtracting, parseCandidates } from "./extractor.ts";
import { DEFAULT_SCORE_WEIGHTS, halfLifeDays, heuristicImportance, recencyScore, scoreMemory } from "./scoring.ts";

export interface MemoryServiceDeps {
  memories: MemoryRepository;
  retriever: MemoryRetriever;
  taskLLM: TaskLLM;
  settings: SettingsRepository;
  logger: Logger;
  clock: Clock;
  now?: () => number;
}

export interface ExtractionGateInput {
  conversationId: ConversationId;
  userText: string;
  userMessageCount: number;
  lastUserMessageAt: string | null;
}

export interface ExtractionGateResult {
  run: boolean;
  reason: string;
}

export interface ExtractInput {
  userId: UserId;
  characterId: CharacterId;
  conversationId: ConversationId;
  userMessageId: MessageId;
  assistantMessageId: MessageId | null;
  userText: string;
  assistantText: string;
  characterName: string;
  userName: string;
  signal?: AbortSignal;
}

export function createMemoryService(deps: MemoryServiceDeps) {
  const now = deps.now ?? (() => deps.clock.now().getTime());

  function setting<T>(key: string, fallback: T): T {
    return deps.settings.get<T>(key, fallback);
  }

  /**
   * 成本控制闸门：不是每条消息都抽取。
   * 顺序：总开关 → 长度/寒暄预筛 → 每 N 条用户消息一次 → 最小间隔。
   */
  function gate(input: ExtractionGateInput): ExtractionGateResult {
    if (setting<boolean>("memory.extraction.enabled", true) === false) {
      return { run: false, reason: "disabled" };
    }
    const minChars = setting<number>("memory.extraction.minUserChars", 6);
    if (!looksWorthExtracting(input.userText, minChars)) {
      return { run: false, reason: "prefilter" };
    }
    const everyN = Math.max(1, setting<number>("memory.extraction.everyNUserMessages", 2));
    if (input.userMessageCount % everyN !== 0) {
      return { run: false, reason: `everyN:${everyN}` };
    }
    const minIntervalMs = Math.max(0, setting<number>("memory.extraction.minIntervalMs", 0));
    if (minIntervalMs > 0 && input.lastUserMessageAt !== null) {
      const elapsed = now() - Date.parse(input.lastUserMessageAt);
      if (elapsed < minIntervalMs) return { run: false, reason: "minInterval" };
    }
    return { run: true, reason: "ok" };
  }

  function promote(input: {
    userId: UserId;
    characterId: CharacterId;
    conversationId: ConversationId;
    userMessageId: MessageId;
    assistantMessageId: MessageId | null;
    candidate: MemoryCandidate;
  }): Memory {
    const at = deps.clock.nowIso();
    const memories = deps.memories;
    const existing = memories.findByHash({
      scope: input.candidate.scope,
      contentHash: memoryHash(input.candidate.content),
      characterId: input.characterId,
      userId: input.userId,
    });

    if (existing !== null) {
      // 合并：强化 + 提升重要度，而不是插入重复记忆
      const merged: Memory = {
        ...existing,
        importance: Math.max(existing.importance, input.candidate.importance),
        confidence: Math.max(existing.confidence, input.candidate.confidence),
        reinforcement: Math.min(3, existing.reinforcement + 0.3),
        tags: [...new Set([...existing.tags, ...input.candidate.tags])].slice(0, 8),
        sourceMessageId: input.userMessageId,
        updatedAt: at,
      };
      memories.update(merged);
      memories.insertLink({
        id: uuidv7(),
        fromMemoryId: merged.id,
        relation: "derived_from",
        targetType: "message",
        targetId: input.userMessageId,
        weight: 0.5,
        createdAt: at,
      });
      return merged;
    }

    const memory: Memory = {
      id: uuidv7(),
      scope: input.candidate.scope,
      type: input.candidate.type,
      content: input.candidate.content,
      contentHash: memoryHash(input.candidate.content),
      importance: input.candidate.importance,
      confidence: input.candidate.confidence,
      userId: input.userId,
      characterId: input.characterId,
      conversationId: input.conversationId,
      sourceMessageId: input.userMessageId,
      tags: input.candidate.tags,
      reinforcement: 1,
      accessCount: 0,
      lastAccessedAt: null,
      embedding: null,
      supersededBy: null,
      status: "active",
      occurredAt: input.candidate.occurredAt,
      createdAt: at,
      updatedAt: at,
    };
    memories.insert(memory);
    const links: Array<[MemoryLinkRelation, "message" | "character" | "user" | "conversation", string]> = [
      ["derived_from", "message", input.userMessageId],
      ["same_subject", "character", input.characterId],
      ["same_subject", "user", input.userId],
      ["same_subject", "conversation", input.conversationId],
    ];
    if (input.assistantMessageId !== null) links.push(["derived_from", "message", input.assistantMessageId]);
    for (const [relation, targetType, targetId] of links) {
      memories.insertLink({
        id: uuidv7(),
        fromMemoryId: memory.id,
        relation,
        targetType,
        targetId,
        weight: 1,
        createdAt: at,
      });
    }
    return memory;
  }

  return {
    gate,
    /** 抽取与写库解耦：先拿到候选，再决定怎么落库。 */
    async extract(input: ExtractInput): Promise<Memory[]> {
      const at = deps.clock.nowIso();
      const charCount = setting<number>("memory.extraction.maxCandidates", 5);
      const response = await deps.taskLLM.chat(
        "memory_extraction",
        {
          model: "default",
          messages: buildExtractionMessages({
            characterName: input.characterName,
            userName: input.userName,
            userText: input.userText,
            assistantText: input.assistantText,
          }),
          temperature: 0,
        },
        {
          conversationId: input.conversationId,
          messageId: input.assistantMessageId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );

      const parsed = parseCandidates(response.text, at);
      if (parsed.parseFailed) {
        deps.logger.warn("memory extraction returned unparseable output", {
          conversationId: input.conversationId,
          chars: response.text.length,
        });
        return [];
      }
      const candidates: MemoryCandidate[] = parsed.candidates.slice(0, charCount).map((candidate) => ({
        ...candidate,
        importance: candidate.importance > 0 ? candidate.importance : heuristicImportance(candidate.content, candidate.type),
      }));

      const stored: Memory[] = [];
      for (const candidate of candidates) {
        stored.push(
          promote({
            userId: input.userId,
            characterId: input.characterId,
            conversationId: input.conversationId,
            userMessageId: input.userMessageId,
            assistantMessageId: input.assistantMessageId,
            candidate,
          }),
        );
      }
      if (parsed.rejected > 0) {
        deps.logger.debug("memory extraction rejected malformed candidates", { rejected: parsed.rejected });
      }
      return stored;
    },

    /** 检索：保护类记忆优先，再叠加关键词 + 重要性 + 时间衰减。 */
    async retrieve(query: MemoryQuery): Promise<MemoryHit[]> {
      const limit = Math.max(1, query.limit);
      const hits = await deps.retriever.search({ ...query, limit });
      const protectedOnes = deps.memories.protectedMemories({
        userId: query.userId ?? null,
        characterId: query.characterId ?? null,
        limit: 4,
      });
      const seen = new Set(hits.map((hit) => hit.memory.id));
      const merged: MemoryHit[] = [...hits];
      const nowMs = now();
      for (const memory of protectedOnes) {
        if (seen.has(memory.id)) continue;
        // 保护类记忆同样走统一评分（ftsRank=0），否则它会用裸 importance 压过所有关键词命中。
        const { score, components } = scoreMemory({ memory, ftsRank: 0, nowMs }, DEFAULT_SCORE_WEIGHTS);
        merged.push({ memory, score, components });
        seen.add(memory.id);
      }
      const ranked = merged.sort((a, b) => b.score - a.score).slice(0, limit);
      deps.memories.touchAccess(
        ranked.map((hit) => hit.memory.id),
        deps.clock.nowIso(),
      );
      return ranked;
    },

    list(filter: {
      userId?: UserId | null;
      characterId?: CharacterId | null;
      conversationId?: ConversationId | null;
      scope?: MemoryScope;
      status?: MemoryStatus;
      limit?: number;
      offset?: number;
    }): Memory[] {
      return deps.memories.list({ ...filter, limit: filter.limit ?? 100 });
    },

    count(filter: { characterId?: CharacterId | null; status?: MemoryStatus } = {}): number {
      return deps.memories.count(filter);
    },

    get(id: string): Memory | null {
      return deps.memories.getById(id);
    },

    links(id: string) {
      return deps.memories.listLinks(id);
    },

    setStatus(id: string, status: MemoryStatus, supersededBy: string | null = null): void {
      deps.memories.setStatus(id, status, supersededBy);
    },

    delete(id: string): void {
      deps.memories.delete(id);
    },

    updateImportance(id: string, importance: number): Memory | null {
      const memory = deps.memories.getById(id);
      if (memory === null) return null;
      const updated: Memory = { ...memory, importance: Math.min(1, Math.max(0, importance)), updatedAt: deps.clock.nowIso() };
      deps.memories.update(updated);
      return updated;
    },

    /**
     * 衰减（生命周期钩子，Phase 3 由调度器周期调用）：
     * 重要度低且时间久远的记忆转为 archived，不物理删除。
     */
    decay(): { archived: number; scanned: number } {
      const candidates = deps.memories.list({ status: "active", limit: 500 });
      let archived = 0;
      for (const memory of candidates) {
        const halfLife = halfLifeDays(memory);
        if (halfLife === null) continue; // identity / promise 永不衰减
        if (memory.importance >= 0.6) continue;
        if (recencyScore(memory, now()) < 0.15) {
          deps.memories.setStatus(memory.id, "archived");
          archived += 1;
        }
      }
      return { archived, scanned: candidates.length };
    },
  };
}

export function memoryHash(content: string): string {
  // 与仓储层保持一致的 hash 算法（避免 Core 依赖 node:crypto 之外的东西）
  return simpleHash(content.trim().toLowerCase());
}

/** FNV-1a 32 位：用于去重键，不需要密码学强度。 */
export function simpleHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export type MemoryService = ReturnType<typeof createMemoryService>;
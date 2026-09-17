import type {
  Relationship,
  RelationshipChange,
  RelationshipChangeOutcome,
  RelationshipDimension,
  RelationshipMilestone,
  RelationshipStage,
} from "../model/relationship.ts";
import { RELATIONSHIP_DIMENSIONS } from "../model/relationship.ts";
import type { RelationshipRepository } from "../ports/repositories.phase3.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import type { CharacterId, UserId } from "../model/ids.ts";
import { notFound } from "../model/errors.ts";
import { uuidv7 } from "../../util/ids.ts";

/**
 * 关系演进规则：
 * - 每次变化有硬上限（防止模型一次把 trust 从 0 拉到 1）；
 * - 数值恒在 0..1；
 * - 所有变化写流水（relationship_changes），可解释、可回溯。
 */
export const MAX_DELTA_PER_CHANGE = 0.05;
export const RELATIONSHIP_BASELINE: Record<RelationshipDimension, number> = {
  familiarity: 0.05,
  trust: 0.1,
  affection: 0.05,
  intimacy: 0,
  respect: 0.1,
  dependence: 0,
};

export const STAGE_THRESHOLDS: Array<{ stage: RelationshipStage; min: number }> = [
  { stage: "beloved", min: 0.7 },
  { stage: "close", min: 0.5 },
  { stage: "friend", min: 0.3 },
  { stage: "acquaintance", min: 0.15 },
  { stage: "stranger", min: 0 },
];

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 关系阶段由多维加权得出，而不是单独一个 affection。 */
export function computeStage(dimensions: Record<RelationshipDimension, number>): RelationshipStage {
  if (dimensions.familiarity > 0.3 && dimensions.trust < 0.15) return "strained";
  const score =
    dimensions.familiarity * 0.2 +
    dimensions.trust * 0.25 +
    dimensions.affection * 0.25 +
    dimensions.intimacy * 0.15 +
    dimensions.respect * 0.1 +
    dimensions.dependence * 0.05;
  for (const { stage, min } of STAGE_THRESHOLDS) {
    if (score >= min) return stage;
  }
  return "stranger";
}

export interface RelationshipServiceDeps {
  relationships: RelationshipRepository;
  events: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}

export function createRelationshipService(deps: RelationshipServiceDeps) {
  function defaultRelationship(userId: UserId, characterId: CharacterId): Relationship {
    const at = deps.clock.nowIso();
    return {
      id: uuidv7(),
      userId,
      characterId,
      ...RELATIONSHIP_BASELINE,
      stage: "stranger",
      createdAt: at,
      updatedAt: at,
    };
  }

  function get(userId: UserId, characterId: CharacterId): Relationship {
    const existing = deps.relationships.get(userId, characterId);
    if (existing !== null) return existing;
    const created = defaultRelationship(userId, characterId);
    deps.relationships.insert(created);
    return created;
  }

  function addMilestone(relationshipId: string, key: string, label: string, at: string): RelationshipMilestone {
    const milestone: RelationshipMilestone = { id: uuidv7(), relationshipId, key, label, at };
    deps.relationships.insertMilestone(milestone);
    return milestone;
  }

  return {
    get,
    getOrCreate: get,

    /** 唯一的写入口：模型/事件只能提交 RelationshipChange。 */
    applyChange(userId: UserId, characterId: CharacterId, changes: RelationshipChange[]): RelationshipChangeOutcome {
      const current = get(userId, characterId);
      const at = deps.clock.nowIso();
      const next: Relationship = { ...current, updatedAt: at };
      const changed: RelationshipDimension[] = [];
      const clamped: RelationshipDimension[] = [];

      for (const change of changes) {
        if (!RELATIONSHIP_DIMENSIONS.includes(change.dimension)) continue;
        const before = current[change.dimension];
        const requested = Number.isFinite(change.delta) ? change.delta : 0;
        // 单次变化幅度硬上限
        const boundedDelta = Math.max(-MAX_DELTA_PER_CHANGE, Math.min(MAX_DELTA_PER_CHANGE, requested));
        const after = clamp01(before + boundedDelta);
        const wasClamped = Math.abs(boundedDelta - requested) > 1e-9 || Math.abs(after - (before + boundedDelta)) > 1e-9;
        if (wasClamped) clamped.push(change.dimension);
        if (Math.abs(after - before) < 1e-9) continue;
        next[change.dimension] = after;
        changed.push(change.dimension);
        deps.relationships.insertChange({
          id: uuidv7(),
          relationshipId: current.id,
          dimension: change.dimension,
          beforeValue: before,
          afterValue: after,
          delta: after - before,
          clamped: wasClamped,
          reason: change.reason,
          source: change.source,
          sourceMessageId: change.sourceMessageId ?? null,
          createdAt: at,
        });
      }

      const milestonesAdded: RelationshipMilestone[] = [];
      const dimensionsForStage = Object.fromEntries(
        RELATIONSHIP_DIMENSIONS.map((dimension) => [dimension, next[dimension]]),
      ) as Record<RelationshipDimension, number>;
      const stage = computeStage(dimensionsForStage);
      if (stage !== current.stage) {
        next.stage = stage;
        milestonesAdded.push(addMilestone(current.id, `stage:${stage}`, `关系进入「${stage}」阶段`, at));
      } else {
        next.stage = current.stage;
      }

      if (changed.length > 0 || milestonesAdded.length > 0) {
        deps.relationships.update(next);
        deps.events.publish({
          name: "relationship.changed",
          at,
          channel: null,
          payload: { relationshipId: next.id, changed, stage: next.stage },
        });
        deps.logger.debug("relationship updated", { characterId, changed, stage: next.stage });
      }

      return { changed, clamped, relationship: next, milestonesAdded };
    },

    /** 长期无互动时向基线回落（主动消息/调度器可周期调用）。 */
    applyDecay(userId: UserId, characterId: CharacterId, retentionDays = 30): Relationship {
      const current = get(userId, characterId);
      const elapsedDays = (deps.clock.now().getTime() - Date.parse(current.updatedAt)) / 86_400_000;
      if (elapsedDays < retentionDays) return current;
      const factor = Math.min(0.5, (elapsedDays - retentionDays) / 365);
      const next: Relationship = { ...current, updatedAt: deps.clock.nowIso() };
      for (const dimension of RELATIONSHIP_DIMENSIONS) {
        const baseline = RELATIONSHIP_BASELINE[dimension];
        next[dimension] = clamp01(current[dimension] + (baseline - current[dimension]) * factor);
      }
      deps.relationships.update(next);
      return next;
    },

    listChanges(relationshipId: string, limit = 50) {
      return deps.relationships.listChanges(relationshipId, limit);
    },

    /**
     * 删掉一条变化记录 / 一个里程碑。
     * 只删记录本身：关系数值与阶段是**当前状态**，不会因为删掉一条历史而被回滚
     * （回滚会让"现在的信任度"莫名其妙地变回去）。
     */
    deleteChange(userId: UserId, characterId: CharacterId, changeId: string): void {
      const current = deps.relationships.get(userId, characterId);
      if (current === null || !deps.relationships.deleteChange(current.id, changeId)) {
        throw notFound("relationship change", changeId);
      }
    },

    deleteMilestone(userId: UserId, characterId: CharacterId, milestoneId: string): void {
      const current = deps.relationships.get(userId, characterId);
      if (current === null || !deps.relationships.deleteMilestone(current.id, milestoneId)) {
        throw notFound("relationship milestone", milestoneId);
      }
    },

    listMilestones(relationshipId: string) {
      return deps.relationships.listMilestones(relationshipId);
    },
  };
}

export type RelationshipService = ReturnType<typeof createRelationshipService>;

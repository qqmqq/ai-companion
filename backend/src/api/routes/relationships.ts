import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { DomainError } from "../../core/model/errors.ts";
import { RELATIONSHIP_DIMENSIONS } from "../../core/model/relationship.ts";

const ChangeSchema = z.object({
  changes: z
    .array(
      z.object({
        dimension: z.enum(RELATIONSHIP_DIMENSIONS as [string, ...string[]]),
        // 不在这里做范围校验：限幅是 RelationshipService 的职责，接口层假装安全只会掩盖问题
        delta: z.number(),
        reason: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(6),
});

const StimulusSchema = z.object({
  primary: z.string().min(1).max(40),
  // 越界值交给 EmotionService 限幅，接口层不做"看起来安全"的假校验
  intensity: z.number().min(0).max(10).optional(),
  valence: z.number().min(-10).max(10).optional(),
  arousal: z.number().min(0).max(10).optional(),
  energy: z.number().min(0).max(10).optional(),
  reason: z.string().min(1).max(200),
});

export function registerRelationshipRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/relationships", async () => {
    const characters = container.services.characters.list(container.user.id);
    return {
      items: characters.map((character) => {
        const relationship = container.services.relationship.get(container.user.id, character.id);
        return {
          characterId: character.id,
          characterName: character.name,
          stage: relationship.stage,
          dimensions: {
            familiarity: relationship.familiarity,
            trust: relationship.trust,
            affection: relationship.affection,
            intimacy: relationship.intimacy,
            respect: relationship.respect,
            dependence: relationship.dependence,
          },
          updatedAt: relationship.updatedAt,
        };
      }),
    };
  });

  app.get("/api/relationships/:characterId", async (request) => {
    const { characterId } = request.params as { characterId: string };
    const relationship = container.services.relationship.get(container.user.id, characterId);
    return {
      relationship,
      milestones: container.services.relationship.listMilestones(relationship.id),
      changes: container.services.relationship.listChanges(relationship.id, 50),
    };
  });

  /** 手动调整：仍然走 RelationshipService 的限幅与流水，不允许直接写库。 */
  app.post("/api/relationships/:characterId/changes", async (request) => {
    const { characterId } = request.params as { characterId: string };
    const body = parseOrThrow(ChangeSchema, request.body);
    const outcome = container.services.relationship.applyChange(
      container.user.id,
      characterId,
      body.changes.map((change) => ({
        dimension: change.dimension as (typeof RELATIONSHIP_DIMENSIONS)[number],
        delta: change.delta,
        reason: change.reason,
        source: "user_manual" as const,
      })),
    );
    return {
      relationship: outcome.relationship,
      changed: outcome.changed,
      clamped: outcome.clamped,
      milestonesAdded: outcome.milestonesAdded,
    };
  });

  /** 删除一条关系变化记录：只删这条流水，当前关系数值不回滚。 */
  app.delete("/api/relationships/:characterId/changes/:changeId", async (request, reply) => {
    const { characterId, changeId } = request.params as { characterId: string; changeId: string };
    container.services.characters.get(characterId);
    container.services.relationship.deleteChange(container.user.id, characterId, changeId);
    container.repos.audit.append({
      actor: "user",
      action: "relationship.change_deleted",
      targetType: "relationship_change",
      targetId: changeId,
      detail: { characterId },
    });
    reply.code(204);
    return null;
  });

  /** 删除一个里程碑：同样只删记录。 */
  app.delete("/api/relationships/:characterId/milestones/:milestoneId", async (request, reply) => {
    const { characterId, milestoneId } = request.params as { characterId: string; milestoneId: string };
    container.services.characters.get(characterId);
    container.services.relationship.deleteMilestone(container.user.id, characterId, milestoneId);
    container.repos.audit.append({
      actor: "user",
      action: "relationship.milestone_deleted",
      targetType: "relationship_milestone",
      targetId: milestoneId,
      detail: { characterId },
    });
    reply.code(204);
    return null;
  });

  app.get("/api/emotions/:characterId", async (request) => {
    const { characterId } = request.params as { characterId: string };
    const state = container.services.characterState.get(characterId);
    return {
      emotion: container.services.emotion.get(characterId),
      mood: state.mood,
      scheduleState: state.scheduleState,
      activity: state.activity,
      location: state.location,
      energy: state.energy,
      lastInteractionAt: state.lastInteractionAt,
      history: container.services.emotion.history(characterId, 20),
    };
  });

  app.get("/api/emotions/:characterId/history", async (request) => {
    const { characterId } = request.params as { characterId: string };
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    return { items: container.services.emotion.history(characterId, limit) };
  });

  /** 删除一条情绪记录：只删记录，当前情绪状态不变。 */
  app.delete("/api/emotions/:characterId/history/:entryId", async (request, reply) => {
    const { characterId, entryId } = request.params as { characterId: string; entryId: string };
    container.services.characters.get(characterId);
    container.services.emotion.deleteHistory(characterId, entryId);
    container.repos.audit.append({
      actor: "user",
      action: "emotion.history_deleted",
      targetType: "emotion_history",
      targetId: entryId,
      detail: { characterId },
    });
    reply.code(204);
    return null;
  });

  /** 调试/测试用：直接注入一次情绪刺激（仍然经过 EmotionService 的校验与限幅）。 */
  app.post("/api/emotions/:characterId/stimulus", async (request) => {
    const { characterId } = request.params as { characterId: string };
    const body = parseOrThrow(StimulusSchema, request.body);
    const result = container.services.emotion.applyChange(
      characterId,
      {
        primary: body.primary,
        intensity: body.intensity,
        valence: body.valence,
        arousal: body.arousal,
        energy: body.energy,
        reason: body.reason,
        source: "user_manual",
        triggerKind: "manual",
      },
      { userId: container.user.id },
    );
    return { emotion: result.state, entry: result.entry };
  });

  app.get("/api/characters/:id/state/full", async (request) => {
    const { id } = request.params as { id: string };
    const state = container.services.characterState.get(id);
    if (state === null) throw new DomainError("not_found", `character state not found: ${id}`);
    return state;
  });
}
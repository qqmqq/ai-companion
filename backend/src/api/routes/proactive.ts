import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { AUTONOMY_ORDER } from "../../core/model/proactive.ts";

const PolicySchema = z.object({
  enabled: z.boolean().optional(),
  autonomy: z.enum(AUTONOMY_ORDER as [string, ...string[]]).optional(),
  quietHours: z
    .object({ enabled: z.boolean(), start: z.string().regex(/^\d{1,2}:\d{2}$/), end: z.string().regex(/^\d{1,2}:\d{2}$/) })
    .optional(),
  dailyLimit: z.number().int().min(0).max(50).optional(),
  cooldownMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
  inactivityThresholdMs: z.number().int().min(60_000).max(30 * 86_400_000).optional(),
});

const ProposeSchema = z.object({
  characterId: z.string().min(1),
  triggerKind: z.enum(["idle_check", "scheduled_window", "event_due", "task", "manual"]).default("manual"),
  reason: z.string().max(300).optional(),
});

export function registerProactiveRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/proactive/settings", async () => {
    const policy = container.services.proactive.policy();
    const characters = container.services.characters.list(container.user.id);
    return {
      policy,
      /** 每个角色的"当前是否能主动说话"，让 UI 能解释"为什么现在不发" */
      eligibility: characters.map((character) => ({
        characterId: character.id,
        characterName: character.name,
        decision: container.services.proactive.checkPolicy(character.id),
      })),
    };
  });

  app.put("/api/proactive/settings", async (request) => {
    const body = parseOrThrow(PolicySchema, request.body);
    return { policy: container.services.proactive.updatePolicy(body as never) };
  });

  app.get("/api/proactive/decisions", async (request) => {
    const query = request.query as { characterId?: string; decision?: string; limit?: string };
    return {
      items: container.services.proactive.decisions({
        characterId: query.characterId ?? null,
        ...(query.decision === undefined ? {} : { decision: query.decision as never }),
        limit: Math.min(Number(query.limit ?? 50) || 50, 200),
      }),
    };
  });

  /** dry-run：完整走策略判断与上下文构建，但不发送、不占用额度。 */
  app.post("/api/proactive/preview", async (request) => {
    const body = parseOrThrow(ProposeSchema, request.body);
    const result = await container.services.proactive.propose({
      userId: container.user.id,
      characterId: body.characterId,
      triggerKind: body.triggerKind,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      dryRun: true,
    });
    return result;
  });

  /** 手动触发真实发送：同样受 ProactivePolicy 约束，不允许绕过。 */
  app.post("/api/proactive/trigger", async (request) => {
    const body = parseOrThrow(ProposeSchema, request.body);
    return container.services.proactive.propose({
      userId: container.user.id,
      characterId: body.characterId,
      triggerKind: body.triggerKind,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  });
}

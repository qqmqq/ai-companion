import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { toMemoryDto, toMessageDto } from "../dto/mappers.ts";
import { DomainError } from "../../core/model/errors.ts";
import type { MemoryScope } from "../../core/model/memory.ts";

const UpdateSchema = z.object({ importance: z.number().min(0).max(1) });
const SearchSchema = z.object({ text: z.string().min(1).max(500), characterId: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) });

export function registerMemoryRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/memories", async (request) => {
    const query = request.query as { characterId?: string; scope?: string; q?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
    const scope = query.scope as MemoryScope | undefined;
    const filter = {
      ...(query.characterId === undefined ? {} : { characterId: query.characterId }),
      ...(scope === undefined ? {} : { scope }),
      limit,
    };
    const items = container.services.memory.list(filter).map(toMemoryDto);
    const filtered =
      query.q === undefined || query.q.trim().length === 0
        ? items
        : items.filter((item) => String(item.content).includes(query.q!.trim()) || (item.tags as string[]).some((tag) => tag.includes(query.q!.trim())));
    return { items: filtered, total: container.services.memory.count(query.characterId === undefined ? {} : { characterId: query.characterId }) };
  });

  /** 语义检索（FTS5 + 重要性 + 时间衰减），用于排查"为什么没想起来"。 */
  app.post("/api/memories/search", async (request) => {
    const body = parseOrThrow(SearchSchema, request.body);
    const hits = await container.services.memory.retrieve({
      text: body.text,
      characterId: body.characterId ?? null,
      userId: container.user.id,
      limit: body.limit,
    });
    return {
      items: hits.map((hit) => ({
        memory: toMemoryDto(hit.memory),
        score: Number(hit.score.toFixed(4)),
        components: hit.components,
      })),
    };
  });

  app.get("/api/memories/stats", async () => {
    return {
      total: container.services.memory.count({}),
      active: container.services.memory.count({ status: "active" }),
      archived: container.services.memory.count({ status: "archived" }),
    };
  });

  app.get("/api/memories/:id", async (request) => {
    const { id } = request.params as { id: string };
    const memory = container.services.memory.get(id);
    if (memory === null) throw new DomainError("not_found", `memory not found: ${id}`);
    const links = container.services.memory.links(id);
    const sourceMessageId = links.find((link) => link.targetType === "message")?.targetId ?? null;
    const sourceMessage = sourceMessageId === null ? null : container.repos.messages.getById(sourceMessageId);
    return {
      memory: toMemoryDto(memory),
      links,
      sourceMessage: sourceMessage === null ? null : toMessageDto(sourceMessage),
    };
  });

  app.patch("/api/memories/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(UpdateSchema, request.body);
    const updated = container.services.memory.updateImportance(id, body.importance);
    if (updated === null) throw new DomainError("not_found", `memory not found: ${id}`);
    return toMemoryDto(updated);
  });

  app.delete("/api/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (container.services.memory.get(id) === null) throw new DomainError("not_found", `memory not found: ${id}`);
    container.services.memory.delete(id);
    reply.code(204);
    return null;
  });

  /** 生命周期钩子：衰减（Phase 3 会由调度器周期触发）。 */
  app.post("/api/memories/decay", async () => {
    return container.services.memory.decay();
  });
}

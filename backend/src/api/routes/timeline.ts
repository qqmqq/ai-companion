import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { DomainError } from "../../core/model/errors.ts";
import { EVENT_STATUSES } from "../../core/model/event.ts";

const EventTypeSchema = z.enum([
  "important_conversation",
  "promise",
  "future_plan",
  "anniversary",
  "user_info",
  "relationship_change",
  "shared_experience",
  "character_life",
  "custom",
]);

const CreateEventSchema = z.object({
  characterId: z.string().min(1),
  type: EventTypeSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  importance: z.number().min(0).max(1).default(0.5),
  occurredAt: z.string().nullable().default(null),
  scheduledAt: z.string().nullable().default(null),
  dueAt: z.string().nullable().default(null),
  recurrence: z.string().max(200).nullable().default(null),
  startActive: z.boolean().default(false),
});

const UpdateEventSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  importance: z.number().min(0).max(1).optional(),
  dueAt: z.string().nullable().optional(),
  scheduledAt: z.string().nullable().optional(),
  recurrence: z.string().max(200).nullable().optional(),
});

const CreateTaskSchema = z.object({
  characterId: z.string().min(1),
  kind: z.enum(["proactive_message", "memory_extract", "summarize", "event_reminder", "custom"]),
  executeAt: z.string().min(1),
  priority: z.number().int().min(1).max(9).default(5),
  payload: z.record(z.unknown()).default({}),
  eventId: z.string().nullable().default(null),
});

export function registerTimelineRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/events", async (request) => {
    const query = request.query as { characterId?: string; status?: string; type?: string; limit?: string };
    const status = query.status as (typeof EVENT_STATUSES)[number] | undefined;
    return {
      items: container.services.events.list({
        userId: container.user.id,
        characterId: query.characterId ?? null,
        ...(status === undefined ? {} : { status }),
        ...(query.type === undefined ? {} : { type: query.type as never }),
        limit: Math.min(Number(query.limit ?? 100) || 100, 300),
      }),
    };
  });

  app.post("/api/events", async (request, reply) => {
    const body = parseOrThrow(CreateEventSchema, request.body);
    const event = container.services.events.create({
      userId: container.user.id,
      characterId: body.characterId,
      type: body.type,
      title: body.title,
      description: body.description,
      importance: body.importance,
      occurredAt: body.occurredAt,
      scheduledAt: body.scheduledAt,
      dueAt: body.dueAt,
      recurrence: body.recurrence,
      startActive: body.startActive,
      source: "user_manual",
    });
    reply.code(201);
    return event;
  });

  app.get("/api/events/:id", async (request) => {
    const { id } = request.params as { id: string };
    const event = container.services.events.get(id);
    const tasks = container.services.tasks.list({ characterId: event.characterId, limit: 50 }).filter((task) => task.eventId === id);
    return { event, tasks };
  });

  app.patch("/api/events/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(UpdateEventSchema, request.body);
    return container.services.events.update(id, body);
  });

  app.post("/api/events/:id/activate", async (request) => {
    const { id } = request.params as { id: string };
    return container.services.events.activate(id);
  });

  app.post("/api/events/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    return container.services.events.complete(id);
  });

  app.post("/api/events/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return container.services.events.cancel(id);
  });

  app.delete("/api/events/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    container.services.events.delete(id);
    container.repos.audit.append({ actor: "user", action: "event.deleted", targetType: "event", targetId: id, detail: {} });
    reply.code(204);
    return null;
  });

  app.get("/api/tasks", async (request) => {
    const query = request.query as { characterId?: string; status?: string; limit?: string };
    return {
      items: container.services.tasks.list({
        characterId: query.characterId ?? null,
        ...(query.status === undefined ? {} : { status: query.status as never }),
        limit: Math.min(Number(query.limit ?? 100) || 100, 300),
      }),
    };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = parseOrThrow(CreateTaskSchema, request.body);
    const task = container.services.tasks.create({
      userId: container.user.id,
      characterId: body.characterId,
      kind: body.kind,
      executeAt: body.executeAt,
      priority: body.priority,
      payload: body.payload,
      eventId: body.eventId,
    });
    reply.code(201);
    return task;
  });

  app.post("/api/tasks/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    return container.services.tasks.complete(id);
  });

  app.post("/api/tasks/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return container.services.tasks.cancel(id);
  });

  app.delete("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    container.services.tasks.delete(id);
    container.repos.audit.append({ actor: "user", action: "task.deleted", targetType: "task", targetId: id, detail: {} });
    reply.code(204);
    return null;
  });

  /** 手动推进一次到期任务（不依赖真实定时器，便于演示与排查）。 */
  app.post("/api/tasks/run", async () => {
    return container.services.tasks.runDue();
  });
}

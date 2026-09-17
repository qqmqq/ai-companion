import type { CompanionEvent, EventFilters, EventSource, EventStatus, EventType } from "../model/event.ts";
import { EVENT_STATUSES } from "../model/event.ts";
import type { EventRepository } from "../ports/repositories.phase3.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import type { CharacterId, MessageId, UserId } from "../model/ids.ts";
import { DomainError, notFound } from "../model/errors.ts";
import { uuidv7 } from "../../util/ids.ts";

const EVENT_TYPES: EventType[] = [
  "important_conversation",
  "promise",
  "future_plan",
  "anniversary",
  "user_info",
  "relationship_change",
  "shared_experience",
  "character_life",
  "custom",
];

export interface CreateEventInput {
  userId: UserId;
  characterId: CharacterId;
  type: EventType;
  title: string;
  description?: string;
  importance?: number;
  occurredAt?: string | null;
  scheduledAt?: string | null;
  dueAt?: string | null;
  recurrence?: string | null;
  source?: EventSource;
  sourceMessageId?: MessageId | null;
  metadata?: Record<string, unknown>;
  /** 是否直接进入 active（例如"正在发生"的共同经历） */
  startActive?: boolean;
}

/**
 * 事件 = 发生 / 将要发生的事情。
 * 生命周期：planned → active → completed；或 → cancelled / expired。
 * 事件的效果（影响关系、派生任务）由外部通过 EventEffectHandlers 注入，EventService 本身不认识它们。
 */
export interface EventEffectHandlers {
  onCreated?: (event: CompanionEvent) => Promise<void> | void;
  onCompleted?: (event: CompanionEvent) => Promise<void> | void;
  onStatusChanged?: (event: CompanionEvent, previous: EventStatus) => Promise<void> | void;
}

export function createEventService(deps: {
  events: EventRepository;
  effectHandlers: EventEffectHandlers;
  publisher: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}) {
  function require(eventId: string): CompanionEvent {
    const event = deps.events.get(eventId);
    if (event === null) throw notFound("event", eventId);
    return event;
  }

  function setStatus(event: CompanionEvent, status: EventStatus, at: string): CompanionEvent {
    const next: CompanionEvent = {
      ...event,
      status,
      completedAt: status === "completed" ? at : event.completedAt,
      updatedAt: at,
    };
    deps.events.update(next);
    deps.publisher.publish({
      name: "event.updated",
      at,
      channel: null,
      payload: { eventId: next.id, status, previous: event.status },
    });
    return next;
  }

  return {
    create(input: CreateEventInput): CompanionEvent {
      if (input.title.trim().length === 0) throw new DomainError("invalid_input", "事件标题不能为空");
      if (!EVENT_TYPES.includes(input.type)) throw new DomainError("invalid_input", `未知事件类型: ${input.type}`);
      const at = deps.clock.nowIso();
      const event: CompanionEvent = {
        id: uuidv7(),
        userId: input.userId,
        characterId: input.characterId,
        type: input.type,
        title: input.title.trim().slice(0, 200),
        description: (input.description ?? "").slice(0, 2000),
        status: input.startActive === true ? "active" : "planned",
        importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
        occurredAt: input.occurredAt ?? null,
        scheduledAt: input.scheduledAt ?? null,
        dueAt: input.dueAt ?? null,
        completedAt: null,
        recurrence: input.recurrence ?? null,
        source: input.source ?? "user_manual",
        sourceMessageId: input.sourceMessageId ?? null,
        metadata: input.metadata ?? {},
        createdAt: at,
        updatedAt: at,
      };
      deps.events.insert(event);
      deps.publisher.publish({ name: "event.created", at, channel: null, payload: { eventId: event.id, type: event.type } });
      void deps.effectHandlers.onCreated?.(event);
      return event;
    },

    get: require,

    list(filters: EventFilters): CompanionEvent[] {
      return deps.events.list(filters);
    },

    update(eventId: string, patch: Partial<Pick<CompanionEvent, "title" | "description" | "importance" | "dueAt" | "scheduledAt" | "recurrence" | "metadata">>): CompanionEvent {
      const current = require(eventId);
      const next: CompanionEvent = {
        ...current,
        ...patch,
        title: (patch.title ?? current.title).trim().slice(0, 200),
        importance: Math.min(1, Math.max(0, patch.importance ?? current.importance)),
        updatedAt: deps.clock.nowIso(),
      };
      if (next.title.length === 0) throw new DomainError("invalid_input", "事件标题不能为空");
      deps.events.update(next);
      return next;
    },

    activate(eventId: string): CompanionEvent {
      const current = require(eventId);
      return setStatus(current, "active", deps.clock.nowIso());
    },

    async complete(eventId: string): Promise<CompanionEvent> {
      const current = require(eventId);
      const next = setStatus(current, "completed", deps.clock.nowIso());
      await deps.effectHandlers.onCompleted?.(next);
      return next;
    },

    cancel(eventId: string): CompanionEvent {
      const current = require(eventId);
      return setStatus(current, "cancelled", deps.clock.nowIso());
    },

    /** 到期未完成 → expired（由 Scheduler 周期调用，不使用 setTimeout）。 */
    async expireOverdue(nowIso: string, graceMs = 24 * 60 * 60 * 1000): Promise<CompanionEvent[]> {
      const pending = deps.events.listPending(nowIso, 50);
      const cutoff = Date.parse(nowIso) - graceMs;
      const expired: CompanionEvent[] = [];
      for (const event of pending) {
        if (event.dueAt === null) continue;
        if (Date.parse(event.dueAt) > cutoff) continue;
        const previous = event.status;
        const next = setStatus(event, "expired", nowIso);
        await deps.effectHandlers.onStatusChanged?.(next, previous);
        expired.push(next);
      }
      if (expired.length > 0) deps.logger.info("events expired", { count: expired.length });
      return expired;
    },

    delete(eventId: string): void {
      require(eventId);
      deps.events.delete(eventId);
    },

    statuses(): EventStatus[] {
      return [...EVENT_STATUSES];
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;

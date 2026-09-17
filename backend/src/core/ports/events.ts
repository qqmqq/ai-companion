import type { ChannelKind } from "../model/channel.ts";

export type DomainEventName =
  | "message.new"
  | "message.delta"
  | "conversation.updated"
  | "character.created"
  | "channel.status"
  | "typing"
  // Phase 3：关系 / 情绪 / 事件 / 任务 / 调度 / 主动消息
  | "relationship.changed"
  | "emotion.changed"
  | "event.created"
  | "event.updated"
  | "task.created"
  | "task.updated"
  | "job.updated"
  | "proactive.decided"
  | "scheduler.tick";

export interface DomainEvent<TPayload = Record<string, unknown>> {
  name: DomainEventName;
  at: string;
  channel: ChannelKind | null;
  payload: TPayload;
}

export interface DomainEventPublisher {
  publish(event: DomainEvent): void;
}
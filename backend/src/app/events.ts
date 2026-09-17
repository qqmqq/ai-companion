import type { DomainEvent, DomainEventPublisher } from "../core/ports/events.ts";

export interface DomainEventSubscriber {
  onEvent(event: DomainEvent): void;
}

export interface InMemoryEventBus extends DomainEventPublisher {
  subscribe(subscriber: DomainEventSubscriber): () => void;
  subscriberCount(): number;
}

export function createEventBus(): InMemoryEventBus {
  const subscribers = new Set<DomainEventSubscriber>();
  return {
    publish(event: DomainEvent): void {
      for (const subscriber of subscribers) {
        try {
          subscriber.onEvent(event);
        } catch {
          // 单个订阅者失败不能影响其他订阅者或主流程
        }
      }
    },
    subscribe(subscriber: DomainEventSubscriber): () => void {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    subscriberCount: () => subscribers.size,
  };
}

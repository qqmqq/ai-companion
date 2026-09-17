import type { DomainEvent } from "../../core/ports/events.ts";

export interface SseClient {
  write(chunk: string): void;
  close(): void;
}

export interface SseHub {
  addClient(client: SseClient): () => void;
  broadcast(event: DomainEvent): void;
  clientCount(): number;
}

export function createSseHub(): SseHub {
  const clients = new Set<SseClient>();
  return {
    addClient(client: SseClient): () => void {
      clients.add(client);
      return () => {
        clients.delete(client);
      };
    },
    broadcast(event: DomainEvent): void {
      const payload = `event: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    },
    clientCount: () => clients.size,
  };
}

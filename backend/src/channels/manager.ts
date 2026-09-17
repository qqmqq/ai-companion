import type { ChannelAdapter, InboundHandler } from "../core/ports/channel.ts";
import type { ChannelRegistry } from "../core/ports/channel-registry.ts";
import type { ChannelHealth, ChannelKind } from "../core/model/channel.ts";
import type { Logger } from "../core/ports/logger.ts";

export interface ChannelManager extends ChannelRegistry {
  register(adapter: ChannelAdapter): void;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  healthAll(): Promise<ChannelHealth[]>;
  setInboundHandler(handler: InboundHandler): void;
}

export function createChannelManager(deps: { logger: Logger }): ChannelManager {
  const adapters = new Map<ChannelKind, ChannelAdapter>();
  let handler: InboundHandler | null = null;

  return {
    register(adapter: ChannelAdapter): void {
      adapters.set(adapter.kind, adapter);
      if (handler !== null) adapter.onInbound(handler);
      deps.logger.info("channel registered", { channel: adapter.kind });
    },
    get(kind: ChannelKind): ChannelAdapter | undefined {
      return adapters.get(kind);
    },
    list(): ChannelAdapter[] {
      return [...adapters.values()];
    },
    setInboundHandler(next: InboundHandler): void {
      handler = next;
      for (const adapter of adapters.values()) adapter.onInbound(next);
    },
    async startAll(): Promise<void> {
      for (const adapter of adapters.values()) {
        try {
          await adapter.start();
        } catch (error) {
          deps.logger.error("channel failed to start", { channel: adapter.kind, error: (error as Error).message });
        }
      }
    },
    async stopAll(): Promise<void> {
      for (const adapter of adapters.values()) {
        try {
          await adapter.stop();
        } catch (error) {
          deps.logger.error("channel failed to stop", { channel: adapter.kind, error: (error as Error).message });
        }
      }
    },
    async healthAll(): Promise<ChannelHealth[]> {
      return Promise.all([...adapters.values()].map((adapter) => adapter.health()));
    },
  };
}

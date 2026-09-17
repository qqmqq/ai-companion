import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/bootstrap.ts";

export function registerChannelRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/channels", async () => {
    const health = await container.channels.healthAll();
    return {
      items: container.channels.list().map((adapter) => {
        const entry = health.find((h) => h.channel === adapter.kind);
        return { kind: adapter.kind, capabilities: adapter.capabilities, health: entry ?? null };
      }),
    };
  });

  app.get("/api/channels/:kind/accounts", async (request) => {
    const { kind } = request.params as { kind: string };
    const adapter = container.channels.get(kind as never);
    if (adapter === undefined) {
      return { items: [] };
    }
    return { items: await adapter.listAccounts() };
  });
}

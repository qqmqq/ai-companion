import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/bootstrap.ts";

export function registerHealthRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/system/health", async () => {
    let database = "ok";
    try {
      container.db.raw.prepare("SELECT 1 AS ok").get();
    } catch (error) {
      database = `error: ${(error as Error).message}`;
    }
    const channels = await container.channels.healthAll();
    return {
      status: database === "ok" ? "ok" : "degraded",
      version: "0.1.0",
      startedAt: container.startedAt,
      database,
      channels,
      sseClients: container.webHub.clientCount(),
      providers: container.providers.list().map((p) => ({ id: p.id, kind: p.kind })),
    };
  });

  app.get("/api/system/info", async () => {
    return {
      channels: container.channels.list().map((adapter) => ({
        kind: adapter.kind,
        capabilities: adapter.capabilities,
      })),
      providers: container.providers.list().map((p) => ({ id: p.id, kind: p.kind })),
    };
  });
}

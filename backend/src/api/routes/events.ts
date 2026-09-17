import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/bootstrap.ts";

export function registerEventRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/events/stream", (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const remove = container.webHub.addClient({
      write: (chunk) => reply.raw.write(chunk),
      close: () => reply.raw.end(),
    });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      remove();
    });
    return reply;
  });
}

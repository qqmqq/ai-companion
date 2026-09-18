import Fastify, { type FastifyInstance } from "fastify";
import type { Container } from "./bootstrap.ts";
import { toApiError } from "../api/errors.ts";
import { registerHealthRoutes } from "../api/routes/health.ts";
import { registerCharacterRoutes } from "../api/routes/characters.ts";
import { registerConversationRoutes } from "../api/routes/conversations.ts";
import { registerMessageRoutes } from "../api/routes/messages.ts";
import { registerChannelRoutes } from "../api/routes/channels.ts";
import { registerEventRoutes } from "../api/routes/events.ts";
import { registerProviderRoutes } from "../api/routes/providers.ts";
import { registerMemoryRoutes } from "../api/routes/memories.ts";
import { registerContextRoutes } from "../api/routes/context.ts";
import { registerRelationshipRoutes } from "../api/routes/relationships.ts";
import { registerTimelineRoutes } from "../api/routes/timeline.ts";
import { registerSchedulerRoutes } from "../api/routes/scheduler.ts";
import { registerProactiveRoutes } from "../api/routes/proactive.ts";
import { registerIntegrationRoutes } from "../api/routes/integrations.ts";
import type { HttpRouteHost, RouteHandler } from "../core/ports/channel-module.ts";

/** 把渠道自己的路由挂到 web 层：渠道不需要 import 具体 web 框架。 */
function toRouteHost(app: FastifyInstance): HttpRouteHost {
  const wrap = (method: "get" | "post" | "put" | "patch" | "delete") =>
    (path: string, handler: RouteHandler): void => {
      app[method](path, async (request, reply) => {
        return await handler(
          {
            params: (request.params ?? {}) as Record<string, string>,
            query: (request.query ?? {}) as Record<string, unknown>,
            body: request.body,
          },
          { code: (status: number) => reply.code(status) },
        );
      });
    };
  return { get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

export function createHttpServer(container: Container): FastifyInstance {
  const app = Fastify({
    // 自带 logger 关闭：日志统一走我们自己的脱敏 logger
    logger: false,
    bodyLimit: 12 * 1024 * 1024,
  });

  // 空的 JSON body 视为 {}：像"测试连接""中止生成"这类无参数 POST 不应该 500。
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body: string, done) => {
    if (body === undefined || body.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook("onRequest", async (request) => {
    container.logger.debug("http request", {
      method: request.method,
      url: request.url,
      remote: request.ip,
    });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const { statusCode, body } = toApiError(error);
    if (statusCode >= 500) {
      container.logger.error("http request failed", {
        method: request.method,
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: `no route for ${request.url}`, details: {} } });
  });

  registerHealthRoutes(app, container);
  registerCharacterRoutes(app, container);
  registerConversationRoutes(app, container);
  registerMessageRoutes(app, container);
  registerChannelRoutes(app, container);
  registerProviderRoutes(app, container);
  registerMemoryRoutes(app, container);
  registerContextRoutes(app, container);
  registerRelationshipRoutes(app, container);
  registerTimelineRoutes(app, container);
  registerSchedulerRoutes(app, container);
  registerIntegrationRoutes(app, container);
  registerProactiveRoutes(app, container);
  registerEventRoutes(app, container);

  // 可选渠道（运行时发现）自带的管理接口
  const routeHost = toRouteHost(app);
  for (const entry of container.channelModules) {
    try {
      entry.module.registerRoutes?.(routeHost, { channels: container.channels, logger: container.logger });
    } catch (error) {
      container.logger.error("channel module routes failed to register", {
        entry: entry.name,
        error: (error as Error).message,
      });
    }
  }

  return app;
}
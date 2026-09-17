import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { toProviderDto } from "../dto/mappers.ts";
import { DomainError } from "../../core/model/errors.ts";
import { ProviderError } from "../../core/model/provider-error.ts";
import type { ProviderConfig, ProviderKind } from "../../core/model/usage.ts";
import { TASK_TYPES } from "../../core/model/task.ts";
import { nowIso } from "../../util/time.ts";
import { uuidv7 } from "../../util/ids.ts";

const ProviderSchema = z.object({
  id: z.string().min(1).max(60).optional(),
  kind: z.enum(["openai-compatible", "ollama", "echo"]),
  displayName: z.string().min(1).max(120),
  baseUrl: z.string().min(1).max(300),
  defaultModel: z.string().min(1).max(200),
  requiresCredential: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  enabled: z.boolean().default(true),
  /** 密钥只进不出：写入 CredentialStore，永不出现在任何响应里 */
  apiKey: z.string().min(1).max(500).optional(),
});

const RouteSchema = z.object({
  taskType: z.enum(TASK_TYPES as [string, ...string[]]),
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).max(200).nullable(),
});

export function registerProviderRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/providers", async () => {
    const items = await Promise.all(
      container.repos.providerConfig.list().map(async (config) =>
        toProviderDto(config, config.credentialRef === null ? false : await container.credentials.hasSecret(config.credentialRef)),
      ),
    );
    return { items };
  });

  app.post("/api/providers", async (request, reply) => {
    const body = parseOrThrow(ProviderSchema, request.body);
    const id = body.id ?? `${body.kind}-${uuidv7().slice(0, 8)}`;
    const at = nowIso();
    const existing = container.repos.providerConfig.get(id);
    const config: ProviderConfig = {
      id,
      kind: body.kind as ProviderKind,
      displayName: body.displayName,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel,
      credentialRef: body.apiKey === undefined ? (existing?.credentialRef ?? null) : id,
      requiresCredential: body.requiresCredential && body.kind !== "echo",
      timeoutMs: body.timeoutMs,
      enabled: body.enabled,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    container.repos.providerConfig.upsert(config);
    if (body.apiKey !== undefined) {
      await container.credentials.putSecret(id, { apiKey: body.apiKey });
    }
    await container.reloadProviders();
    container.repos.audit.append({
      actor: "user",
      action: "provider.upsert",
      targetType: "provider",
      targetId: id,
      detail: { kind: config.kind, baseUrl: config.baseUrl, credentialWritten: body.apiKey !== undefined },
    });
    reply.code(existing === null ? 201 : 200);
    return toProviderDto(config, config.credentialRef !== null && (await container.credentials.hasSecret(config.credentialRef)));
  });

  app.patch("/api/providers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const existing = container.repos.providerConfig.get(id);
    if (existing === null) throw new DomainError("not_found", `provider not found: ${id}`);
    const body = parseOrThrow(ProviderSchema.partial(), request.body);
    const at = nowIso();
    const config: ProviderConfig = {
      ...existing,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
      ...(body.defaultModel === undefined ? {} : { defaultModel: body.defaultModel }),
      ...(body.requiresCredential === undefined ? {} : { requiresCredential: body.requiresCredential }),
      ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      updatedAt: at,
      ...(body.apiKey === undefined ? {} : { credentialRef: id }),
    };
    container.repos.providerConfig.upsert(config);
    if (body.apiKey !== undefined) await container.credentials.putSecret(id, { apiKey: body.apiKey });
    await container.reloadProviders();
    return toProviderDto(config, config.credentialRef !== null && (await container.credentials.hasSecret(config.credentialRef)));
  });

  app.delete("/api/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    // 先删路由：删了 provider 却留着指向它的路由，会让模型选择被一条悬空路由劫持
    container.repos.providerConfig.deleteRoutesByProvider(id);
    container.repos.providerConfig.delete(id);
    await container.credentials.deleteSecret(id);
    await container.reloadProviders();
    reply.code(204);
    return null;
  });

  /** 连通性测试：只返回模型清单，不返回任何凭据信息。 */
  app.post("/api/providers/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    try {
      const models = await container.providers.refreshModelInfo(id);
      return { ok: true, models: models.map((m) => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities })) };
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      return {
        ok: false,
        error: {
          kind: providerError?.providerKind ?? "unknown",
          message: (error as Error).message,
          retryable: providerError?.retryable ?? false,
        },
        models: [],
      };
    }
  });

  app.post("/api/providers/reload", async () => {
    await container.reloadProviders();
    return { ok: true, providers: container.providers.list().map((p) => p.id) };
  });

  app.get("/api/models", async () => {
    const configs = container.repos.providerConfig.list().filter((config) => config.enabled);
    const items: Array<{ providerId: string; models: Array<{ id: string; displayName: string }>; error: string | null }> = [];
    for (const config of configs) {
      try {
        const models = await container.providers.refreshModelInfo(config.id);
        items.push({ providerId: config.id, models: models.map((m) => ({ id: m.id, displayName: m.displayName })), error: null });
      } catch (error) {
        items.push({ providerId: config.id, models: [], error: (error as Error).message });
      }
    }
    return { items };
  });

  app.get("/api/model-routing", async () => {
    const routes = container.repos.providerConfig.listRoutes();
    return {
      items: TASK_TYPES.map((taskType) => {
        const explicit = routes.find((route) => route.taskType === taskType) ?? null;
        const resolved = container.modelRouter.resolve(taskType);
        return {
          taskType,
          configured: explicit === null ? null : { providerId: explicit.providerId, model: explicit.model },
          resolved: { providerId: resolved.providerId, model: resolved.model },
          updatedAt: explicit?.updatedAt ?? null,
        };
      }),
    };
  });

  app.put("/api/model-routing", async (request) => {
    const body = parseOrThrow(RouteSchema, request.body);
    container.repos.providerConfig.upsertRoute({
      taskType: body.taskType as (typeof TASK_TYPES)[number],
      providerId: body.providerId,
      model: body.model,
      updatedAt: nowIso(),
    });
    const resolved = container.modelRouter.resolve(body.taskType as (typeof TASK_TYPES)[number]);
    return { taskType: body.taskType, resolved: { providerId: resolved.providerId, model: resolved.model } };
  });

  app.get("/api/usage", async (request) => {
    const query = request.query as { days?: string; limit?: string };
    const days = Math.min(Math.max(Number(query.days ?? 7) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return {
      since,
      summary: container.repos.usage.summary(since),
      recent: container.repos.usage.listRecent(Math.min(Number(query.limit ?? 50) || 50, 200)),
    };
  });
}

import type { Database } from "../db.ts";
import type { ModelRoute, ProviderConfig, ProviderKind } from "../../core/model/usage.ts";
import type { TaskType } from "../../core/model/task.ts";
import type { ProviderConfigRepository } from "../../core/ports/repositories.phase2.ts";

const PROVIDER_COLUMNS =
  "id, kind, display_name, base_url, default_model, credential_ref, requires_credential, timeout_ms, enabled, created_at, updated_at";

function mapProvider(row: Record<string, unknown>): ProviderConfig {
  return {
    id: String(row.id),
    kind: String(row.kind) as ProviderKind,
    displayName: String(row.display_name),
    baseUrl: String(row.base_url),
    defaultModel: String(row.default_model),
    credentialRef: row.credential_ref === null ? null : String(row.credential_ref),
    requiresCredential: Number(row.requires_credential) === 1,
    timeoutMs: Number(row.timeout_ms),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRoute(row: Record<string, unknown>): ModelRoute {
  return {
    taskType: String(row.task_type) as TaskType,
    providerId: row.provider_id === null ? null : String(row.provider_id),
    model: row.model === null ? null : String(row.model),
    updatedAt: String(row.updated_at),
  };
}

export function createProviderConfigRepository(db: Database): ProviderConfigRepository {
  const upsertStmt = db.raw.prepare(
    `INSERT INTO model_providers (${PROVIDER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name, base_url = excluded.base_url,
       default_model = excluded.default_model, credential_ref = excluded.credential_ref,
       requires_credential = excluded.requires_credential, timeout_ms = excluded.timeout_ms,
       enabled = excluded.enabled, updated_at = excluded.updated_at`,
  );
  const getStmt = db.raw.prepare(`SELECT ${PROVIDER_COLUMNS} FROM model_providers WHERE id = ?`);
  const listStmt = db.raw.prepare(`SELECT ${PROVIDER_COLUMNS} FROM model_providers ORDER BY created_at`);
  const deleteStmt = db.raw.prepare("DELETE FROM model_providers WHERE id = ?");

  const routeUpsert = db.raw.prepare(
    `INSERT INTO model_routes (task_type, provider_id, model, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_type) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, updated_at = excluded.updated_at`,
  );
  const routeGet = db.raw.prepare("SELECT task_type, provider_id, model, updated_at FROM model_routes WHERE task_type = ?");
  const routeList = db.raw.prepare("SELECT task_type, provider_id, model, updated_at FROM model_routes ORDER BY task_type");
  const routeDelete = db.raw.prepare("DELETE FROM model_routes WHERE task_type = ?");
  const routeDeleteByProvider = db.raw.prepare("DELETE FROM model_routes WHERE provider_id = ?");

  return {
    upsert: (config) => {
      upsertStmt.run(
        config.id,
        config.kind,
        config.displayName,
        config.baseUrl,
        config.defaultModel,
        config.credentialRef,
        config.requiresCredential ? 1 : 0,
        config.timeoutMs,
        config.enabled ? 1 : 0,
        config.createdAt,
        config.updatedAt,
      );
    },
    get: (id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? mapProvider(row) : null;
    },
    list: () => (listStmt.all() as Array<Record<string, unknown>>).map(mapProvider),
    delete: (id) => {
      deleteStmt.run(id);
    },
    upsertRoute: (route) => {
      routeUpsert.run(route.taskType, route.providerId, route.model, route.updatedAt);
    },
    getRoute: (taskType) => {
      const row = routeGet.get(taskType) as Record<string, unknown> | undefined;
      return row ? mapRoute(row) : null;
    },
    listRoutes: () => (routeList.all() as Array<Record<string, unknown>>).map(mapRoute),
    deleteRoute: (taskType) => {
      routeDelete.run(taskType);
    },
    deleteRoutesByProvider: (providerId) => {
      routeDeleteByProvider.run(providerId);
    },
  };
}

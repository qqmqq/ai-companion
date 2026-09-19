import type { ModelBinding } from "../core/ports/task-llm.ts";
import type { ModelRouter } from "../core/ports/model-router.ts";
import type { ModelConfigStore } from "../core/ports/model-config.ts";
import type { LLMProvider } from "../core/ports/llm-provider.ts";
import type { Logger } from "../core/ports/logger.ts";
import type { ProviderConfig } from "../core/model/usage.ts";
import type { TaskTier, TaskType } from "../core/model/task.ts";
import { DomainError } from "../core/model/errors.ts";

/** 任务的默认档位：没有显式路由时的兜底策略。 */
export const DEFAULT_TASK_TIER: Record<TaskType, TaskTier> = {
  chat: "standard",
  memory_extraction: "cheap",
  summarization: "cheap",
  context_compression: "cheap",
  emotion_analysis: "cheap",
  // 写角色设定是要给人看的成品，用跟聊天同档的模型
  character_draft: "standard",
  reasoning: "advanced",
  agent: "advanced",
  proactive: "cheap",
  translation: "cheap",
  embedding: "cheap",
};

export const TIER_ORDER: TaskTier[] = ["cheap", "standard", "advanced"];

/** 只要能被按 id 查询即可（注册表或测试假对象都满足）。 */
export interface ProviderLookup {
  get(id: string): LLMProvider | undefined;
}

export interface ModelRouterDeps {
  config: ModelConfigStore;
  providers: ProviderLookup;
  logger: Logger;
  /** 档位 → provider id 的偏好顺序（来自配置，可空） */
  tierPreferences?: Partial<Record<TaskTier, string[]>>;
}

function providerTier(config: ProviderConfig): TaskTier {
  if (config.id.includes("advanced") || config.defaultModel.includes("large")) return "advanced";
  if (config.id.includes("cheap") || config.defaultModel.includes("mini")) return "cheap";
  return "standard";
}

/**
 * 模型路由：显式路由优先，其次按档位匹配，最后是第一个可用 provider。
 * 任何一次选择都能被解释（log 里带 reason），便于排查"为什么用了贵的模型"。
 */
export function createModelRouter(deps: ModelRouterDeps): ModelRouter {
  const pickByTier = (task: TaskType, providers: ProviderConfig[]): { config: ProviderConfig; reason: string } | null => {
    const tier = DEFAULT_TASK_TIER[task];
    const preferred = deps.tierPreferences?.[tier] ?? [];
    for (const id of preferred) {
      const hit = providers.find((p) => p.id === id);
      if (hit !== undefined) return { config: hit, reason: `tier:${tier}:preferred` };
    }
    /**
     * 同档位里优先**用户真正配置的** provider：内置 echo 占位模型只在没有别的可用时才该出场，
     * 否则用户配好了 API 也会被占位模型接手。
     */
    const sameTier = providers
      .filter((p) => providerTier(p) === tier)
      .sort((a, b) => Number(a.kind === "echo") - Number(b.kind === "echo"));
    if (sameTier[0] !== undefined) return { config: sameTier[0], reason: `tier:${tier}` };
    if (providers[0] !== undefined) return { config: providers[0], reason: "fallback:first-enabled" };
    return null;
  };

  const resolveOrNull = (task: TaskType): ModelBinding | null => {
    const providers = deps.config
      .listProviders()
      .filter((config) => config.enabled && deps.providers.get(config.id) !== undefined);
    const route = deps.config.getRoute(task);

    if (route !== null && route.providerId !== null) {
      const routed = providers.find((config) => config.id === route.providerId);
      if (routed !== undefined) {
        return {
          taskType: task,
          providerId: routed.id,
          model: route.model ?? routed.defaultModel,
        };
      }
      deps.logger.warn("model route points to an unavailable provider; falling back", {
        task,
        providerId: route.providerId,
      });
    }

    const picked = pickByTier(task, providers);
    if (picked === null) return null;
    /**
     * 兜底分支里**不能**沿用一条指向别的 provider 的路由的 model。
     * 真实事故：chat 曾路由到 echo/echo-1，后来 echo 被删掉、只留下真实 provider，
     * 这里把 route.model = "echo-1" 发给了真实 API，用户配的模型永远用不上。
     * 只有当路由本来就指向被选中的 provider（或没指定 provider）时，它的 model 才有效。
     */
    const routeAppliesToPicked = route !== null && (route.providerId === null || route.providerId === picked.config.id);
    return {
      taskType: task,
      providerId: picked.config.id,
      model: (routeAppliesToPicked ? route.model : null) ?? picked.config.defaultModel,
    };
  };

  /** 一个能用的模型都没有：这是配置问题 —— 用一句人话告诉用户去哪儿配 */
  const resolve = (task: TaskType): ModelBinding => {
    const binding = resolveOrNull(task);
    if (binding !== null) return binding;
    throw new DomainError(
      "channel_unavailable",
      "还没有可用的模型：去「模型设置」加一个 Provider（或用「接入助手」配好反代），再把任务指向它。",
      { details: { task } },
    );
  };

  return {
    resolve,
    resolveOrNull,
    listRoutes: () => {
      const bindings: ModelBinding[] = [];
      for (const route of deps.config.listRoutes()) {
        const binding = resolveOrNull(route.taskType);
        if (binding !== null) bindings.push(binding);
      }
      return bindings;
    },
  };
}
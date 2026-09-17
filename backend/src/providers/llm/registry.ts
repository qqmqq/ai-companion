import type { LLMProvider, ModelInfo } from "../../core/ports/llm-provider.ts";
import type { CredentialStore } from "../../core/ports/credential-store.ts";
import type { ProviderConfig } from "../../core/model/usage.ts";
import type { Logger } from "../../core/ports/logger.ts";
import { createOpenAICompatibleProvider } from "./openai-compatible.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createEchoProvider } from "./echo-provider.ts";
import { ProviderError } from "../../core/model/provider-error.ts";

export interface LLMProviderRegistry {
  get(id: string): LLMProvider | undefined;
  list(): LLMProvider[];
  /** 带缓存的能力/计费信息查询（用于成本估算与上下文预算） */
  modelInfo(providerId: string, model: string): ModelInfo | null;
  refreshModelInfo(providerId: string): Promise<ModelInfo[]>;
}

/** 可在运行时重建的注册表：设置页改了 provider 配置后无需重启进程。 */
export interface MutableProviderRegistry extends LLMProviderRegistry {
  rebuild(configs: ProviderConfig[]): Promise<void>;
}

export interface BuildRegistryDeps {
  configs: ProviderConfig[];
  credentials: CredentialStore;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * 按数据库配置构造 Provider 实例。
 * 密钥从 CredentialStore 解密取得，只存在于内存中的 provider 实例里，绝不进入 Core 或 API 输出。
 */
export async function createProviderRegistry(deps: BuildRegistryDeps): Promise<MutableProviderRegistry> {
  const providers = new Map<string, LLMProvider>();
  const modelCache = new Map<string, ModelInfo[]>();
  const fetchImpl = deps.fetchImpl;

  async function build(configs: ProviderConfig[]): Promise<void> {
    providers.clear();
    modelCache.clear();

    for (const config of configs) {
      if (!config.enabled) continue;
      if (config.kind === "echo") {
        providers.set(config.id, createEchoProvider());
        continue;
      }
      let apiKey: string | null = null;
      if (config.requiresCredential && config.credentialRef !== null) {
        const secret = await deps.credentials.getSecret(config.credentialRef);
        apiKey = typeof secret?.apiKey === "string" ? secret.apiKey : null;
        if (apiKey === null) {
          deps.logger.warn("provider enabled but credential missing; skipping", { providerId: config.id });
          continue;
        }
      }
      if (config.kind === "openai-compatible") {
        providers.set(
          config.id,
          createOpenAICompatibleProvider({
            id: config.id,
            baseUrl: config.baseUrl,
            model: config.defaultModel,
            apiKey,
            timeoutMs: config.timeoutMs,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          }),
        );
      } else if (config.kind === "ollama") {
        providers.set(
          config.id,
          createOllamaProvider({
            id: config.id,
            baseUrl: config.baseUrl,
            model: config.defaultModel,
            timeoutMs: config.timeoutMs,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          }),
        );
      }
    }

    if (providers.size === 0) {
      deps.logger.warn("no configured provider available; falling back to built-in echo provider");
      providers.set("echo", createEchoProvider());
    }
  }

  await build(deps.configs);

  return {
    get: (id) => providers.get(id),
    list: () => [...providers.values()],
    modelInfo: (providerId, model) => {
      const cached = modelCache.get(providerId);
      if (cached === undefined) return null;
      return cached.find((info) => info.id === model) ?? null;
    },
    refreshModelInfo: async (providerId) => {
      const provider = providers.get(providerId);
      if (provider === undefined) {
        throw new ProviderError(`provider ${providerId} 未注册`, {
          providerId,
          kind: "model_unavailable",
          httpStatus: null,
          retryable: false,
        });
      }
      const models = await provider.listModels();
      modelCache.set(providerId, models);
      return models;
    },
    rebuild: build,
  };
}

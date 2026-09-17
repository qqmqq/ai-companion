import type { AsrProvider, AsrProviderRegistry } from "../../core/ports/asr.ts";
import type { CredentialStore } from "../../core/ports/credential-store.ts";
import type { ProviderConfig } from "../../core/model/usage.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";
import { createOpenAiCompatibleAsrProvider } from "./openai-compatible-asr.ts";
import { createEchoAsrProvider } from "./echo-asr.ts";

/**
 * ASR Provider 注册表（Phase 4.5-D3）。
 *
 * 复用既有的 ProviderConfig 配置来源（与 LLM 同一个 providers 表 / 同一套凭据规则）：
 * - kind = "echo" → 确定性占位 Provider（零配置、零网络，测试与首次体验用）
 * - kind = "openai-compatible" → OpenAI 兼容的 /audio/transcriptions
 * - kind = "ollama" → 目前的 ollama 没有转写端点，因此**不注册**（配置里选了它会得到明确的未配置错误）
 *
 * 密钥从 CredentialStore 解密取得，只存在于 Provider 实例内部，绝不进入 Core、日志或 API 输出。
 */

export interface AsrRegistryDeps {
  configs: ProviderConfig[];
  credentials: CredentialStore;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** 可选：为某个 provider id 覆盖模型（来自 asr.model 设置） */
  modelOverride?: string | null;
}

export interface MutableAsrRegistry extends AsrProviderRegistry {
  rebuild(configs: ProviderConfig[], modelOverride?: string | null): Promise<void>;
}

export async function createAsrRegistry(deps: AsrRegistryDeps): Promise<MutableAsrRegistry> {
  const providers = new Map<string, AsrProvider>();

  async function build(configs: ProviderConfig[], modelOverride?: string | null): Promise<void> {
    providers.clear();
    for (const config of configs) {
      if (!config.enabled) continue;
      const model = modelOverride !== null && modelOverride !== undefined && modelOverride.length > 0 ? modelOverride : config.defaultModel;
      if (config.kind === "echo") {
        providers.set(config.id, createEchoAsrProvider({ id: config.id, model, logger: deps.logger }));
        continue;
      }
      if (config.kind !== "openai-compatible") continue;

      let apiKey: string | null = null;
      if (config.requiresCredential && config.credentialRef !== null) {
        const secret = await deps.credentials.getSecret(config.credentialRef);
        apiKey = typeof secret?.apiKey === "string" ? secret.apiKey : null;
        if (apiKey === null) {
          deps.logger.warn("asr provider enabled but credential missing; skipping", { providerId: config.id });
          continue;
        }
      }
      providers.set(
        config.id,
        createOpenAiCompatibleAsrProvider({
          id: config.id,
          baseUrl: config.baseUrl,
          model,
          apiKey,
          timeoutMs: config.timeoutMs,
          logger: deps.logger,
          clock: deps.clock,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        }),
      );
    }
  }

  await build(deps.configs, deps.modelOverride);

  return {
    get: (id) => providers.get(id),
    list: () => [...providers.values()],
    rebuild: build,
  };
}

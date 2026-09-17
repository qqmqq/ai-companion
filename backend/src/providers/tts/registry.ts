import type { TtsProvider, TtsProviderRegistry } from "../../core/ports/tts.ts";
import type { CredentialStore } from "../../core/ports/credential-store.ts";
import type { ProviderConfig } from "../../core/model/usage.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";
import { createOpenAiCompatibleTtsProvider } from "./openai-compatible-tts.ts";
import { createEchoTtsProvider } from "./echo-tts.ts";

/**
 * TTS Provider 注册表（Phase 4.5-D4）。
 *
 * 与 ASR 完全对称：复用既有的 ProviderConfig 与加密凭据规则，独立注册表。
 * - kind = "echo" → 确定性占位（零配置/零网络）
 * - kind = "openai-compatible" → /audio/speech
 * - 其它 kind（例如 ollama）当前没有 TTS 端点 → 不注册
 */

export interface TtsRegistryDeps {
  configs: ProviderConfig[];
  credentials: CredentialStore;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** 覆盖模型（来自 tts.model 设置） */
  modelOverride?: string | null;
  /** 默认音色（来自 tts.voice 设置） */
  voiceOverride?: string | null;
}

export interface MutableTtsRegistry extends TtsProviderRegistry {
  rebuild(configs: ProviderConfig[], modelOverride?: string | null, voiceOverride?: string | null): Promise<void>;
}

export async function createTtsRegistry(deps: TtsRegistryDeps): Promise<MutableTtsRegistry> {
  const providers = new Map<string, TtsProvider>();

  async function build(configs: ProviderConfig[], modelOverride?: string | null, voiceOverride?: string | null): Promise<void> {
    providers.clear();
    for (const config of configs) {
      if (!config.enabled) continue;
      const model = modelOverride !== null && modelOverride !== undefined && modelOverride.length > 0 ? modelOverride : config.defaultModel;
      const voice = voiceOverride !== null && voiceOverride !== undefined && voiceOverride.length > 0 ? voiceOverride : null;
      if (config.kind === "echo") {
        providers.set(config.id, createEchoTtsProvider({ id: config.id, model, ...(voice === null ? {} : { voice }), logger: deps.logger }));
        continue;
      }
      if (config.kind !== "openai-compatible") continue;

      let apiKey: string | null = null;
      if (config.requiresCredential && config.credentialRef !== null) {
        const secret = await deps.credentials.getSecret(config.credentialRef);
        apiKey = typeof secret?.apiKey === "string" ? secret.apiKey : null;
        if (apiKey === null) {
          deps.logger.warn("tts provider enabled but credential missing; skipping", { providerId: config.id });
          continue;
        }
      }
      providers.set(
        config.id,
        createOpenAiCompatibleTtsProvider({
          id: config.id,
          baseUrl: config.baseUrl,
          model,
          voice,
          apiKey,
          timeoutMs: config.timeoutMs,
          logger: deps.logger,
          clock: deps.clock,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        }),
      );
    }
  }

  await build(deps.configs, deps.modelOverride, deps.voiceOverride);

  return {
    get: (id) => providers.get(id),
    list: () => [...providers.values()],
    rebuild: build,
  };
}

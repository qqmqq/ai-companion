import type {
  ChatDelta,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ModelInfo,
} from "../../core/ports/llm-provider.ts";
import { ProviderError } from "../../core/model/provider-error.ts";
import { iterateLines, requestJson, requestText, type FetchLike } from "../http.ts";

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  model: string;
  /** 没有密钥的本地服务传 null */
  apiKey: string | null;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  /** 已知模型的计费信息（可选）；未知时用量记录里成本为 NULL */
  models?: Array<Partial<ModelInfo> & { id: string }>;
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * OpenAI 兼容 Provider：/v1/chat/completions。
 * 同一实现覆盖 OpenAI、OpenRouter、llama.cpp server、vLLM、LM Studio 等。
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): LLMProvider {
  const root = options.baseUrl.replace(/\/+$/, "");
  const headers = (): Record<string, string> => {
    const base: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey !== null && options.apiKey.length > 0) base.authorization = `Bearer ${options.apiKey}`;
    return base;
  };
  const callOptions = (model: string, signal?: AbortSignal) => ({
    providerId: options.id,
    model,
    timeoutMs: options.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const knownModels = new Map<string, ModelInfo>();
  for (const model of options.models ?? []) {
    knownModels.set(model.id, {
      id: model.id,
      displayName: model.displayName ?? model.id,
      capabilities: {
        tools: model.capabilities?.tools ?? false,
        vision: model.capabilities?.vision ?? false,
        jsonMode: model.capabilities?.jsonMode ?? true,
        streaming: model.capabilities?.streaming ?? true,
        contextWindow: model.capabilities?.contextWindow ?? 8192,
        costPer1kInput: model.capabilities?.costPer1kInput ?? null,
        costPer1kOutput: model.capabilities?.costPer1kOutput ?? null,
      },
    });
  }

  return {
    id: options.id,
    kind: "openai-compatible",

    async listModels(): Promise<ModelInfo[]> {
      if (knownModels.size > 0) return [...knownModels.values()];
      try {
        const data = await requestJson<{ data?: Array<{ id: string }> }>(
          `${root}/v1/models`,
          { method: "GET", headers: headers() },
          callOptions(options.model),
        );
        const ids = (data.data ?? []).map((entry) => entry.id);
        if (ids.length === 0) throw new Error("empty model list");
        return ids.map((id) => ({
          id,
          displayName: id,
          capabilities: {
            tools: false,
            vision: false,
            jsonMode: true,
            streaming: true,
            contextWindow: 8192,
            costPer1kInput: null, // 服务端未声明价格 → 未知，不能假装是 0
            costPer1kOutput: null,
          },
        }));
      } catch (error) {
        // 只有"服务没有 /v1/models 这个端点"才可以退回默认模型；
        // 网络不通 / 超时 / 鉴权失败必须暴露出去，否则死掉的服务会被误判为健康。
        if (error instanceof ProviderError) {
          const tolerable: string[] = ["model_unavailable", "invalid_response"];
          if (!tolerable.includes(error.providerKind)) throw error;
        }
        return [
          {
            id: options.model,
            displayName: options.model,
            capabilities: {
              tools: false,
              vision: false,
              jsonMode: true,
              streaming: true,
              contextWindow: 8192,
              costPer1kInput: 0,
              costPer1kOutput: 0,
            },
          },
        ];
      }
    },

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body = {
        model: request.model || options.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      };
      const data = await requestJson<{
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(
        `${root}/v1/chat/completions`,
        { method: "POST", headers: headers(), body: JSON.stringify(body) },
        callOptions(body.model, request.signal),
      );
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("响应缺少 choices[0].message.content", {
          providerId: options.id,
          kind: "invalid_response",
          httpStatus: null,
          retryable: false,
          model: body.model,
        });
      }
      const finish = data.choices?.[0]?.finish_reason;
      return {
        text,
        model: body.model,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? null,
          completionTokens: data.usage?.completion_tokens ?? null,
        },
        finishReason: finish === "length" ? "length" : "stop",
      };
    },

    async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
      const model = request.model || options.model;
      const body = {
        model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      };
      const { response } = await requestText(
        `${root}/v1/chat/completions`,
        { method: "POST", headers: headers(), body: JSON.stringify(body) },
        callOptions(model, request.signal),
      );
      let finalUsage: { promptTokens: number | null; completionTokens: number | null } | null = null;
      for await (const line of iterateLines(response, callOptions(model))) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield { text: "", done: true, usage: finalUsage };
          return;
        }
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          continue; // 流里出现非 JSON 噪声时跳过，不中断整段回复
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          finalUsage = {
            promptTokens: chunk.usage.prompt_tokens ?? null,
            completionTokens: chunk.usage.completion_tokens ?? null,
          };
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) yield { text: delta, done: false };
      }
      yield { text: "", done: true, usage: finalUsage };
    },
  };
}
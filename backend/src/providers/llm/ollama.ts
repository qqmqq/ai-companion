import type {
  ChatDelta,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ModelInfo,
} from "../../core/ports/llm-provider.ts";
import { ProviderError } from "../../core/model/provider-error.ts";
import { iterateLines, requestJson, requestText, type FetchLike } from "../http.ts";

export interface OllamaOptions {
  id: string;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/** Ollama Provider：/api/chat（NDJSON 流）。默认本地 11434，可配置。 */
export function createOllamaProvider(options: OllamaOptions): LLMProvider {
  const root = (options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const callOptions = (model: string, signal?: AbortSignal) => ({
    providerId: options.id,
    model,
    timeoutMs: options.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return {
    id: options.id,
    kind: "ollama",

    async listModels(): Promise<ModelInfo[]> {
      try {
        const data = await requestJson<{ models?: Array<{ name: string }> }>(
          `${root}/api/tags`,
          { method: "GET" },
          callOptions(options.model),
        );
        const names = (data.models ?? []).map((m) => m.name);
        if (names.length === 0) throw new Error("empty tags");
        return names.map((name) => ({
          id: name,
          displayName: name,
          capabilities: {
            tools: false,
            vision: false,
            jsonMode: true,
            streaming: true,
            contextWindow: 8192,
            costPer1kInput: 0, // 本地推理：成本为 0，不是 NULL
            costPer1kOutput: 0,
          },
        }));
      } catch {
        return [
          {
            id: options.model,
            displayName: `${options.model} (ollama)`,
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
      const model = request.model || options.model;
      const data = await requestJson<OllamaChatResponse>(
        `${root}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            stream: false,
            ...(request.temperature === undefined
              ? {}
              : { options: { temperature: request.temperature } }),
          }),
        },
        callOptions(model, request.signal),
      );
      if (data.error !== undefined) {
        throw new ProviderError(`Ollama 错误: ${data.error}`, {
          providerId: options.id,
          kind: "invalid_response",
          httpStatus: null,
          retryable: false,
          model,
        });
      }
      const text = data.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("Ollama 响应缺少 message.content", {
          providerId: options.id,
          kind: "invalid_response",
          httpStatus: null,
          retryable: false,
          model,
        });
      }
      return {
        text,
        model,
        usage: {
          promptTokens: data.prompt_eval_count ?? null,
          completionTokens: data.eval_count ?? null,
        },
        finishReason: "stop",
      };
    },

    async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
      const model = request.model || options.model;
      const { response } = await requestText(
        `${root}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
          }),
        },
        callOptions(model, request.signal),
      );
      for await (const line of iterateLines(response, callOptions(model))) {
        let chunk: OllamaChatResponse;
        try {
          chunk = JSON.parse(line) as OllamaChatResponse;
        } catch {
          continue;
        }
        if (chunk.error !== undefined) {
          throw new ProviderError(`Ollama 流错误: ${chunk.error}`, {
            providerId: options.id,
            kind: "invalid_response",
            httpStatus: null,
            retryable: false,
            model,
          });
        }
        const delta = chunk.message?.content;
        if (typeof delta === "string" && delta.length > 0) yield { text: delta, done: false };
        if (chunk.done === true) {
          yield {
            text: "",
            done: true,
            usage: { promptTokens: chunk.prompt_eval_count ?? null, completionTokens: chunk.eval_count ?? null },
          };
          return;
        }
      }
      yield { text: "", done: true };
    },
  };
}
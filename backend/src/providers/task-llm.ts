import type { ChatDelta, ChatRequest, ChatResponse, LLMProvider } from "../core/ports/llm-provider.ts";
import type { ModelBinding, TaskCallContext, TaskLLM } from "../core/ports/task-llm.ts";
import type { ModelRouter } from "../core/ports/model-router.ts";
import type { LLMProviderRegistry } from "./llm/registry.ts";
import type { ModelUsageRepository } from "../core/ports/repositories.phase2.ts";
import type { Logger } from "../core/ports/logger.ts";
import type { TaskType } from "../core/model/task.ts";
import { ProviderError } from "../core/model/provider-error.ts";
import { uuidv7 } from "../util/ids.ts";
import { nowIso } from "../util/time.ts";

export interface TaskLLMDeps {
  router: ModelRouter;
  providers: LLMProviderRegistry;
  usage: ModelUsageRepository;
  logger: Logger;
  now?: () => number;
}

export interface ActiveRun {
  runId: string;
  controller: AbortController;
  startedAt: string;
}

/**
 * TaskLLM：Core 使用模型的唯一入口。
 * 职责：路由 → 调用 → 计时 → 记录 model_usage → 错误归一化。
 */
export function createTaskLLM(deps: TaskLLMDeps) {
  const now = deps.now ?? (() => Date.now());
  const runs = new Map<string, ActiveRun>();

  function providerFor(binding: ModelBinding): LLMProvider {
    const provider = deps.providers.get(binding.providerId);
    if (provider === undefined) {
      throw new ProviderError(`provider ${binding.providerId} 未注册`, {
        providerId: binding.providerId,
        kind: "model_unavailable",
        httpStatus: null,
        retryable: false,
        model: binding.model,
      });
    }
    return provider;
  }

  function record(input: {
    binding: ModelBinding;
    context?: TaskCallContext;
    latencyMs: number;
    usage: { promptTokens: number | null; completionTokens: number | null } | null;
    success: boolean;
    errorKind: string | null;
  }): void {
    let estimatedCost: number | null = null;
    if (input.usage !== null && (input.usage.promptTokens !== null || input.usage.completionTokens !== null)) {
      const info = deps.providers.modelInfo(input.binding.providerId, input.binding.model);
      const costIn = info?.capabilities.costPer1kInput ?? null;
      const costOut = info?.capabilities.costPer1kOutput ?? null;
      // 价格未知 → 记为 NULL，而不是 0（0 会被误读成"免费"）
      if (costIn !== null && costOut !== null) {
        estimatedCost =
          ((input.usage.promptTokens ?? 0) / 1000) * costIn + ((input.usage.completionTokens ?? 0) / 1000) * costOut;
      }
    }
    try {
      deps.usage.insert(
        uuidv7(),
        {
          providerId: input.binding.providerId,
          model: input.binding.model,
          taskType: input.binding.taskType,
          conversationId: input.context?.conversationId ?? null,
          messageId: input.context?.messageId ?? null,
          inputTokens: input.usage?.promptTokens ?? null,
          outputTokens: input.usage?.completionTokens ?? null,
          estimatedCost,
          latencyMs: input.latencyMs,
          success: input.success,
          errorKind: input.errorKind,
        },
        nowIso(),
      );
    } catch (error) {
      deps.logger.warn("failed to record model usage", { error: (error as Error).message });
    }
  }

  const taskLLM = {
    resolve: (task: TaskType): ModelBinding => deps.router.resolve(task),

    async chat(task: TaskType, request: ChatRequest, context?: TaskCallContext): Promise<ChatResponse> {
      const binding = deps.router.resolve(task);
      const provider = providerFor(binding);
      const started = now();
      try {
        const response = await provider.chat({ ...request, model: binding.model, ...(context?.signal === undefined ? {} : { signal: context.signal }) });
        record({
          binding,
          context,
          latencyMs: now() - started,
          usage: response.usage,
          success: true,
          errorKind: null,
        });
        return response;
      } catch (error) {
        const normalized = normalizeError(error, binding);
        record({
          binding,
          context,
          latencyMs: now() - started,
          usage: null,
          success: false,
          errorKind: normalized.providerKind,
        });
        throw normalized;
      }
    },

    stream(task: TaskType, request: ChatRequest, context?: TaskCallContext): AsyncIterable<ChatDelta> {
      const binding = deps.router.resolve(task);
      const provider = providerFor(binding);
      const started = now();
      const stream = provider.stream({ ...request, model: binding.model, ...(context?.signal === undefined ? {} : { signal: context.signal }) });

      async function* guarded(): AsyncIterable<ChatDelta> {
        let streamUsage: { promptTokens: number | null; completionTokens: number | null } | null = null;
        let failure: ProviderError | null = null;
        try {
          for await (const chunk of stream) {
            if (chunk.usage !== undefined && chunk.usage !== null) streamUsage = chunk.usage;
            yield chunk;
          }
        } catch (error) {
          failure = normalizeError(error, binding);
          throw failure;
        } finally {
          // finally：即使消费方提前 break（例如读到 done 就停），用量也必须记录，不能丢账
          record({
            binding,
            context,
            latencyMs: now() - started,
            usage: failure === null ? streamUsage : null,
            success: failure === null,
            errorKind: failure?.providerKind ?? null,
          });
        }
      }

      return guarded();
    },

    registerRun(runId: string): ActiveRun {
      const run: ActiveRun = { runId, controller: new AbortController(), startedAt: nowIso() };
      runs.set(runId, run);
      return run;
    },
    abortRun(runId: string): boolean {
      const run = runs.get(runId);
      if (run === undefined) return false;
      run.controller.abort();
      runs.delete(runId);
      return true;
    },
    finishRun(runId: string): void {
      runs.delete(runId);
    },
    activeRuns(): ActiveRun[] {
      return [...runs.values()];
    },
  };

  return taskLLM;
}

export function normalizeError(error: unknown, binding: ModelBinding): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError((error as Error)?.message ?? "unknown provider failure", {
    providerId: binding.providerId,
    kind: "unknown",
    httpStatus: null,
    retryable: false,
    model: binding.model,
  }, { cause: error });
}

export type TaskLLMService = ReturnType<typeof createTaskLLM>;
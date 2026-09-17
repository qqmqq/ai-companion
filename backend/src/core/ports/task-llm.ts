import type { ChatDelta, ChatRequest, ChatResponse } from "./llm-provider.ts";
import type { TaskType } from "../model/task.ts";

export interface ModelBinding {
  taskType: TaskType;
  providerId: string;
  model: string;
}

export interface TaskCallContext {
  conversationId?: string | null;
  messageId?: string | null;
  signal?: AbortSignal;
}

/**
 * Core 使用模型的唯一入口。
 * 业务代码只说"我要做 chat / memory_extraction / summarization"，
 * provider 选择、用量记录、错误归一化都在实现侧完成。
 */
export interface TaskLLM {
  resolve(task: TaskType): ModelBinding;
  chat(task: TaskType, request: ChatRequest, context?: TaskCallContext): Promise<ChatResponse>;
  stream(task: TaskType, request: ChatRequest, context?: TaskCallContext): AsyncIterable<ChatDelta>;
}

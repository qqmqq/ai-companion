export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  jsonMode: boolean;
  streaming: boolean;
  contextWindow: number;
  /** 未知价格用 null（绝不假装免费）；本地模型的确是 0。 */
  costPer1kInput: number | null;
  costPer1kOutput: number | null;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  capabilities: ModelCapabilities;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** 传播给上游 provider 的中止信号（客户端断开 / 用户取消） */
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

/** Provider 不返回 usage 时字段为 null —— 绝不伪造数字。 */
export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage: ChatUsage;
  finishReason: "stop" | "length" | "error";
}

export interface ChatDelta {
  text: string;
  done: boolean;
  /** 流式响应最后一帧可能带 usage；没有就是 null（不伪造） */
  usage?: ChatUsage | null;
}

/** Provider 只做"把消息发给模型并拿回文本"，不做记忆/上下文装配。 */
export interface LLMProvider {
  readonly id: string;
  readonly kind: string;
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatDelta>;
}

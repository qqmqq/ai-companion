import type { ChatDelta, ChatRequest, ChatResponse, LLMProvider, ModelInfo } from "../../core/ports/llm-provider.ts";

const MODEL: ModelInfo = {
  id: "echo-1",
  displayName: "Echo (本地占位实现)",
  capabilities: {
    tools: false,
    vision: false,
    jsonMode: false,
    streaming: true,
    contextWindow: 8192,
    costPer1kInput: 0,
    costPer1kOutput: 0,
  },
};

/**
 * 离线 Provider：让 Phase 1 的整条链路（渠道 → Core → 会话 → 回复 → 渠道）
 * 可以在没有 API Key、没有网络的情况下被测试与演示。
 * 它不做任何"智能"伪装：回复里明确标注自己是占位实现。
 */
export function createEchoProvider(): LLMProvider {
  const build = (request: ChatRequest): string => {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const systemLine = request.messages.find((m) => m.role === "system")?.content.split("\n")[0] ?? "";
    return [
      `（echo）我收到了：${lastUser?.content ?? "(空)"}`,
      systemLine.length > 0 ? `当前角色设定摘要：${systemLine}` : "",
      "提示：这是在未配置真实模型时的占位回复。",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  };

  return {
    id: "echo",
    kind: "builtin",
    async listModels(): Promise<ModelInfo[]> {
      return [MODEL];
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const text = build(request);
      return {
        text,
        model: request.model || MODEL.id,
        // 本地占位实现不产生真实 token 计费，返回 null 而不是 0
        usage: { promptTokens: null, completionTokens: null },
        finishReason: "stop",
      };
    },
    async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
      const text = build(request);
      for (const chunk of text.match(/.{1,12}/gs) ?? []) {
        yield { text: chunk, done: false };
      }
      yield { text: "", done: true };
    },
  };
}

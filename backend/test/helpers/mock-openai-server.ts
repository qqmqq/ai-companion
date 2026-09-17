import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockOpenAIServer {
  baseUrl: string;
  requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }>;
  chatReply: string;
  extractionReply: string;
  summaryReply: string;
  /** 角色工坊（补全 / 改设定）的回复；可在测试中途改，下一次请求就生效 */
  studioReply: string;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    request.on("end", () => resolve(data));
  });
}

/**
 * 一个最小的 OpenAI 兼容服务，用于在不依赖任何真实 API Key 的前提下，
 * 端到端验证"真实 Provider HTTP 代码路径"：鉴权头、非流式、SSE 流式、usage。
 */
export async function startMockOpenAIServer(options: {
  chatReply?: string;
  extractionReply?: string;
  summaryReply?: string;
  studioReply?: string;
  apiKey?: string;
} = {}): Promise<MockOpenAIServer> {
  const state: MockOpenAIServer = {
    baseUrl: "",
    requests: [],
    chatReply: options.chatReply ?? "（mock）我们今天聊得很开心。",
    extractionReply:
      options.extractionReply ??
      JSON.stringify([{ scope: "user", type: "preference", content: "用户喜欢深烘咖啡豆", importance: 0.8, confidence: 0.9, tags: ["咖啡"] }]),
    summaryReply: options.summaryReply ?? "用户与角色聊了咖啡日常。",
    studioReply:
      options.studioReply ??
      JSON.stringify({
        definition: {
          name: "沈砚",
          description: "旧书店的店主，认识用户很多年了。",
          personality: "话不多，句子短，习惯用陈述句收尾",
          scenario: "南方小城的旧书店，雨季",
          systemPrompt: "保持冷淡但克制的语气。",
          firstMessage: "来了。书在里屋。",
        },
        reply: "我把性格写成了话少、句子短的样子。",
      }),
    close: async () => {},
  };
  const expectedKey = options.apiKey ?? null;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = request.url ?? "";
      const raw = await readBody(request);
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      state.requests.push({ url, authorization: request.headers.authorization ?? null, body });

      const send = (status: number, payload: unknown, contentType = "application/json"): void => {
        response.writeHead(status, { "content-type": contentType });
        response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };

      if (url.endsWith("/v1/models")) {
        send(200, { data: [{ id: "mock-chat" }, { id: "mock-cheap" }] });
        return;
      }

      if (!url.endsWith("/v1/chat/completions")) {
        send(404, { error: { message: "unknown route" } });
        return;
      }

      if (expectedKey !== null && request.headers.authorization !== `Bearer ${expectedKey}`) {
        send(401, { error: { message: "invalid api key" } });
        return;
      }

      const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role: string; content: string }>) : [];
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const reply = system.includes("记忆抽取器")
        ? state.extractionReply
        : system.includes("对话压缩器")
          ? state.summaryReply
          : system.includes("角色设定补全器")
            ? state.studioReply
            : state.chatReply;

      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = reply.match(/[\s\S]{1,7}/g) ?? [];
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 42, completion_tokens: 17 },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      send(200, {
        choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

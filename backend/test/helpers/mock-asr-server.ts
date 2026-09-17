import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 最小可用的"OpenAI 兼容语音转写"mock 服务（Phase 4.5-D3）。
 *
 * 只做两件事：
 * - POST /audio/transcriptions：解析 multipart，记录收到的字段与音频字节，按配置返回 JSON；
 * - 不做任何真实识别（它不是 ASR），因此测试里预期得到的文本就是我们配置的文本。
 *
 * 这样测试既不依赖网络，也不依赖任何真实 ASR 服务。
 */

export interface MockAsrConfig {
  /** 返回的识别文本（默认 "这是转写文本"） */
  transcription?: string;
  /** 是否返回 language / duration / confidence 字段（默认都不返回 = 只返回 text） */
  language?: string;
  durationSeconds?: number;
  confidence?: number;
  model?: string;
  /** 前 N 次请求返回错误（状态码由 failStatus 决定） */
  failTimes?: number;
  failStatus?: number;
  /** 返回 200 但文本为空（模拟"识别到空内容"） */
  emptyText?: boolean;
  /** 响应前延迟（用于 timeout 测试） */
  delayMs?: number;
  /** 返回非 JSON（用于 invalid_response 测试） */
  invalidJson?: boolean;
  /** 需要 Authorization 头（用于凭据测试）；不匹配时返回 401 */
  requiredApiKey?: string;
}

export interface MockAsrRequest {
  contentType: string | null;
  authorization: string | null;
  /** multipart 里出现的字段名 */
  fields: Record<string, string>;
  /** 音频字节长度与内容（用于断言"确实把音频发过去了"） */
  fileBytes: number;
  file: Buffer | null;
  fileName: string | null;
}

export interface MockAsrServer {
  baseUrl: string;
  requests: MockAsrRequest[];
  config: MockAsrConfig;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** 极简 multipart 解析：只提取我们关心的字段与最后一个文件段 */
function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; file: Buffer | null; fileName: string | null } {
  const fields: Record<string, string> = {};
  let file: Buffer | null = null;
  let fileName: string | null = null;
  const parts = body.toString("latin1").split("--" + boundary);
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const content = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (nameMatch === null) continue;
    const name = nameMatch[1]!;
    const fileMatch = /filename="([^"]*)"/.exec(headers);
    if (fileMatch !== null) {
      fileName = fileMatch[1]!.length > 0 ? fileMatch[1]! : null;
      file = Buffer.from(content, "latin1");
      continue;
    }
    fields[name] = content;
  }
  return { fields, file, fileName };
}

export async function startMockAsrServer(config: MockAsrConfig = {}): Promise<MockAsrServer> {
  const state: MockAsrServer = {
    baseUrl: "",
    requests: [],
    config: {
      transcription: config.transcription ?? "这是转写文本",
      ...(config.language === undefined ? {} : { language: config.language }),
      ...(config.durationSeconds === undefined ? {} : { durationSeconds: config.durationSeconds }),
      ...(config.confidence === undefined ? {} : { confidence: config.confidence }),
      ...(config.model === undefined ? {} : { model: config.model }),
      failTimes: config.failTimes ?? 0,
      failStatus: config.failStatus ?? 500,
      emptyText: config.emptyText ?? false,
      delayMs: config.delayMs ?? 0,
      invalidJson: config.invalidJson ?? false,
      ...(config.requiredApiKey === undefined ? {} : { requiredApiKey: config.requiredApiKey }),
    },
    close: async () => {},
  };

  let attempts = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const body = await readBody(request);
      const contentType = (request.headers["content-type"] ?? null) as string | null;
      const authorization = (request.headers.authorization ?? null) as string | null;

      if (!url.pathname.endsWith("/audio/transcriptions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }

      attempts += 1;
      const boundaryMatch = contentType === null ? null : /boundary=(.+)$/.exec(contentType);
      const parsed = boundaryMatch === null ? { fields: {}, file: null, fileName: null } : parseMultipart(body, boundaryMatch[1]!.trim());
      state.requests.push({
        contentType,
        authorization,
        fields: parsed.fields,
        fileBytes: parsed.file?.byteLength ?? 0,
        file: parsed.file,
        fileName: parsed.fileName,
      });

      if (state.config.requiredApiKey !== undefined && authorization !== "Bearer " + state.config.requiredApiKey) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      if (attempts <= (state.config.failTimes ?? 0)) {
        response.writeHead(state.config.failStatus ?? 500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "asr boom" } }));
        return;
      }
      if ((state.config.delayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, state.config.delayMs));

      if (state.config.invalidJson === true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("this is not json");
        return;
      }

      const payload: Record<string, unknown> = { text: state.config.emptyText === true ? "" : state.config.transcription };
      if (state.config.language !== undefined) payload.language = state.config.language;
      if (state.config.durationSeconds !== undefined) payload.duration = state.config.durationSeconds;
      if (state.config.confidence !== undefined) payload.confidence = state.config.confidence;
      if (state.config.model !== undefined) payload.model = state.config.model;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  state.baseUrl = "http://127.0.0.1:" + String(address.port);
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 最小可用的"OpenAI 兼容语音合成"mock 服务（Phase 4.5-D4）。
 *
 * \`POST /audio/speech\`：解析 JSON 请求体，按配置返回**音频字节**（默认是一小段真 WAV）。
 * 它不是语音合成：返回的字节就是配置里给的（或一段确定性生成的静音 WAV），
 * 这样测试既不依赖外网，也不依赖任何真实 TTS 服务。
 */

export interface MockTtsConfig {
  /** 返回的音频字节基（默认：44 字节 WAV 头 + 静音） */
  audio?: Uint8Array;
  /** 返回的 Content-Type（默认 audio/wav） */
  contentType?: string;
  /** 前 N 次请求返回错误 */
  failTimes?: number;
  failStatus?: number;
  /** 返回 200 但空音频 */
  emptyAudio?: boolean;
  /** 响应前延迟（毫秒），用于 timeout 测试 */
  delayMs?: number;
  /** 需要 Authorization；不匹配返回 401 */
  requiredApiKey?: string;
  /** 时长/采样率响应头（上游可选提供；不给就是不提供） */
  durationMsHeader?: number;
  sampleRateHeader?: number;
}

export interface MockTtsRequest {
  authorization: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

export interface MockTtsServer {
  baseUrl: string;
  requests: MockTtsRequest[];
  config: MockTtsConfig;
  close(): Promise<void>;
}

function silenceWav(samples = 2400): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export async function startMockTtsServer(config: MockTtsConfig = {}): Promise<MockTtsServer> {
  const state: MockTtsServer = {
    baseUrl: "",
    requests: [],
    config: {
      audio: config.audio ?? silenceWav(),
      contentType: config.contentType ?? "audio/wav",
      failTimes: config.failTimes ?? 0,
      failStatus: config.failStatus ?? 500,
      emptyAudio: config.emptyAudio ?? false,
      delayMs: config.delayMs ?? 0,
      ...(config.requiredApiKey === undefined ? {} : { requiredApiKey: config.requiredApiKey }),
      ...(config.durationMsHeader === undefined ? {} : { durationMsHeader: config.durationMsHeader }),
      ...(config.sampleRateHeader === undefined ? {} : { sampleRateHeader: config.sampleRateHeader }),
    },
    close: async () => {},
  };

  let attempts = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const raw = await readBody(request);
      const authorization = (request.headers.authorization ?? null) as string | null;
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }

      if (!url.pathname.endsWith("/audio/speech")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }

      attempts += 1;
      state.requests.push({ authorization, contentType: (request.headers["content-type"] ?? null) as string | null, body });

      if (state.config.requiredApiKey !== undefined && authorization !== "Bearer " + state.config.requiredApiKey) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      if (attempts <= (state.config.failTimes ?? 0)) {
        response.writeHead(state.config.failStatus ?? 500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "tts boom" } }));
        return;
      }
      if ((state.config.delayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, state.config.delayMs));

      const headers: Record<string, string> = { "content-type": state.config.contentType ?? "audio/wav" };
      if (state.config.durationMsHeader !== undefined) headers["x-audio-duration-ms"] = String(state.config.durationMsHeader);
      if (state.config.sampleRateHeader !== undefined) headers["x-audio-sample-rate"] = String(state.config.sampleRateHeader);
      response.writeHead(200, headers);
      response.end(state.config.emptyAudio === true ? Buffer.alloc(0) : Buffer.from(state.config.audio ?? silenceWav()));
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

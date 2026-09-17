import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockCdnConfig {
  /** 前 N 次上传失败（默认 500） */
  failUploadTimes?: number;
  uploadFailStatus?: number;
  /** 上传成功但不返回 x-encrypted-param 头 */
  omitUploadParamHeader?: boolean;
  /** 前 N 次下载失败 */
  failDownloadTimes?: number;
  downloadFailStatus?: number;
  /** 下载返回错误的 Content-Type（用于 MIME 校验失败测试） */
  downloadContentType?: string;
  /** 下载响应延迟（用于 timeout 测试） */
  downloadDelayMs?: number;
}

export interface MockCdnServer {
  baseUrl: string;
  uploads: Array<{ filekey: string | null; bytes: number; contentType: string | null }>;
  downloads: Array<{ param: string | null; bytes: number }>;
  /** 服务器保存的"密文"（按下载参数索引） */
  stored: Map<string, Buffer>;
  config: MockCdnConfig;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * 最小可用的微信媒体 CDN mock：
 * - POST /upload?encrypted_query_param=..&filekey=.. → 200 + x-encrypted-param
 * - GET  /download?encrypted_query_param=.. → 返回密文
 * 它只搬运字节，不做任何加解密 —— 加解密必须由被测代码完成。
 */
export async function startMockCdnServer(config: MockCdnConfig = {}): Promise<MockCdnServer> {
  const state: MockCdnServer = {
    baseUrl: "",
    uploads: [],
    downloads: [],
    stored: new Map(),
    config: {
      failUploadTimes: config.failUploadTimes ?? 0,
      uploadFailStatus: config.uploadFailStatus ?? 500,
      omitUploadParamHeader: config.omitUploadParamHeader ?? false,
      failDownloadTimes: config.failDownloadTimes ?? 0,
      downloadFailStatus: config.downloadFailStatus ?? 500,
      downloadContentType: config.downloadContentType ?? "application/octet-stream",
      downloadDelayMs: config.downloadDelayMs ?? 0,
    },
    close: async () => {},
  };

  let uploadAttempts = 0;
  let downloadAttempts = 0;
  let counter = 0;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const body = await readBody(request);

      if (url.pathname === "/upload") {
        uploadAttempts += 1;
        const filekey = url.searchParams.get("filekey");
        state.uploads.push({ filekey, bytes: body.byteLength, contentType: request.headers["content-type"] ?? null });
        if (uploadAttempts <= (state.config.failUploadTimes ?? 0)) {
          response.writeHead(state.config.uploadFailStatus ?? 500, { "content-type": "text/plain" });
          response.end("cdn boom");
          return;
        }
        counter += 1;
        const param = `dl-param-${counter}`;
        state.stored.set(param, body);
        const headers: Record<string, string> = { "content-type": "text/plain" };
        if (state.config.omitUploadParamHeader !== true) headers["x-encrypted-param"] = param;
        response.writeHead(200, headers);
        response.end("ok");
        return;
      }

      if (url.pathname === "/download") {
        downloadAttempts += 1;
        const param = url.searchParams.get("encrypted_query_param");
        const payload = param === null ? undefined : state.stored.get(param);
        state.downloads.push({ param, bytes: payload?.byteLength ?? 0 });
        if (downloadAttempts <= (state.config.failDownloadTimes ?? 0)) {
          response.writeHead(state.config.downloadFailStatus ?? 500, { "content-type": "text/plain" });
          response.end("cdn boom");
          return;
        }
        if (payload === undefined) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
          return;
        }
        if ((state.config.downloadDelayMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.config.downloadDelayMs));
        }
        response.writeHead(200, { "content-type": state.config.downloadContentType ?? "application/octet-stream" });
        response.end(payload);
        return;
      }

      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 一个最小可用的 ds-free-api 管理端替身：只实现接入助手会真正打到的接口，
 * 用来在没有任何真实反代、没有任何真实账号的情况下，端到端验证「一键写入」这条链路。
 *
 *   GET  /health              → 200（在不在）
 *   POST /admin/api/login     → 密码对给 token；没设过密码 403；密码错 401
 *   POST /admin/api/setup     → 只有没设过密码时才成功
 *   GET  /admin/api/config    → 需要 Bearer token，返回整份配置
 *   PUT  /admin/api/config    → 需要 Bearer token，写回并记录
 */
export interface MockDsFreeServer {
  baseUrl: string;
  /** 反代里当前的配置（就是 PUT 上来的那份） */
  config: Record<string, unknown>;
  /** 被写进来的账号与密钥，方便断言 */
  accountsWritten: Array<Record<string, unknown>>;
  apiKeysWritten: Array<Record<string, unknown>>;
  putCount: number;
  setupCount: number;
  loginCount: number;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); });
    request.on("end", () => resolve(data));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

export async function startMockDsFreeServer(options: { adminPassword?: string | null; seedConfig?: Record<string, unknown> } = {}): Promise<MockDsFreeServer> {
  let adminPassword = options.adminPassword ?? null;
  const token = "test-admin-token";
  const state: MockDsFreeServer = {
    baseUrl: "",
    config: options.seedConfig ?? { ds_core: { accounts: [] }, api_keys: [] },
    accountsWritten: [],
    apiKeysWritten: [],
    putCount: 0,
    setupCount: 0,
    loginCount: 0,
    close: async () => {},
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const method = request.method ?? "GET";
      if (method === "GET" && url === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (method === "POST" && (url === "/admin/api/login" || url === "/admin/api/setup")) {
        const body = JSON.parse((await readBody(request)) || "{}") as { password?: unknown };
        const password = typeof body.password === "string" ? body.password : "";
        if (url.endsWith("/login")) {
          state.loginCount += 1;
          if (adminPassword === null) { json(response, 403, { error: { message: "admin password is not set" } }); return; }
          if (password !== adminPassword) { json(response, 401, { error: { message: "invalid password" } }); return; }
          json(response, 200, { token });
          return;
        }
        state.setupCount += 1;
        if (adminPassword !== null) { json(response, 403, { error: { message: "already set" } }); return; }
        adminPassword = password;
        json(response, 200, { token });
        return;
      }
      if (url === "/admin/api/config") {
        if ((request.headers.authorization ?? "") !== "Bearer " + token) { json(response, 401, { error: { message: "invalid token" } }); return; }
        if (method === "GET") { json(response, 200, state.config); return; }
        if (method === "PUT") {
          const next = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
          state.config = next;
          state.putCount += 1;
          const accounts = ((next.ds_core as { accounts?: Array<Record<string, unknown>> } | undefined)?.accounts ?? []);
          state.accountsWritten = accounts;
          state.apiKeysWritten = (next.api_keys as Array<Record<string, unknown>> | undefined) ?? [];
          json(response, 200, { ok: true });
          return;
        }
      }
      json(response, 404, { error: { message: "not found: " + method + " " + url } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  state.baseUrl = "http://127.0.0.1:" + String(address.port);
  state.close = async () => { await new Promise<void>((resolve) => server.close(() => resolve())); };
  return state;
}


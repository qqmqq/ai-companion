import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDatabase } from "./db.ts";
import { createFakeClock } from "./fake-clock.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createEventBus } from "../../src/app/events.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createChannelRepository } from "../../src/storage/repositories/channels.ts";
import { createCredentialRepository } from "../../src/storage/repositories/credentials.ts";
import { createSqliteCredentialStore } from "../../src/security/credential-store.ts";
import { inMemoryKeyProvider } from "../../src/security/key-provider.ts";
import { generateKey } from "../../src/security/crypto.ts";
import { createQQChannel, type QQChannel } from "../../src/channels/qq/channel.ts";
import { QQ_SETTINGS, QQ_TOKEN_BASE_URL } from "../../src/channels/qq/config.ts";

/**
 * QQ 渠道的测试装配：
 *   - 一个 mock QQ 服务（取 token / 网关地址 / 发消息），走真实 HTTP；
 *   - 一个假的 WebSocket 实现（不引依赖），用来驱动 HELLO / DISPATCH / close；
 *   - 真实 SQLite 的 settings + 加密凭据库。
 */

/** 假 WebSocket：记录发出去的帧，并允许测试手动投递下行帧 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  readonly url: string;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** 测试用：投递一帧下行数据 */
  emitMessage(frame: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) });
  }

  /** 测试用：模拟服务端关闭 */
  emitClose(code: number): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }

  lastFrame(): Record<string, unknown> | null {
    const raw = this.sent.at(-1);
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  }
}

export interface QQMockServer {
  baseUrl: string;
  /** 收到的发消息请求 */
  sent: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }>;
  tokenCalls: number;
  gatewayCalls: number;
  close(): Promise<void>;
}

export async function startMockQQServer(options: { token?: string; gatewayUrl?: string } = {}): Promise<QQMockServer> {
  const token = options.token ?? "token-qq-1";
  const state: QQMockServer = { baseUrl: "", sent: [], tokenCalls: 0, gatewayCalls: 0, close: async () => {} };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = request.url ?? "";
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (url.endsWith("/app/getAppAccessToken")) {
        state.tokenCalls += 1;
        send(200, { access_token: token, expires_in: 7200 });
        return;
      }
      if (url.endsWith("/gateway")) {
        state.gatewayCalls += 1;
        send(200, { url: options.gatewayUrl ?? "wss://gateway.test/" });
        return;
      }
      if (url.includes("/messages")) {
        state.sent.push({
          path: url,
          authorization: request.headers.authorization ?? null,
          body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        send(200, { id: "qq-msg-" + String(state.sent.length), timestamp: Date.now() });
        return;
      }
      send(404, { message: "unknown route " + url });
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

export interface QQStack {
  channel: QQChannel;
  server: QQMockServer;
  settings: ReturnType<typeof createSettingsRepository>;
  credentials: ReturnType<typeof createSqliteCredentialStore>;
  socket(): FakeWebSocket;
  inbound: Array<{ conversationId: string; text: string }>;
  close(): Promise<void>;
}

export async function createQQStack(options: { configure?: boolean } = {}): Promise<QQStack> {
  FakeWebSocket.instances = [];
  const server = await startMockQQServer();
  const db = createTestDatabase();
  const clock = createFakeClock();
  const logger = createLogger({ level: "error", sink: () => {} });
  const settings = createSettingsRepository(db);
  const accounts = createChannelRepository(db);
  const credentials = createSqliteCredentialStore({
    repository: createCredentialRepository(db),
    keyProvider: inMemoryKeyProvider(generateKey()),
    nowIso: () => clock.nowIso(),
  });
  const inbound: Array<{ conversationId: string; text: string }> = [];

  // 把两个域名指向 mock 服务；tokenBaseUrl 与 baseUrl 分开配，和真实环境一致
  settings.put(QQ_SETTINGS.tokenBaseUrl, server.baseUrl, clock.nowIso());
  settings.put(QQ_SETTINGS.baseUrl, server.baseUrl, clock.nowIso());
  if (options.configure !== false) {
    settings.put(QQ_SETTINGS.appId, "102000001", clock.nowIso());
    await credentials.putSecret("102000001", { clientSecret: "secret-qq-1" });
  }

  const channel = createQQChannel({
    logger,
    clock,
    events: createEventBus(),
    credentials,
    settings,
    accounts,
    userId: "u1",
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  channel.onInbound(async (message) => {
    const text = message.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join(" ");
    inbound.push({ conversationId: message.conversationId, text });
  });

  return {
    channel,
    server,
    settings,
    credentials,
    socket: () => {
      const socket = FakeWebSocket.instances.at(-1);
      if (socket === undefined) throw new Error("还没有建立 WebSocket 连接");
      return socket;
    },
    inbound,
    close: async () => {
      await channel.stop();
      await server.close();
    },
  };
}


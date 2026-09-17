import type { Logger } from "../../../core/ports/logger.ts";
import type { QQGatewayFrame } from "../types.ts";

/**
 * QQ 网关的 WebSocket 协议实现（官方 Bot API v2）。
 *
 * 只做协议层的事：拿 wss 地址 → 连接 → HELLO 后 IDENTIFY（或带 session 的 RESUME）→ 心跳 → 把 DISPATCH 事件交给上层。
 * 不做：token 缓存（上层给）、业务判断、消息排队。
 *
 * 用 Node 内置的 WebSocket（Node 22+），因此**不引入任何新依赖**。
 */
export const QQ_GATEWAY_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 事件订阅位：群聊/单聊消息 + 按钮交互（与官方常量一致） */
export const QQ_INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
} as const;

export const QQ_DEFAULT_INTENTS = QQ_INTENTS.GROUP_AND_C2C | QQ_INTENTS.INTERACTION;

/** 掉线重连的退避序列（与官方 SDK 一致） */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export interface QQGatewayDeps {
  logger: Logger;
  /** 取 wss:// 地址（带鉴权的 GET /gateway） */
  gatewayUrl: () => Promise<string>;
  /** 取 access_token（形如 QQBot xxxx 里的那串） */
  accessToken: () => Promise<string>;
  /** DISPATCH 事件（t + d） */
  onEvent: (event: { t: string; d: unknown }) => void;
  onStateChange: (state: "connecting" | "connected" | "reconnecting" | "stopped", error?: string) => void;
  intents?: number;
  /** 测试注入 */
  webSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export function createQQGateway(deps: QQGatewayDeps) {
  const WebSocketImpl = deps.webSocketImpl ?? WebSocket;
  const setTimer = deps.setTimeoutImpl ?? setTimeout;
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
  const intents = deps.intents ?? QQ_DEFAULT_INTENTS;

  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let attempts = 0;
  let stopped = false;

  function clearHeartbeat(): void {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)] as number;
    attempts += 1;
    deps.onStateChange("reconnecting", reason);
    deps.logger.warn("qq gateway will reconnect", {
      step: "qq.gateway",
      status: "reconnecting",
      reason,
      delayMs: delay,
      attempt: attempts,
    });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect().catch((error: Error) => scheduleReconnect(error.message));
    }, delay);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    deps.onStateChange("connecting");
    const [url, token] = await Promise.all([deps.gatewayUrl(), deps.accessToken()]);
    const ws = new WebSocketImpl(url);
    socket = ws;

    ws.addEventListener("message", (event: MessageEvent) => {
      let frame: QQGatewayFrame;
      try {
        frame = JSON.parse(String(event.data)) as QQGatewayFrame;
      } catch {
        deps.logger.warn("qq gateway sent a frame that is not JSON", { step: "qq.gateway" });
        return;
      }
      if (typeof frame.s === "number") lastSeq = frame.s;

      if (frame.op === QQ_GATEWAY_OP.HELLO) {
        const interval = (frame.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 30_000;
        const payload =
          sessionId !== null && lastSeq !== null
            ? { op: QQ_GATEWAY_OP.RESUME, d: { token: "QQBot " + token, session_id: sessionId, seq: lastSeq } }
            : { op: QQ_GATEWAY_OP.IDENTIFY, d: { token: "QQBot " + token, intents, shard: [0, 1] } };
        ws.send(JSON.stringify(payload));
        clearHeartbeat();
        heartbeat = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ op: QQ_GATEWAY_OP.HEARTBEAT, d: lastSeq }));
        }, interval);
        return;
      }

      if (frame.op === QQ_GATEWAY_OP.DISPATCH) {
        const name = frame.t ?? "";
        if (name === "READY") {
          const ready = frame.d as { session_id?: string } | undefined;
          sessionId = ready?.session_id ?? null;
          attempts = 0;
          deps.onStateChange("connected");
          deps.logger.info("qq gateway ready", { step: "qq.gateway", status: "connected" });
          return;
        }
        if (name === "RESUMED") {
          attempts = 0;
          deps.onStateChange("connected");
          return;
        }
        try {
          deps.onEvent({ t: name, d: frame.d });
        } catch (error) {
          // 单个事件处理失败不能把网关带下水
          deps.logger.warn("qq event handler failed", { step: "qq.gateway", error: (error as Error).message });
        }
        return;
      }

      if (frame.op === QQ_GATEWAY_OP.RECONNECT) {
        try {
          ws.close();
        } catch {
          // 已经在关了
        }
        scheduleReconnect("gateway asked to reconnect");
        return;
      }

      if (frame.op === QQ_GATEWAY_OP.INVALID_SESSION) {
        // 会话失效：丢掉 session，下次走完整 IDENTIFY
        sessionId = null;
        lastSeq = null;
      }
    });

    ws.addEventListener("close", (event: { code: number }) => {
      clearHeartbeat();
      socket = null;
      if (stopped) return;
      if (event.code === 4004) {
        // 鉴权失败：token 或 appId/clientSecret 不对，重连也没用
        deps.onStateChange("stopped", "网关鉴权失败（4004）：检查 appId / clientSecret");
        stopped = true;
        return;
      }
      if (event.code === 4006 || event.code === 4007 || event.code === 4009) {
        sessionId = null;
        lastSeq = null;
      }
      scheduleReconnect("gateway closed: " + event.code);
    });

    ws.addEventListener("error", () => {
      // 具体的错误原因由 close 事件带出来，这里不重复报
      deps.logger.warn("qq gateway socket error", { step: "qq.gateway", status: "failed" });
    });
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      await connect();
    },
    stop(): void {
      stopped = true;
      clearHeartbeat();
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      sessionId = null;
      lastSeq = null;
      const current = socket;
      socket = null;
      if (current !== null) {
        try {
          current.close();
        } catch {
          // 已经关了
        }
      }
      deps.onStateChange("stopped");
    },
    isRunning: (): boolean => socket !== null && !stopped,
  };
}

export type QQGateway = ReturnType<typeof createQQGateway>;


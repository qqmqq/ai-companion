import type { ChannelAccountStatus } from "../../core/model/channel.ts";

/**
 * QQ 账号的运行状态。
 *
 * 与微信渠道同样的纪律：这里只描述"连上没有、为什么掉线"，
 * 不给界面看任何密钥；凭证失效单独成一档，因为处理方式不同（要重新填）。
 */
export type QQConnectionState =
  | "not_configured"
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "credential_invalid"
  | "stopped";

export interface QQSessionSnapshot {
  state: QQConnectionState;
  lastError: string | null;
  lastEventAt: string | null;
  consecutiveFailures: number;
  gatewaySessions: number;
}

export function createQQSessionState(options: { now: () => number }) {
  let state: QQConnectionState = "not_configured";
  let lastError: string | null = null;
  let lastEventAt: number | null = null;
  let consecutiveFailures = 0;
  let gatewaySessions = 0;

  return {
    /** 状态跃迁：连上就清掉错误与失败计数，掉线就累加 */
    mark(next: QQConnectionState, error: string | null = null): void {
      if (next === "connected") {
        consecutiveFailures = 0;
        lastError = null;
        gatewaySessions += 1;
      } else if (next === "reconnecting" || next === "disconnected") {
        consecutiveFailures += 1;
        if (error !== null) lastError = error;
      } else if (error !== null) {
        lastError = error;
      }
      state = next;
    },

    touchEvent(): void {
      lastEventAt = options.now();
    },

    snapshot(): QQSessionSnapshot {
      return {
        state,
        lastError,
        lastEventAt: lastEventAt === null ? null : new Date(lastEventAt).toISOString(),
        consecutiveFailures,
        gatewaySessions,
      };
    },
  };
}

export type QQSessionState = ReturnType<typeof createQQSessionState>;

/** 连接状态 → 账号状态（给 ChannelAccountInfo 用） */
export function toAccountStatus(state: QQConnectionState): ChannelAccountStatus {
  switch (state) {
    case "connected":
    case "connecting":
    case "reconnecting":
      return "active";
    case "credential_invalid":
      return "needs_relogin";
    case "stopped":
      return "paused";
    default:
      return "logged_out";
  }
}


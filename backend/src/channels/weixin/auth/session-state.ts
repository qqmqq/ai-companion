import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";

/** 账号级运行状态；前端只看到这些，看不到任何令牌。 */
export type WeixinAccountState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "credential_invalid"
  | "stopped";

export interface WeixinAccountRuntime {
  accountId: string;
  state: WeixinAccountState;
  lastError: string | null;
  /** 连续失败次数（用于退避与展示） */
  consecutiveFailures: number;
  lastEventAt: string | null;
  /** -14 后置位：必须重新登录，且不再无限重试 */
  requiresRelogin: boolean;
  pauseUntil: string | null;
}

/**
 * 账号运行状态与"凭证失效"处理。
 * 关键：收到 -14 之后必须停下来等用户重新登录，而不是继续重试（否则就是无限 reconnect loop）。
 */
export function createSessionStateRegistry(deps: { logger: Logger; clock: Clock }) {
  const states = new Map<string, WeixinAccountRuntime>();

  function ensure(accountId: string): WeixinAccountRuntime {
    const existing = states.get(accountId);
    if (existing !== undefined) return existing;
    const created: WeixinAccountRuntime = {
      accountId,
      state: "disconnected",
      lastError: null,
      consecutiveFailures: 0,
      lastEventAt: null,
      requiresRelogin: false,
      pauseUntil: null,
    };
    states.set(accountId, created);
    return created;
  }

  function patch(accountId: string, changes: Partial<WeixinAccountRuntime>): WeixinAccountRuntime {
    const current = ensure(accountId);
    const next: WeixinAccountRuntime = { ...current, ...changes, lastEventAt: deps.clock.nowIso() };
    states.set(accountId, next);
    return next;
  }

  return {
    get: (accountId: string): WeixinAccountRuntime => ensure(accountId),
    all: (): WeixinAccountRuntime[] => [...states.values()],

    markConnecting(accountId: string): WeixinAccountRuntime {
      return patch(accountId, { state: "connecting", lastError: null });
    },
    /**
     * 注意：**不清除 requiresRelogin**。
     * 否则一个并发成功的请求会把刚被 -14 标记的账号"复活"，导致又回去轮询一个已失效的凭证。
     * 只有显式重新登录（clearCredentialInvalid）才能解除。
     */
    markConnected(accountId: string): WeixinAccountRuntime {
      const current = ensure(accountId);
      if (current.requiresRelogin) return current;
      return patch(accountId, { state: "connected", lastError: null, consecutiveFailures: 0, pauseUntil: null });
    },
    markReconnecting(accountId: string, reason: string): WeixinAccountRuntime {
      const current = ensure(accountId);
      return patch(accountId, { state: "reconnecting", lastError: reason, consecutiveFailures: current.consecutiveFailures + 1 });
    },
    markDisconnected(accountId: string, reason: string | null = null): WeixinAccountRuntime {
      return patch(accountId, { state: "disconnected", lastError: reason });
    },
    markStopped(accountId: string): WeixinAccountRuntime {
      return patch(accountId, { state: "stopped" });
    },

    /** -14：凭证失效。停止轮询、标记需要重新登录、清空失败计数。 */
    markCredentialInvalid(accountId: string, detail: string): WeixinAccountRuntime {
      deps.logger.warn("weixin credential invalid; polling stopped until re-login", { accountId });
      return patch(accountId, {
        state: "credential_invalid",
        requiresRelogin: true,
        lastError: detail,
        consecutiveFailures: 0,
        pauseUntil: null,
      });
    },
    /** 登录成功后清除失效标记 */
    clearCredentialInvalid(accountId: string): WeixinAccountRuntime {
      return patch(accountId, { requiresRelogin: false, state: "connecting", lastError: null });
    },
    recordFailure(accountId: string, reason: string): WeixinAccountRuntime {
      const current = ensure(accountId);
      return patch(accountId, { lastError: reason, consecutiveFailures: current.consecutiveFailures + 1 });
    },
    resetFailures(accountId: string): WeixinAccountRuntime {
      return patch(accountId, { consecutiveFailures: 0, lastError: null });
    },
    setPause(accountId: string, until: string | null): WeixinAccountRuntime {
      return patch(accountId, { pauseUntil: until });
    },
  };
}

export type SessionStateRegistry = ReturnType<typeof createSessionStateRegistry>;
import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import type { QQAccountConfig } from "../types.ts";

/**
 * 取 access_token（官方 Bot API v2）：
 *   POST {tokenBaseUrl}/app/getAppAccessToken  body: { appId, clientSecret }
 *   返回 { access_token, expires_in }（默认 7200 秒）
 *
 * 只在渠道层使用；token 不进日志、不进任何 DTO。提前 5 分钟刷新，避免用到最后一秒。
 */
const TOKEN_PATH = "/app/getAppAccessToken";
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 7200 * 1000;

export interface QQTokenManagerDeps {
  config: () => QQAccountConfig | null;
  secret: () => Promise<string | null>;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
}

export function createQQTokenManager(deps: QQTokenManagerDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  let cached: { token: string; expiresAt: number; appId: string } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(config: QQAccountConfig, clientSecret: string): Promise<string> {
    const response = await doFetch(config.tokenBaseUrl + TOKEN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: config.appId, clientSecret }),
    });
    const text = await response.text();
    if (!response.ok) {
      // 官方在 4xx 时会给出 code/message，原样带出来便于排查，但绝不回显密钥
      throw new Error("取 access_token 失败（HTTP " + response.status + "）：" + text.slice(0, 200));
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw new Error("取 access_token 返回的不是 JSON：" + text.slice(0, 120));
    }
    const value = parsed.access_token;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("取 access_token 的响应里没有 access_token");
    }
    const ttlSeconds = typeof parsed.expires_in === "number" ? parsed.expires_in : typeof parsed.expires_in === "string" ? Number(parsed.expires_in) : NaN;
    const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : DEFAULT_TTL_MS;
    cached = { token: value, expiresAt: deps.clock.now().getTime() + ttlMs, appId: config.appId };
    deps.logger.info("qq access token refreshed", {
      step: "qq.token",
      status: "completed",
      appId: config.appId,
      ttlSeconds: Math.round(ttlMs / 1000),
    });
    return value;
  }

  return {
    /** 拿一个可用的 token：命中缓存就直接用，过期或换账号就重新取 */
    async get(): Promise<string> {
      const config = deps.config();
      if (config === null) throw new Error("QQ 渠道还没配置 appId");
      const now = deps.clock.now().getTime();
      if (cached !== null && cached.appId === config.appId && now < cached.expiresAt - REFRESH_AHEAD_MS) {
        return cached.token;
      }
      // 单飞：并发调用共用同一个 Promise。
      // 注意要在 await 之前就占住 pending —— 否则两个并发请求都会通过上面那个检查，白白取两次 token
      // （真实事故：一次连接同时要网关地址与 token，token 接口被打了两遍）。
      if (pending === null) {
        pending = (async () => {
          const secret = await deps.secret();
          if (secret === null) throw new Error("QQ 渠道还没有保存 clientSecret");
          return await fetchToken(config, secret);
        })().finally(() => {
          pending = null;
        });
      }
      return pending;
    },

    /** 被平台判定失效时清掉缓存，下次重新取 */
    invalidate(): void {
      cached = null;
    },

    status(): { state: "none" | "valid" | "expired"; expiresAt: string | null } {
      if (cached === null) return { state: "none", expiresAt: null };
      const valid = deps.clock.now().getTime() < cached.expiresAt - REFRESH_AHEAD_MS;
      return { state: valid ? "valid" : "expired", expiresAt: new Date(cached.expiresAt).toISOString() };
    },
  };
}

export type QQTokenManager = ReturnType<typeof createQQTokenManager>;


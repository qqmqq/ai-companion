import type { ChannelRoutesDeps, HttpRouteHost, RouteRequest } from "../../core/ports/channel-module.ts";
import { DomainError } from "../../core/model/errors.ts";
import { WEIXIN_CHANNEL_KIND, type WeixinChannel } from "./channel.ts";

const BASE = `/api/channels/${WEIXIN_CHANNEL_KIND}`;

function channelOf(deps: ChannelRoutesDeps): WeixinChannel {
  const adapter = deps.channels.get(WEIXIN_CHANNEL_KIND);
  if (adapter === undefined) {
    throw new DomainError("channel_unavailable", "微信通道未启用");
  }
  return adapter as WeixinChannel;
}

function requireString(body: unknown, key: string): string {
  if (body !== null && typeof body === "object" && typeof (body as Record<string, unknown>)[key] === "string") {
    const value = (body as Record<string, unknown>)[key] as string;
    if (value.trim().length > 0) return value.trim();
  }
  throw new DomainError("invalid_input", `缺少参数 ${key}`);
}

/**
 * 微信通道自己的管理接口。
 * 返回体里只有"状态"与二维码展示信息，**绝不含 token**。
 */
export function registerWeixinRoutes(host: HttpRouteHost, deps: ChannelRoutesDeps): void {
  host.get(`${BASE}/status`, async () => {
    const adapter = deps.channels.get(WEIXIN_CHANNEL_KIND) as WeixinChannel | undefined;
    if (adapter === undefined) {
      return { enabled: false, accounts: [], health: { state: "stopped", message: "微信通道未启用" } };
    }
    const [accounts, health] = await Promise.all([adapter.listAccountViews(), adapter.health()]);
    return { enabled: true, accounts, health: { state: health.state, message: health.message } };
  });

  host.post(`${BASE}/login`, async () => {
    const adapter = channelOf(deps);
    return await adapter.startLogin();
  });

  /** 每调用一次推进一次轮询，前端按自己的节奏轮询即可 */
  host.get(`${BASE}/login/:sessionId`, async (request: RouteRequest) => {
    const adapter = channelOf(deps);
    const session = await adapter.pollLogin(request.params.sessionId ?? "");
    if (session === null) throw new DomainError("not_found", "登录会话不存在或已结束");
    return session;
  });

  host.post(`${BASE}/login/:sessionId/verify-code`, async (request: RouteRequest) => {
    const adapter = channelOf(deps);
    const code = requireString(request.body, "code");
    const session = adapter.submitVerifyCode(request.params.sessionId ?? "", code);
    if (session === null) throw new DomainError("not_found", "登录会话不存在或已结束");
    return session;
  });

  host.post(`${BASE}/login/:sessionId/complete`, async (request: RouteRequest) => {
    const adapter = channelOf(deps);
    const result = await adapter.completeLogin(request.params.sessionId ?? "");
    return { accountId: result.accountId, displayName: result.displayName };
  });

  host.post(`${BASE}/login/:sessionId/cancel`, async (request: RouteRequest) => {
    const adapter = channelOf(deps);
    return { cancelled: adapter.cancelLogin(request.params.sessionId ?? "") };
  });

  host.get(`${BASE}/accounts`, async () => {
    const adapter = channelOf(deps);
    return { items: await adapter.listAccountViews() };
  });

  host.delete(`${BASE}/accounts/:accountId`, async (request: RouteRequest) => {
    const adapter = channelOf(deps);
    await adapter.removeAccount(request.params.accountId ?? "");
    return { removed: true };
  });

  host.post(`${BASE}/accounts/:accountId/relogin`, async (request: RouteRequest) => {
    const adapter = channelOf(deps);
    return adapter.reloginAccount(request.params.accountId ?? "");
  });
}

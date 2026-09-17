import type { ChannelRoutesDeps, HttpRouteHost } from "../../core/ports/channel-module.ts";
import type { QQChannel } from "./channel.ts";
import { QQ_CHANNEL_KIND } from "./types.ts";

/**
 * QQ 渠道的管理接口（挂在 web 层，但实现只依赖 core 的 RouteHost 契约）。
 *
 * 纪律：**密钥只进不出** —— 请求里可以带 clientSecret，响应里永远只回"有没有配"。
 */
export function registerQQRoutes(host: HttpRouteHost, deps: ChannelRoutesDeps): void {
  function channelOrThrow(): QQChannel {
    const adapter = deps.channels.get(QQ_CHANNEL_KIND) as QQChannel | undefined;
    if (adapter === undefined) throw new Error("QQ 渠道未启用");
    return adapter;
  }

  host.get("/api/channels/qq/status", async () => {
    const channel = channelOrThrow();
    const status = channel.status();
    const accounts = await channel.listAccounts();
    const hasSecret = await channel.hasCredentials();
    return {
      configured: status.configured,
      appId: status.appId,
      sandbox: status.sandbox,
      baseUrl: status.baseUrl,
      credentialsSaved: hasSecret,
      session: status.session,
      token: status.token,
      health: await channel.health(),
      accounts,
    };
  });

  /** 保存配置并重连：clientSecret 只在这次请求里出现，之后只存在于加密库 */
  host.put("/api/channels/qq/config", async (request, reply) => {
    const channel = channelOrThrow();
    const body = (request.body ?? {}) as { appId?: unknown; clientSecret?: unknown; sandbox?: unknown };
    if (typeof body.appId !== "string" || body.appId.trim().length === 0) {
      throw new Error("appId 不能为空");
    }
    await channel.configure({
      appId: body.appId.trim(),
      ...(typeof body.clientSecret === "string" && body.clientSecret.length > 0 ? { clientSecret: body.clientSecret } : {}),
      ...(typeof body.sandbox === "boolean" ? { sandbox: body.sandbox } : {}),
    });
    await channel.reconnect();
    reply.code(200);
    return { ok: true, session: channel.status().session };
  });

  host.post("/api/channels/qq/reconnect", async () => {
    const channel = channelOrThrow();
    await channel.reconnect();
    return { ok: true, session: channel.status().session };
  });

  host.post("/api/channels/qq/disconnect", async () => {
    const channel = channelOrThrow();
    await channel.stop();
    return { ok: true, session: channel.status().session };
  });

  /** 清掉保存的 clientSecret（appId 留着），用于换机器人 */
  host.delete("/api/channels/qq/credentials", async () => {
    const channel = channelOrThrow();
    const status = channel.status();
    if (status.appId !== null) await channel.removeAccount(status.appId);
    return { ok: true };
  });
}

// 只回答"配没配"，绝不回显密钥本身（判断在 channel.hasCredentials 里）


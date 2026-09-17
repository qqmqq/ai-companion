import type { ChannelAdapter } from "../../core/ports/channel.ts";
import type { ChannelModule, ChannelModuleContext } from "../../core/ports/channel-module.ts";
import { createQQChannel } from "./channel.ts";
import { registerQQRoutes } from "./routes.ts";
import { QQ_CHANNEL_KIND } from "./types.ts";

/**
 * QQ 渠道模块入口。
 *
 * 组合根通过运行时发现加载本文件（见 app/channel-loader.ts）：
 * 因此删掉整个 channels/qq/ 目录后，Core 与其它渠道仍能编译、构建、测试（ARCH-7）。
 */
export const kind = QQ_CHANNEL_KIND;

export function createChannel(context: ChannelModuleContext): ChannelAdapter {
  return createQQChannel({
    logger: context.logger,
    clock: context.clock,
    events: context.events,
    credentials: context.credentials,
    settings: context.settings,
    accounts: context.accounts,
    userId: context.userId,
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
  });
}

export function registerRoutes(
  host: Parameters<typeof registerQQRoutes>[0],
  deps: Parameters<typeof registerQQRoutes>[1],
): void {
  registerQQRoutes(host, deps);
}

export const channelModule: ChannelModule = { kind, createChannel, registerRoutes };


import type { ChannelAdapter } from "../../core/ports/channel.ts";
import type { ChannelModule, ChannelModuleContext } from "../../core/ports/channel-module.ts";
import { WEIXIN_CHANNEL_KIND, createWeixinChannel } from "./channel.ts";
import { createVoiceCodec } from "./media/voice-codec.ts";
import { registerWeixinRoutes } from "./routes.ts";

/**
 * 微信渠道模块入口。
 *
 * 组合根通过运行时发现加载本文件（见 app/channel-loader.ts），
 * 因此删掉整个 channels/weixin/ 目录后 Core 仍然可以编译、构建、测试（ARCH-7）。
 */
export const kind = WEIXIN_CHANNEL_KIND;

export async function createChannel(context: ChannelModuleContext): Promise<ChannelAdapter> {
  // Phase 0 风险 R6 的启动自检：语音编解码是可选的运行期能力，
  // 缺库时整条链路仍然可用（语音降级为原样保存 SILK），但必须在启动时明确说出来，
  // 而不是等到第一条语音消息才发现。
  void createVoiceCodec()
    .available()
    .then((available) => {
      if (available) {
        context.logger.info("weixin voice codec ready", { codec: "silk-wasm" });
        return;
      }
      context.logger.warn("weixin voice codec unavailable; voice messages will be stored as raw SILK", { codec: "silk-wasm" });
    })
    .catch(() => {
      context.logger.warn("weixin voice codec self-check failed", { codec: "silk-wasm" });
    });

  return createWeixinChannel({
    logger: context.logger,
    clock: context.clock,
    events: context.events,
    credentials: context.credentials,
    settings: context.settings,
    accounts: context.accounts,
    mediaStorage: context.mediaStorage,
    db: context.db,
    userId: context.userId,
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
  });
}

export function registerRoutes(
  host: Parameters<typeof registerWeixinRoutes>[0],
  deps: Parameters<typeof registerWeixinRoutes>[1],
): void {
  registerWeixinRoutes(host, deps);
}

export const channelModule: ChannelModule = { kind, createChannel, registerRoutes };
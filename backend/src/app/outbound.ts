import type { ChannelRegistry } from "../core/ports/channel-registry.ts";
import type { ProactiveOutbound, ProactiveOutboundRequest, ProactiveOutboundResult } from "../core/ports/outbound.ts";
import type { Logger } from "../core/ports/logger.ts";

/**
 * 把"发一条主动消息"接到渠道层。
 * Core 只看到 ProactiveOutbound 端口；这里才知道 ChannelAdapter 的存在。
 */
export function createChannelProactiveOutbound(deps: {
  channels: ChannelRegistry;
  logger: Logger;
}): ProactiveOutbound {
  return {
    async send(request: ProactiveOutboundRequest): Promise<ProactiveOutboundResult> {
      const adapter = deps.channels.get(request.target.channel);
      if (adapter === undefined) {
        deps.logger.warn("proactive outbound: channel not registered", { channel: request.target.channel });
        return { delivered: false, providerMessageId: null, error: "channel_not_registered" };
      }
      try {
        const receipt = await adapter.send({
          channel: request.target.channel,
          accountId: request.target.accountId ?? "",
          conversationId: request.target.conversationRef,
          parts: [{ kind: "text", text: request.text }],
          replyToProviderMessageId: null,
          streaming: { mode: "none", runId: null },
          idempotencyKey: request.idempotencyKey,
        });
        return { delivered: true, providerMessageId: receipt.providerMessageId, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error("proactive outbound failed", { channel: request.target.channel, error: message });
        return { delivered: false, providerMessageId: null, error: message };
      }
    },
  };
}

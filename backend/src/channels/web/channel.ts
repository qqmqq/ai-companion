import type { ChannelAccountInfo, ChannelCapabilities, ChannelHealth, ChannelKind } from "../../core/model/channel.ts";
import type { InternalMessage, InternalResponse } from "../../core/model/message.ts";
import type { ChannelAdapter, InboundHandler, SendReceipt } from "../../core/ports/channel.ts";
import type { DomainEventPublisher } from "../../core/ports/events.ts";
import type { Logger } from "../../core/ports/logger.ts";
import { nowIso } from "../../util/time.ts";

/** Web 渠道自己声明自己的 kind：Core 不认识 "web" 这个字面量的含义。 */
export const WEB_CHANNEL_KIND: ChannelKind = "web";

export interface StreamStartResult {
  conversationId: string;
  userMessageId: string;
  runId: string;
}

export type StreamingInboundHandler = (message: InternalMessage) => Promise<StreamStartResult | null>;

export interface WebChannel extends ChannelAdapter {
  /**
   * 渠道内部入口：HTTP 路由把浏览器来的消息交给它，再由它注入 Core 的统一入站处理器。
   * 这样 Web 与未来的其他渠道走完全相同的 Core 路径。
   */
  deliverInbound(message: InternalMessage): Promise<void>;
  /** 流式入站：立即返回落库 id，增量由 Core 通过领域事件流出。 */
  deliverInboundStreaming(message: InternalMessage): Promise<StreamStartResult | null>;
  onInboundStreaming(handler: StreamingInboundHandler): void;
}

export interface WebChannelDeps {
  accountId: string;
  events: DomainEventPublisher;
  logger: Logger;
  nowIso?: () => string;
}

export const WEB_CAPABILITIES: ChannelCapabilities = {
  text: true,
  media: { image: false, audio: false, video: false, file: false },
  maxTextLength: 8000,
  supportsReplyQuote: true,
  supportsTyping: true,
  supportsEditMessage: false,
  supportsStreamingAppend: true,
  loginMethod: "none",
};

export function createWebChannel(deps: WebChannelDeps): WebChannel {
  const now = deps.nowIso ?? nowIso;
  let handler: InboundHandler | null = null;
  let streamHandler: StreamingInboundHandler | null = null;
  let started = false;
  let lastEventAt: string | null = null;

  const account: ChannelAccountInfo = {
    id: deps.accountId,
    channel: "web",
    externalAccountId: "local",
    displayName: "本地 Web",
    status: "active",
    createdAt: now(),
  };

  const adapter: WebChannel = {
    kind: "web" as ChannelKind,
    capabilities: WEB_CAPABILITIES,

    async start(): Promise<void> {
      started = true;
      deps.logger.info("web channel started", { accountId: deps.accountId });
    },
    async stop(): Promise<void> {
      started = false;
      deps.logger.info("web channel stopped", { accountId: deps.accountId });
    },
    async health(): Promise<ChannelHealth> {
      return {
        channel: "web",
        state: started ? "healthy" : "stopped",
        accounts: 1,
        lastEventAt,
        message: null,
      };
    },
    async listAccounts(): Promise<ChannelAccountInfo[]> {
      return [account];
    },
    async removeAccount(): Promise<void> {
      // 本地 Web 账号由 Core 拥有，不允许通过渠道删除
    },
    onInbound(next: InboundHandler): void {
      handler = next;
    },
    onInboundStreaming(next: StreamingInboundHandler): void {
      streamHandler = next;
    },
    async send(response: InternalResponse): Promise<SendReceipt> {
      lastEventAt = now();
      const text = response.parts
        .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
        .map((part) => part.text)
        .join("\n");
      const mediaParts = response.parts.filter((part) => part.kind !== "text" && part.kind !== "typing");
      if (mediaParts.length > 0) {
        // Phase 4.5-A 只定义模型：Web 端媒体渲染在后续阶段实现
        deps.logger.debug("web channel received media parts; rendering not implemented yet", { parts: mediaParts.length });
      }
      // 出站只发布领域事件；SSE 传输由应用层订阅事件总线后统一转发（单一投递路径）。
      deps.events.publish({
        name: "message.delta",
        at: lastEventAt,
        channel: "web",
        payload: { conversationId: response.conversationId, text, idempotencyKey: response.idempotencyKey },
      });
      return { idempotencyKey: response.idempotencyKey, providerMessageId: null, acceptedAt: lastEventAt };
    },
    async deliverInbound(message: InternalMessage): Promise<void> {
      lastEventAt = now();
      deps.events.publish({
        name: "message.new",
        at: lastEventAt,
        channel: "web",
        payload: { conversationId: message.conversationId, messageId: message.id, from: message.sender.id },
      });
      if (handler === null) {
        deps.logger.warn("web channel has no inbound handler; message dropped", { messageId: message.id });
        return;
      }
      await handler(message);
    },
    async deliverInboundStreaming(message: InternalMessage): Promise<StreamStartResult | null> {
      lastEventAt = now();
      deps.events.publish({
        name: "message.new",
        at: lastEventAt,
        channel: "web",
        payload: { conversationId: message.conversationId, messageId: message.id, from: message.sender.id },
      });
      if (streamHandler === null) {
        deps.logger.warn("web channel has no streaming inbound handler; message dropped", { messageId: message.id });
        return null;
      }
      return await streamHandler(message);
    },
  };

  return adapter;
}
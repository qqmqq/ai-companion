import type { ChannelKind } from "../model/channel.ts";
import type { MessageId } from "../model/ids.ts";

/**
 * 主动消息的出站端口。
 * Core 只知道"要把这条文本发到某个会话"，不认识 Web / 微信 / 任何渠道实现。
 */
export interface ProactiveOutboundTarget {
  channel: ChannelKind;
  accountId: string | null;
  conversationRef: string;
}

export interface ProactiveOutboundRequest {
  target: ProactiveOutboundTarget;
  text: string;
  messageId: MessageId;
  idempotencyKey: string;
}

export interface ProactiveOutboundResult {
  delivered: boolean;
  providerMessageId: string | null;
  error: string | null;
}

export interface ProactiveOutbound {
  send(request: ProactiveOutboundRequest): Promise<ProactiveOutboundResult>;
}

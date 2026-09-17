import type { ChannelAccountInfo, ChannelCapabilities, ChannelHealth, ChannelKind } from "../model/channel.ts";
import type { InternalMessage, InternalResponse } from "../model/message.ts";

export interface SendReceipt {
  idempotencyKey: string;
  providerMessageId: string | null;
  acceptedAt: string;
}

export type InboundHandler = (message: InternalMessage) => Promise<void>;

/**
 * Channel Layer 对 Core 的唯一契约。
 * 渠道自己负责协议、重连、媒体、鉴权；Core 只见 InternalMessage / InternalResponse。
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelHealth>;

  listAccounts(): Promise<ChannelAccountInfo[]>;
  removeAccount(accountId: string): Promise<void>;

  onInbound(handler: InboundHandler): void;
  send(response: InternalResponse): Promise<SendReceipt>;
}

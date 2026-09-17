/**
 * Core 不认识任何具体平台：渠道种类就是一个不透明标识符。
 * 具体取值由各渠道模块自己声明（例如 Web 渠道的 "web"），新增渠道不改 Core。
 */
export type ChannelKind = string;

export interface ChannelCapabilities {
  text: boolean;
  media: { image: boolean; audio: boolean; video: boolean; file: boolean };
  maxTextLength: number;
  supportsReplyQuote: boolean;
  supportsTyping: boolean;
  supportsEditMessage: boolean;
  supportsStreamingAppend: boolean;
  loginMethod: "qr" | "token" | "none";
}

export type ChannelAccountStatus = "active" | "paused" | "logged_out" | "needs_relogin";

export interface ChannelAccountInfo {
  id: string;
  channel: ChannelKind;
  externalAccountId: string;
  displayName: string;
  status: ChannelAccountStatus;
  createdAt: string;
}

export type ChannelHealthState = "starting" | "healthy" | "degraded" | "stopped";

export interface ChannelHealth {
  channel: ChannelKind;
  state: ChannelHealthState;
  accounts: number;
  lastEventAt: string | null;
  message: string | null;
}

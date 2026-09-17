/**
 * QQ 渠道自己的类型。
 *
 * 平台概念（QQ 的 openid、网关帧、intents）只允许出现在 channels/ 里 —— ARCH-4 守卫。
 * 字段名与官方 Bot API v2 文档一致：改动它们等于改协议，必须对照文档。
 */

export const QQ_CHANNEL_KIND = "qq";

/** 一个 QQ 机器人账号的运行配置（appId + 环境） */
export interface QQAccountConfig {
  appId: string;
  /** 沙箱环境（开放平台里的"沙箱"），API 域名与正式不同 */
  sandbox: boolean;
  /** 正式：https://api.sgroup.qq.com；沙箱：https://sandbox.api.sgroup.qq.com */
  baseUrl: string;
  /** 取 access_token 的域名：https://bots.qq.com */
  tokenBaseUrl: string;
}

/** 会话作用域：单聊（C2C）还是群聊 */
export type QQScope = "c2c" | "group";

/** 网关下行帧 */
export interface QQGatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/** 单聊消息事件（C2C_MESSAGE_CREATE） */
export interface QQC2CMessage {
  id: string;
  content: string;
  timestamp: string;
  author: { user_openid: string; union_openid?: string };
}

/** 群聊 @机器人 事件（GROUP_AT_MESSAGE_CREATE） */
export interface QQGroupMessage {
  id: string;
  content: string;
  timestamp: string;
  group_openid: string;
  author: { member_openid: string };
}


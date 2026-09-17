import { randomBytes } from "node:crypto";
import type { BaseInfo } from "./types.ts";
import { CHANNEL_VERSION, ILINK_APP_ID, clientVersionCode, sanitizeBotAgent } from "./identity.ts";

export interface HeaderOptions {
  token?: string | null;
  botAgent?: string;
  routeTag?: string | null;
  /** 测试注入随机源 */
  randomUint32?: () => number;
}

/** X-WECHAT-UIN：uint32 十进制字符串的 base64 */
export function buildWechatUin(random: () => number = () => randomBytes(4).readUInt32BE(0)): string {
  return Buffer.from(String(random() >>> 0), "utf8").toString("base64");
}

export function buildBaseInfo(botAgent?: string): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: sanitizeBotAgent(botAgent) };
}

/** 所有请求都带的公共头（不含鉴权） */
export function buildCommonHeaders(options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": clientVersionCode(),
  };
  if (options.routeTag !== undefined && options.routeTag !== null && options.routeTag.length > 0) {
    headers["SKRouteTag"] = options.routeTag;
  }
  return headers;
}

/** 业务 POST：额外带内容类型、鉴权类型、UIN，以及存在 token 时的 Bearer */
export function buildPostHeaders(options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    ...buildCommonHeaders(options),
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": buildWechatUin(options.randomUint32),
  };
  if (typeof options.token === "string" && options.token.trim().length > 0) {
    headers.Authorization = `Bearer ${options.token.trim()}`;
  }
  return headers;
}

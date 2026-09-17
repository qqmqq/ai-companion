import type { CredentialStore } from "../../core/ports/credential-store.ts";
import type { SettingsRepository } from "../../core/ports/repositories.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { QQAccountConfig } from "./types.ts";

/**
 * QQ 机器人的配置读取。
 *
 * 分两处存，理由与其它渠道一致：
 *   - **appId / 沙箱开关 / 域名覆盖** 放 settings（可以明文、要能在界面上回显）；
 *   - **clientSecret** 只进加密的 CredentialStore，永不回传界面、永不进日志。
 */
export const QQ_SETTINGS = {
  appId: "qq.appId",
  sandbox: "qq.sandbox",
  baseUrl: "qq.baseUrl",
  tokenBaseUrl: "qq.tokenBaseUrl",
} as const;

export const QQ_PRODUCTION_BASE_URL = "https://api.sgroup.qq.com";
export const QQ_SANDBOX_BASE_URL = "https://sandbox.api.sgroup.qq.com";
export const QQ_TOKEN_BASE_URL = "https://bots.qq.com";

/** 读配置；没填 appId 就返回 null（表示"这个渠道还没配"） */
export function readQQConfig(settings: SettingsRepository): QQAccountConfig | null {
  const appId = settings.get<string>(QQ_SETTINGS.appId, "").trim();
  if (appId.length === 0) return null;
  const sandbox = settings.get<boolean>(QQ_SETTINGS.sandbox, false) === true;
  const override = settings.get<string>(QQ_SETTINGS.baseUrl, "").trim();
  return {
    appId,
    sandbox,
    baseUrl: override.length > 0 ? override : sandbox ? QQ_SANDBOX_BASE_URL : QQ_PRODUCTION_BASE_URL,
    tokenBaseUrl: settings.get<string>(QQ_SETTINGS.tokenBaseUrl, QQ_TOKEN_BASE_URL).trim() || QQ_TOKEN_BASE_URL,
  };
}

/** clientSecret 存在加密凭据库里，键就是 appId */
export async function readQQSecret(credentials: CredentialStore, appId: string): Promise<string | null> {
  const secret = await credentials.getSecret(appId);
  const value = secret?.clientSecret;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function saveQQSecret(credentials: CredentialStore, appId: string, clientSecret: string): Promise<void> {
  await credentials.putSecret(appId, { clientSecret });
}

/** 日志里只允许出现"有没有配、配的哪个 appId"，绝不出现密钥 */
export function describeQQConfig(config: QQAccountConfig | null, hasSecret: boolean, logger: Logger): void {
  logger.info("qq channel config resolved", {
    configured: config !== null,
    appId: config?.appId ?? null,
    sandbox: config?.sandbox ?? null,
    hasSecret,
  });
}


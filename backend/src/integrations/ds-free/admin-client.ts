/**
 * ds-free-api 的管理 API 客户端（协议事实来自它的源码 src/server/admin.rs 与 auth.rs）：
 *
 *   POST /admin/api/setup   {password}            → {token}   首次设置管理密码（已设置过则 403）
 *   POST /admin/api/login   {password}            → {token}   密码登录，拿 JWT
 *   GET  /admin/api/status                        → 账号池状态
 *   GET  /admin/api/config                        → 整份配置（账号池、API Key 都在里面）
 *   PUT  /admin/api/config                        → 写回并热重载
 *
 * 账号字段：email / mobile / area_code / password / device_id；API Key：{key, description}。
 * JWT 走 Authorization: Bearer <token>。
 */
import type { Logger } from "../../core/ports/logger.ts";

export interface DsFreeAccount {
  email: string;
  mobile: string;
  area_code: string;
  password: string;
  device_id: string;
}

export interface DsFreeApiKey {
  key: string;
  description: string;
}

/** 只碰我们关心的字段，其余原样带回（避免猜整个配置结构） */
export interface DsFreeConfig {
  ds_core?: { accounts?: DsFreeAccount[] } & Record<string, unknown>;
  api_keys?: DsFreeApiKey[];
  [key: string]: unknown;
}

export interface DsFreeAdminDeps {
  baseUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class DsFreeAdminError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DsFreeAdminError";
    this.status = status;
  }
}

export function createDsFreeAdminClient(deps: DsFreeAdminDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const root = deps.baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: { method: string; body?: unknown; token?: string }): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token !== undefined) headers.authorization = "Bearer " + init.token;
    const response = await doFetch(root + path, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      // 反代的错误体是 {error:{message}} 或 {message}，都尽量取出人话
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = parsed.error?.message ?? parsed.message ?? message;
      } catch {
        // 不是 JSON 就原样
      }
      throw new DsFreeAdminError(message, response.status);
    }
    return (text.length === 0 ? {} : JSON.parse(text)) as T;
  }

  async function login(password: string): Promise<string> {
    const result = await request<{ token?: unknown }>("/admin/api/login", { method: "POST", body: { password } });
    if (typeof result.token !== "string" || result.token.length === 0) throw new DsFreeAdminError("管理登录没有返回 token", 500);
    return result.token;
  }

  async function setup(password: string): Promise<string> {
    const result = await request<{ token?: unknown }>("/admin/api/setup", { method: "POST", body: { password } });
    if (typeof result.token !== "string" || result.token.length === 0) throw new DsFreeAdminError("设置管理密码没有返回 token", 500);
    return result.token;
  }

  return {
    root,

    /** 反代在不在（不要求鉴权） */
    async reachable(): Promise<boolean> {
      try {
        const response = await doFetch(root + "/health");
        return response.ok;
      } catch {
        return false;
      }
    },

    login,
    setup,

    /**
     * 拿到一个可用的管理 JWT：
     * 先试登录；反代说"还没设置密码"（403/未设置）就用给的密码走 setup。
     */
    async ensureAdminToken(password: string): Promise<{ token: string; createdPassword: boolean }> {
      try {
        return { token: await login(password), createdPassword: false };
      } catch (error) {
        const admin = error as DsFreeAdminError;
        // 403 = 还没设置过管理密码（这时用你给的密码把它设上）；401 = 密码不对，直接如实报错
        if (admin.status !== 403) throw error;
        deps.logger.info("ds-free admin password is not set yet; setting it now", { step: "dsfree.admin", status: "setup" });
        return { token: await setup(password), createdPassword: true };
      }
    },

    async getConfig(token: string): Promise<DsFreeConfig> {
      return await request<DsFreeConfig>("/admin/api/config", { method: "GET", token });
    },

    async putConfig(token: string, config: DsFreeConfig): Promise<void> {
      await request<unknown>("/admin/api/config", { method: "PUT", token, body: config });
    },

    /** 账号池里没有就加一个（同一个邮箱视为同一个账号，只补 device_id） */
    addAccount(config: DsFreeConfig, account: DsFreeAccount): { config: DsFreeConfig; added: boolean; deviceIdFilled: boolean } {
      const accounts = config.ds_core?.accounts ?? [];
      const index = accounts.findIndex((item) => item.email.length > 0 && item.email === account.email);
      if (index >= 0) {
        const existing = accounts[index] as DsFreeAccount;
        const deviceIdFilled = existing.device_id.length === 0 && account.device_id.length > 0;
        accounts[index] = { ...existing, ...account, device_id: account.device_id.length > 0 ? account.device_id : existing.device_id };
        return { config: { ...config, ds_core: { ...config.ds_core, accounts } }, added: false, deviceIdFilled };
      }
      accounts.push(account);
      return { config: { ...config, ds_core: { ...config.ds_core, accounts } }, added: true, deviceIdFilled: account.device_id.length > 0 };
    },

    /** API Key 没有就加一个 */
    addApiKey(config: DsFreeConfig, key: DsFreeApiKey): { config: DsFreeConfig; added: boolean } {
      const keys = config.api_keys ?? [];
      if (keys.some((item) => item.key === key.key)) return { config, added: false };
      return { config: { ...config, api_keys: [...keys, key] }, added: true };
    },
  };
}

export type DsFreeAdminClient = ReturnType<typeof createDsFreeAdminClient>;

/** 生成一个本程序用的反代密钥（只用于本机，前缀便于识别） */
export function generateProxyKey(randomHex: () => string): string {
  return "sk-dsfree-" + randomHex();
}

/** 只用于界面展示：永远不回显完整密钥 */
export function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return key.slice(0, 12) + "…" + key.slice(-4);
}


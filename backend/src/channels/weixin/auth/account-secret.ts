import type { CredentialStore } from "../../../core/ports/credential-store.ts";
import type { Logger } from "../../../core/ports/logger.ts";
import { DEFAULT_API_BASE_URL } from "../protocol/endpoints.ts";

/**
 * 一个微信账号的机密载荷，整体交给 Phase 1 的 CredentialStore 加密保存。
 * - botToken：登录凭证
 * - contextTokens：按会话隔离的上下文令牌（绝不进入 Core）
 * - baseUrl/ilinkUserId：登录返回的账号级信息
 */
export interface WeixinAccountSecret {
  botToken: string;
  baseUrl: string;
  ilinkUserId: string | null;
  contextTokens: Record<string, string>;
  savedAt: string;
}

export function emptySecret(): WeixinAccountSecret {
  return { botToken: "", baseUrl: DEFAULT_API_BASE_URL, ilinkUserId: null, contextTokens: {}, savedAt: "" };
}

export function normalizeSecret(raw: Record<string, unknown> | null): WeixinAccountSecret {
  if (raw === null) return emptySecret();
  const contextTokens: Record<string, string> = {};
  const rawTokens = raw.contextTokens;
  if (rawTokens !== null && typeof rawTokens === "object") {
    for (const [key, value] of Object.entries(rawTokens as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) contextTokens[key] = value;
    }
  }
  return {
    botToken: typeof raw.botToken === "string" ? raw.botToken : "",
    baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? raw.baseUrl : DEFAULT_API_BASE_URL,
    ilinkUserId: typeof raw.ilinkUserId === "string" ? raw.ilinkUserId : null,
    contextTokens,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
  };
}

export interface WeixinSecretStore {
  load(accountId: string): Promise<WeixinAccountSecret>;
  save(accountId: string, secret: WeixinAccountSecret): Promise<void>;
  update(accountId: string, patch: (current: WeixinAccountSecret) => WeixinAccountSecret): Promise<WeixinAccountSecret>;
  clear(accountId: string): Promise<void>;
  has(accountId: string): Promise<boolean>;

  /** 会话上下文令牌：按账号 + 会话（微信 userId）隔离保存 */
  getContextToken(accountId: string, conversationRef: string): Promise<string | null>;
  setContextToken(accountId: string, conversationRef: string, token: string): Promise<void>;
  forgetConversation(accountId: string, conversationRef: string): Promise<void>;
}

export function createWeixinSecretStore(deps: {
  credentials: CredentialStore;
  logger: Logger;
  nowIso: () => string;
}): WeixinSecretStore {
  const cache = new Map<string, WeixinAccountSecret>();

  async function load(accountId: string): Promise<WeixinAccountSecret> {
    const cached = cache.get(accountId);
    if (cached !== undefined) return cached;
    const raw = await deps.credentials.getSecret(accountId);
    const secret = normalizeSecret(raw);
    cache.set(accountId, secret);
    return secret;
  }

  async function save(accountId: string, secret: WeixinAccountSecret): Promise<void> {
    const next: WeixinAccountSecret = { ...secret, savedAt: deps.nowIso() };
    cache.set(accountId, next);
    await deps.credentials.putSecret(accountId, next as unknown as Record<string, unknown>);
  }

  return {
    load,
    save,
    async update(accountId, patch) {
      const current = await load(accountId);
      const next = patch(current);
      await save(accountId, next);
      return next;
    },
    async clear(accountId) {
      cache.delete(accountId);
      await deps.credentials.deleteSecret(accountId);
    },
    has: (accountId) => deps.credentials.hasSecret(accountId),
    async getContextToken(accountId, conversationRef) {
      const secret = await load(accountId);
      return secret.contextTokens[conversationRef] ?? null;
    },
    async setContextToken(accountId, conversationRef, token) {
      await this.update(accountId, (current) => ({
        ...current,
        contextTokens: { ...current.contextTokens, [conversationRef]: token },
      }));
    },
    async forgetConversation(accountId, conversationRef) {
      await this.update(accountId, (current) => {
        const next = { ...current.contextTokens };
        delete next[conversationRef];
        return { ...current, contextTokens: next };
      });
    },
  };
}

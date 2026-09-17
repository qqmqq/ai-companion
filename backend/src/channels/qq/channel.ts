import type { ChannelAccountInfo, ChannelCapabilities, ChannelHealth, ChannelKind } from "../../core/model/channel.ts";
import type { InboundHandler, SendReceipt, ChannelAdapter } from "../../core/ports/channel.ts";
import type { InternalMessage, InternalResponse } from "../../core/model/message.ts";
import type { ChannelRepository, SettingsRepository } from "../../core/ports/repositories.ts";
import type { CredentialStore } from "../../core/ports/credential-store.ts";
import type { DomainEventPublisher } from "../../core/ports/events.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";
import { uuidv7 } from "../../util/ids.ts";
import { QQ_CHANNEL_KIND } from "./types.ts";
import { QQ_SETTINGS, readQQConfig, readQQSecret, saveQQSecret } from "./config.ts";
import { createQQTokenManager } from "./auth/token-manager.ts";
import { createQQGateway, QQ_DEFAULT_INTENTS } from "./gateway/gateway.ts";
import { mapQQGatewayEvent, parseQQConversationRef, qqConversationRef } from "./receiver/inbound-mapper.ts";
import { createQQSender } from "./sender/sender.ts";
import { createQQSessionState, toAccountStatus, type QQConnectionState } from "./session-state.ts";

/**
 * QQ 渠道适配层。
 *
 * Core 只看到 InternalMessage / InternalResponse；协议、鉴权、重连、配额都在这里。
 * 传输方式目前是官方网关（WebSocket）；媒体与 Markdown 还没接，capabilities 里如实写 false。
 */
export interface QQChannelDeps {
  logger: Logger;
  clock: Clock;
  events: DomainEventPublisher;
  credentials: CredentialStore;
  settings: SettingsRepository;
  accounts: ChannelRepository;
  userId: string;
  fetchImpl?: typeof fetch;
  /** 测试注入：替换 WebSocket 实现 */
  webSocketImpl?: typeof WebSocket;
  intents?: number;
}

/** 被动回复的凭据只在一小段时间内有效：超过这个时间就不再拿它去回复 */
const PASSIVE_WINDOW_MS = 4 * 60 * 1000;

export function createQQChannel(deps: QQChannelDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const session = createQQSessionState({ now: () => deps.clock.now().getTime() });
  /** 最近一条入站消息的 id：出站时用它做"被动回复"（按会话引用分开记） */
  const lastInbound = new Map<string, { msgId: string; at: number }>();
  let handler: InboundHandler | null = null;
  let lastEventAtMs: number | null = null;

  const tokens = createQQTokenManager({
    config: () => readQQConfig(deps.settings),
    secret: async () => {
      const config = readQQConfig(deps.settings);
      return config === null ? null : await readQQSecret(deps.credentials, config.appId);
    },
    logger: deps.logger,
    clock: deps.clock,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  const sender = createQQSender({
    config: () => readQQConfig(deps.settings),
    accessToken: () => tokens.get(),
    logger: deps.logger,
    clock: deps.clock,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  /** 带鉴权拿网关地址：GET /gateway */
  async function gatewayUrl(): Promise<string> {
    const config = readQQConfig(deps.settings);
    if (config === null) throw new Error("QQ 渠道还没配置");
    const token = await tokens.get();
    const response = await doFetch(config.baseUrl + "/gateway", { headers: { authorization: "QQBot " + token } });
    const text = await response.text();
    if (!response.ok) throw new Error("取 QQ 网关地址失败（HTTP " + response.status + "）：" + text.slice(0, 160));
    const parsed = JSON.parse(text) as { url?: unknown };
    if (typeof parsed.url !== "string" || parsed.url.length === 0) throw new Error("QQ 网关响应里没有 url");
    return parsed.url;
  }

  const gateway = createQQGateway({
    logger: deps.logger,
    gatewayUrl,
    accessToken: () => tokens.get(),
    intents: deps.intents ?? QQ_DEFAULT_INTENTS,
    onStateChange: (state, error) => {
      session.mark(state as QQConnectionState, error ?? null);
      void upsertAccount();
    },
    onEvent: (event) => {
      lastEventAtMs = deps.clock.now().getTime();
      session.touchEvent();
      const config = readQQConfig(deps.settings);
      if (config === null) return;
      const message = mapQQGatewayEvent(event, {
        accountId: config.appId,
        receivedAt: deps.clock.nowIso(),
        newId: () => uuidv7(),
      });
      if (message === null) {
        deps.logger.debug("qq event ignored", { step: "qq.inbound", eventType: event.t });
        return;
      }
      const msgId = message.metadata.msgId;
      if (typeof msgId === "string" && msgId.length > 0) {
        lastInbound.set(message.conversationId, { msgId, at: deps.clock.now().getTime() });
      }
      deps.logger.info("qq inbound message received", {
        step: "qq.inbound",
        status: "completed",
        eventType: event.t,
        conversationRef: message.conversationId,
      });
      deps.events.publish({ name: "message.new", at: deps.clock.nowIso(), channel: QQ_CHANNEL_KIND, payload: { conversationId: message.conversationId, messageId: message.id } });
      if (handler !== null) void handler(message);
    },
    ...(deps.webSocketImpl === undefined ? {} : { webSocketImpl: deps.webSocketImpl }),
  });

  async function upsertAccount(): Promise<void> {
    const config = readQQConfig(deps.settings);
    if (config === null) return;
    const snapshot = session.snapshot();
    deps.accounts.upsertAccount({
      id: "qq:" + config.appId,
      channel: QQ_CHANNEL_KIND,
      externalAccountId: config.appId,
      displayName: "QQ 机器人 " + config.appId,
      status: toAccountStatus(snapshot.state),
      createdAt: deps.clock.nowIso(),
      boundUserId: deps.userId,
    });
  }

  return {
    kind: QQ_CHANNEL_KIND as ChannelKind,

    capabilities: {
      text: true,
      media: { image: false, audio: false, video: false, file: false },
      maxTextLength: 1000,
      supportsReplyQuote: false,
      supportsTyping: false,
      supportsEditMessage: false,
      supportsStreamingAppend: false,
      loginMethod: "token",
    } satisfies ChannelCapabilities,

    async start(): Promise<void> {
      deps.accounts.ensureChannel(QQ_CHANNEL_KIND, true);
      const config = readQQConfig(deps.settings);
      if (config === null) {
        session.mark("not_configured");
        deps.logger.info("qq channel is not configured yet", { step: "qq.start", status: "skipped" });
        return;
      }
      const secret = await readQQSecret(deps.credentials, config.appId);
      if (secret === null) {
        session.mark("credential_invalid", "还没有保存 clientSecret");
        await upsertAccount();
        deps.logger.warn("qq channel has appId but no clientSecret", { step: "qq.start", status: "failed" });
        return;
      }
      await upsertAccount();
      await gateway.start();
    },

    async stop(): Promise<void> {
      gateway.stop();
      session.mark("stopped");
      await upsertAccount();
    },

    async health(): Promise<ChannelHealth> {
      const config = readQQConfig(deps.settings);
      const snapshot = session.snapshot();
      const state: ChannelHealth["state"] =
        snapshot.state === "connected"
          ? "healthy"
          : snapshot.state === "connecting" || snapshot.state === "reconnecting"
            ? "starting"
            : snapshot.state === "credential_invalid" || snapshot.state === "disconnected"
              ? "degraded"
              : "stopped";
      return {
        channel: QQ_CHANNEL_KIND,
        state,
        accounts: config === null ? 0 : 1,
        lastEventAt: lastEventAtMs === null ? null : new Date(lastEventAtMs).toISOString(),
        message: snapshot.lastError,
      };
    },

    async listAccounts(): Promise<ChannelAccountInfo[]> {
      return deps.accounts.listAccounts(QQ_CHANNEL_KIND);
    },

    async removeAccount(accountId: string): Promise<void> {
      gateway.stop();
      await deps.credentials.deleteSecret(accountId);
      session.mark("not_configured");
      deps.logger.info("qq account credentials removed", { step: "qq.account", status: "completed", accountId });
    },

    onInbound(next: InboundHandler): void {
      handler = next;
    },

    /** 出站：按会话引用还原成单聊/群聊，优先用被动回复（带上触发消息的 msg_id） */
    async send(response: InternalResponse): Promise<SendReceipt> {
      const target = parseQQConversationRef(response.conversationId);
      if (target === null) throw new Error("QQ 会话引用无法解析：" + response.conversationId);
      const text = response.parts
        .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
        .map((part) => part.text)
        .join(String.fromCharCode(10))
        .trim();
      if (text.length === 0) throw new Error("QQ 消息没有可发送的文本内容");
      const mediaParts = response.parts.filter((part) => part.kind !== "text" && part.kind !== "typing");
      if (mediaParts.length > 0) {
        deps.logger.warn("qq media parts are not supported yet; text only", { step: "qq.send", parts: mediaParts.length });
      }
      const recent = lastInbound.get(response.conversationId);
      const withinWindow = recent !== undefined && deps.clock.now().getTime() - recent.at <= PASSIVE_WINDOW_MS;
      const result = await sender.sendText({
        scope: target.scope,
        targetId: target.targetId,
        text,
        msgId: withinWindow ? (recent as { msgId: string }).msgId : null,
      });
      return { idempotencyKey: response.idempotencyKey, providerMessageId: result.providerMessageId, acceptedAt: deps.clock.nowIso() };
    },

    // ── 给管理接口用的控制面（不属于 ChannelAdapter 契约）──

    /** 保存 appId / clientSecret / 沙箱开关；密钥只进加密库 */
    async configure(input: { appId: string; clientSecret?: string; sandbox?: boolean }): Promise<void> {
      deps.settings.put(QQ_SETTINGS.appId, input.appId, deps.clock.nowIso());
      if (input.sandbox !== undefined) deps.settings.put(QQ_SETTINGS.sandbox, input.sandbox, deps.clock.nowIso());
      if (typeof input.clientSecret === "string" && input.clientSecret.length > 0) {
        await saveQQSecret(deps.credentials, input.appId, input.clientSecret);
      }
      tokens.invalidate();
    },

    async reconnect(): Promise<void> {
      gateway.stop();
      tokens.invalidate();
      await gateway.start();
    },

    status() {
      const config = readQQConfig(deps.settings);
      return {
        configured: config !== null,
        appId: config?.appId ?? null,
        sandbox: config?.sandbox ?? null,
        baseUrl: config?.baseUrl ?? null,
        session: session.snapshot(),
        token: tokens.status(),
      };
    },

    /** 只回答"密钥配没配"，绝不返回值本身 */
    async hasCredentials(): Promise<boolean> {
      const config = readQQConfig(deps.settings);
      if (config === null) return false;
      return await deps.credentials.hasSecret(config.appId);
    },

    /** 测试与排查用：当前记着的被动回复凭据数量 */
    passiveTargets(): number {
      return lastInbound.size;
    },
  };
}

export type QQChannel = ReturnType<typeof createQQChannel>;

export { qqConversationRef, QQ_CHANNEL_KIND };


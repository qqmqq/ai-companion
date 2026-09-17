import { createTestDatabase } from "./db.ts";
import { createFakeClock, type FakeClock } from "./fake-clock.ts";
import { createChannelRepository } from "../../src/storage/repositories/channels.ts";
import { createCredentialRepository } from "../../src/storage/repositories/credentials.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createSqliteCredentialStore } from "../../src/security/credential-store.ts";
import { generateKey } from "../../src/security/crypto.ts";
import { inMemoryKeyProvider } from "../../src/security/key-provider.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createEventBus } from "../../src/app/events.ts";
import { createWeixinChannel, type WeixinChannel } from "../../src/channels/weixin/channel.ts";
import { createLocalMediaStorage } from "../../src/storage/media/local-media-storage.ts";
import { startMockWeixinServer, type MockWeixinConfig, type MockWeixinServer } from "./mock-weixin-server.ts";
import type { SqlDatabase } from "../../src/core/ports/channel-module.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaStorage } from "../../src/core/ports/media-storage.ts";

export interface WeixinStack {
  db: ReturnType<typeof createTestDatabase>;
  clock: FakeClock;
  channel: WeixinChannel;
  credentials: ReturnType<typeof createSqliteCredentialStore>;
  accounts: ReturnType<typeof createChannelRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  mediaStorage: MediaStorage;
  server: MockWeixinServer;
  inbound: Array<{ conversationId: string; text: string; messageId: string }>;
  close(): Promise<void>;
}

export interface WeixinStackOptions extends MockWeixinConfig {
  senderOptions?: Parameters<typeof createWeixinChannel>[0]["senderOptions"];
  receiverOptions?: Parameters<typeof createWeixinChannel>[0]["receiverOptions"];
}

/** 组装一个"只依赖注入"的微信渠道：真实协议代码 + mock 微信后端 + 内存数据库。 */
export async function createWeixinStack(options: WeixinStackOptions = {}): Promise<WeixinStack> {
  const server = await startMockWeixinServer(options);
  const db = createTestDatabase();
  const clock = createFakeClock();
  const logger = createLogger({ level: "error", sink: () => {} });
  const credentials = createSqliteCredentialStore({
    repository: createCredentialRepository(db),
    keyProvider: inMemoryKeyProvider(generateKey()),
    nowIso: () => clock.nowIso(),
  });
  const accounts = createChannelRepository(db);
  const settings = createSettingsRepository(db);
  accounts.ensureChannel("weixin", true);
  const dataDir = mkdtempSync(join(tmpdir(), "weixin-stack-"));
  const mediaStorage = createLocalMediaStorage({ dataDir, logger, clock });

  const inbound: Array<{ conversationId: string; text: string; messageId: string }> = [];

  const channel = createWeixinChannel({
    logger,
    clock,
    events: createEventBus(),
    credentials,
    settings,
    accounts,
    db: db.raw as unknown as SqlDatabase,
    mediaStorage,
    userId: "u1",
    baseUrl: server.baseUrl,
    fetchImpl: fetch,
    ...(options.senderOptions === undefined ? {} : { senderOptions: options.senderOptions }),
    ...(options.receiverOptions === undefined ? {} : { receiverOptions: options.receiverOptions }),
  });

  channel.onInbound(async (message) => {
    const text = message.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("");
    inbound.push({ conversationId: message.conversationId, text, messageId: message.externalRef.providerMessageId });
  });

  return {
    db,
    clock,
    channel,
    credentials,
    accounts,
    settings,
    mediaStorage,
    server,
    inbound,
    close: async () => {
      await channel.stop().catch(() => {});
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
      db.close();
    },
  };
}

/**
 * 完成一次登录并把账号注册进 channel_accounts。
 *
 * 默认会停掉后台轮询循环：测试要自己驱动"拉一批 / 处理一批"，
 * 否则后台循环会把 batch 抢走，测试就变成随机失败。
 * 需要验证真实循环时传 autoStart: true。
 */
export async function loginWeixinAccount(
  stack: WeixinStack,
  options: { accountId?: string; token?: string; userId?: string; autoStart?: boolean } = {},
): Promise<string> {
  if (options.accountId !== undefined) stack.server.config.accountId = options.accountId;
  if (options.token !== undefined) stack.server.config.botToken = options.token;
  if (options.userId !== undefined) stack.server.config.ilinkUserId = options.userId;
  stack.server.config.qrStatuses = ["wait", "scaned", "confirmed"];

  const session = await stack.channel.startLogin();
  await stack.channel.pollLogin(session.sessionId);
  await stack.channel.pollLogin(session.sessionId);
  const finalState = await stack.channel.pollLogin(session.sessionId);
  if (finalState?.phase !== "logged_in") {
    throw new Error(`login did not complete: ${finalState?.phase} ${finalState?.message}`);
  }
  const result = await stack.channel.completeLogin(session.sessionId);
  if (options.autoStart !== true) {
    await stack.channel.stop();
  }
  return result.accountId;
}
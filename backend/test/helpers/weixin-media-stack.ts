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
import { startMockWeixinServer, type MockWeixinServer } from "./mock-weixin-server.ts";
import { startMockCdnServer, type MockCdnConfig, type MockCdnServer } from "./mock-weixin-cdn.ts";
import type { SqlDatabase } from "../../src/core/ports/channel-module.ts";
import type { MediaStorage } from "../../src/core/ports/media-storage.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WeixinMediaStack {
  db: ReturnType<typeof createTestDatabase>;
  clock: FakeClock;
  channel: WeixinChannel;
  accountId: string;
  server: MockWeixinServer;
  cdn: MockCdnServer;
  mediaStorage: MediaStorage;
  /** 捕获的日志行（用于断言敏感信息不落日志） */
  logLines: string[];
  /** 测试用的数据目录（媒体存储根目录就在它下面） */
  dataDir: string;
  close(): Promise<void>;
}

export interface WeixinMediaStackOptions extends MockCdnConfig {
  mediaOptions?: Parameters<typeof createWeixinChannel>[0]["mediaOptions"];
  /** 测试注入的语音编解码器（默认是真实的 silk-wasm 实现） */
  voiceCodec?: Parameters<typeof createWeixinChannel>[0]["voiceCodec"];
}

/** 微信媒体传输测试栈：真实协议代码 + mock 微信后端 + mock CDN + 内存数据库。 */
export async function createWeixinMediaStack(options: WeixinMediaStackOptions = {}): Promise<WeixinMediaStack> {
  const cdn = await startMockCdnServer(options);
  const server = await startMockWeixinServer({
    qrStatuses: ["confirmed"],
    botToken: "token-media-A",
    accountId: "acct-media-A",
    ilinkUserId: "self-media-A",
    cdnBaseUrl: cdn.baseUrl,
  });

  const db = createTestDatabase();
  const clock = createFakeClock();
  const logLines: string[] = [];
  const logger = createLogger({ level: "trace", sink: (line) => logLines.push(line) });
  const credentials = createSqliteCredentialStore({
    repository: createCredentialRepository(db),
    keyProvider: inMemoryKeyProvider(generateKey()),
    nowIso: () => clock.nowIso(),
  });
  const accounts = createChannelRepository(db);
  const settings = createSettingsRepository(db);
  accounts.ensureChannel("weixin", true);
  settings.put("weixin.cdnBaseUrl", cdn.baseUrl, clock.nowIso());
  const dataDir = mkdtempSync(join(tmpdir(), "weixin-media-"));
  const mediaStorage = createLocalMediaStorage({ dataDir, logger, clock });

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
    mediaOptions: {
      maxAttempts: 3,
      baseDelayMs: 1,
      jitterRatio: 0,
      random: () => 0.5,
      sleepImpl: async () => {},
      ...(options.mediaOptions ?? {}),
    },
    ...(options.voiceCodec === undefined ? {} : { voiceCodec: options.voiceCodec }),
  });

  const session = await channel.startLogin();
  await channel.pollLogin(session.sessionId);
  const { accountId } = await channel.completeLogin(session.sessionId);
  await channel.stop();

  return {
    db,
    clock,
    channel,
    accountId,
    server,
    cdn,
    mediaStorage,
    logLines,
    dataDir,
    close: async () => {
      await channel.stop().catch(() => {});
      await server.close();
      await cdn.close();
      rmSync(dataDir, { recursive: true, force: true });
      db.close();
    },
  };
}

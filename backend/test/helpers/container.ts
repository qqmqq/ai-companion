import { createContainer, startChannels, type Container } from "../../src/app/bootstrap.ts";
import { createHttpServer } from "../../src/app/http-server.ts";
import { loadConfig } from "../../src/app/config.ts";
import { inMemoryKeyProvider } from "../../src/security/key-provider.ts";
import { generateKey } from "../../src/security/crypto.ts";
import { createLogger } from "../../src/app/logger.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestContainerOptions {
  /** 让可选渠道（如微信）把 HTTP 请求打到测试替身 */
  fetchImpl?: typeof fetch;
  startSchedulerTimer?: boolean;
  settingsSeed?: Record<string, unknown>;
}

export async function createTestContainer(options: TestContainerOptions = {}): Promise<Container> {
  const config = loadConfig({
    COMPANION_DATA_DIR: mkdtempSync(join(tmpdir(), "companion-test-")),
    COMPANION_LOG_LEVEL: "error",
  });
  return await createContainer({
    config,
    databasePath: ":memory:",
    keyProvider: inMemoryKeyProvider(generateKey()),
    logger: createLogger({ level: "error", sink: () => {} }),
    startSchedulerTimer: options.startSchedulerTimer ?? false,
    ...(options.settingsSeed === undefined ? {} : { settingsSeed: options.settingsSeed }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

export async function createRunningServer(options: TestContainerOptions = {}): Promise<{
  container: Container;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const container = await createTestContainer(options);
  await startChannels(container);
  const app = createHttpServer(container);

  /**
   * 绑定到 0 端口拿一个空闲端口。
   * 曾经偶发拿到 port=0 的地址（并在 fetch 时报成没好气的 "bad port"）：
   * 这里显式检查，拿到 0 就重试一次；仍然不对就报出 address 原文，别让它变成一个谜。
   */
  let address = null as ReturnType<typeof app.server.address>;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const current = app.server.address();
    if (current !== null && typeof current !== "string" && current.port > 0) {
      address = current;
      break;
    }
    await app.close();
  }
  if (address === null || typeof address === "string") {
    throw new Error("test server did not get a usable port: " + JSON.stringify(app.server.address()));
  }
  return {
    container,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
      await container.shutdown();
    },
  };
}
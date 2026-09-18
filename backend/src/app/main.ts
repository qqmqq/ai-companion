import { loadConfig } from "./config.ts";
import { createContainer, startChannels } from "./bootstrap.ts";
import { createHttpServer } from "./http-server.ts";

/** 把任意抛出物变成一句能进日志的话（含堆栈），不吞掉关键信息 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer({ config });
  const app = createHttpServer(container);

  await startChannels(container);
  await app.listen({ host: config.host, port: config.port });
  container.logger.info("ai companion started", { url: `http://${config.host}:${config.port}` });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info("shutting down", { signal });
    try {
      await app.close();
      await container.shutdown();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  /**
   * 后台异步炸掉时，Node 默认直接杀进程、什么也不说 —— 用户看到的就是"前端突然全是 500"。
   * 这里把原因（含堆栈）记进日志，再按正常关机退出，让外面的守护进程重启它。
   */
  process.on("unhandledRejection", (reason) => {
    container.logger.error("unhandled rejection; shutting down", { error: errorText(reason) });
    void shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    container.logger.error("uncaught exception; shutting down", { error: errorText(error) });
    void shutdown("uncaughtException");
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
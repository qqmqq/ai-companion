import { loadConfig } from "./config.ts";
import { createContainer, startChannels } from "./bootstrap.ts";
import { createHttpServer } from "./http-server.ts";

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
}

main().catch((error: unknown) => {
  process.stderr.write(`failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
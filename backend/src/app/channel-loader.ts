import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChannelAdapter } from "../core/ports/channel.ts";
import type { ChannelModule, ChannelModuleContext } from "../core/ports/channel-module.ts";
import type { Logger } from "../core/ports/logger.ts";

/**
 * 在 channels/ 目录里发现可选渠道模块。
 *
 * 为什么不用静态 import：那样删掉某个渠道目录后组合根就无法编译，
 * "可删除性"（ARCH-7）会变成假隔离。这里用运行时发现的动态说明符，
 * 既没有任何模块解析耦合，也不需要在组合根里写死渠道名字。
 */
export async function discoverChannelModules(
  channelsDir: string,
  logger: Logger,
): Promise<Array<{ name: string; module: ChannelModule }>> {
  const found: Array<{ name: string; module: ChannelModule }> = [];
  let entries: string[];
  try {
    entries = readdirSync(channelsDir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const dir = join(channelsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const indexPath = join(dir, "index.ts");
    try {
      statSync(indexPath);
    } catch {
      continue;
    }
    const specifier = `./../channels/${entry}/index.ts`;
    try {
      const loaded = (await import(specifier)) as Partial<ChannelModule>;
      if (typeof loaded.createChannel !== "function" || typeof loaded.kind !== "string") {
        logger.debug("channel directory has no channel module", { entry });
        continue;
      }
      found.push({ name: entry, module: loaded as ChannelModule });
    } catch (error) {
      logger.warn("failed to load channel module", { entry, error: (error as Error).message });
    }
  }
  return found;
}

export async function instantiateChannelModules(
  channelsDir: string,
  context: ChannelModuleContext,
): Promise<Array<{ name: string; kind: string; channel: ChannelAdapter; module: ChannelModule }>> {
  const modules = await discoverChannelModules(channelsDir, context.logger);
  const instances: Array<{ name: string; kind: string; channel: ChannelAdapter; module: ChannelModule }> = [];
  for (const { name, module } of modules) {
    try {
      const channel = await module.createChannel(context);
      instances.push({ name, kind: module.kind, channel, module });
    } catch (error) {
      context.logger.error("channel module failed to initialize", { entry: name, error: (error as Error).message });
    }
  }
  return instances;
}

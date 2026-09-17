import type { ChannelAdapter } from "./channel.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { CredentialStore } from "./credential-store.ts";
import type { MediaStorage } from "./media-storage.ts";
import type { DomainEventPublisher } from "./events.ts";
import type { Logger } from "./logger.ts";
import type { Clock } from "./clock.ts";
import type { ChannelRepository, SettingsRepository } from "./repositories.ts";

/**
 * 可选渠道模块的契约。
 *
 * 组合根不 import 任何具体渠道，而是在 channels/ 目录里**发现**实现了本接口的模块。
 * 因此删掉某个渠道目录后，Core 与其它渠道仍然可以编译、构建、测试（ARCH-7）。
 */
/** 渠道需要的数据库能力，用结构化类型表达，Core 不 import 任何 storage 实现。 */
export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number | bigint };
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}

export interface ChannelModuleContext {
  logger: Logger;
  clock: Clock;
  events: DomainEventPublisher;
  credentials: CredentialStore;
  settings: SettingsRepository;
  accounts: ChannelRepository;
  /** 当前登录用户 id（渠道账号归属） */
  userId: string;
  dataDir: string;
  db: SqlDatabase;
  /** 平台无关的媒体存储：渠道用它把入站媒体落库、按 mediaId 取出出站媒体 */
  mediaStorage: MediaStorage;
  /** 测试注入：替换 HTTP 实现 */
  fetchImpl?: typeof fetch;
}

/** 渠道自己的 HTTP 路由宿主（避免渠道直接依赖具体 web 框架）。 */
export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
}

export interface RouteReply {
  code(status: number): void;
}

export type RouteHandler = (request: RouteRequest, reply: RouteReply) => Promise<unknown> | unknown;

export interface HttpRouteHost {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
}

export interface ChannelRoutesDeps {
  channels: ChannelRegistry;
  logger: Logger;
}

export interface ChannelModule {
  /** 渠道种类标识（不透明字符串） */
  readonly kind: string;
  createChannel(context: ChannelModuleContext): Promise<ChannelAdapter> | ChannelAdapter;
  /** 渠道自己的管理接口（登录、账号、状态…） */
  registerRoutes?(host: HttpRouteHost, deps: ChannelRoutesDeps): void;
}
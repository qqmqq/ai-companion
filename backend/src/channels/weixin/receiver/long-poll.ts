import type { InternalMessage } from "../../../core/model/message.ts";
import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import type { WeixinHttp } from "../protocol/http-client.ts";
import { ENDPOINTS, buildUrl } from "../protocol/endpoints.ts";
import { STALE_TOKEN_ERRCODE, type GetUpdatesResponse, type WeixinMessage } from "../protocol/types.ts";
import { buildBaseInfo } from "../protocol/headers.ts";
import { computeBackoffMs, sleep } from "../protocol/backoff.ts";
import { WeixinTransportError, isAbortError } from "../protocol/errors.ts";
import type { WeixinSecretStore } from "../auth/account-secret.ts";
import type { SessionStateRegistry } from "../auth/session-state.ts";
import type { CursorStore } from "./cursor-store.ts";
import type { DedupStore } from "./dedup-store.ts";
import {
  applyMediaReferences,
  mapWeixinMessage,
  markMediaFailed,
  type InboundMediaCandidate,
  type InboundSkipReason,
} from "./inbound-mapper.ts";
import type { MediaReference } from "../../../core/model/media.ts";

export interface InboundEnvelope {
  message: InternalMessage;
  contextToken: string | null;
  conversationRef: string;
}

export interface InboundHandler {
  (envelope: InboundEnvelope): Promise<void>;
}

export interface BatchOutcome {
  received: number;
  processed: number;
  duplicates: number;
  skipped: number;
  failed: number;
  committed: boolean;
  cursor: string | null;
  reason: string | null;
}

export interface ReceiverOptions {
  signal?: AbortSignal;
}

export interface LongPollReceiverDeps {
  http: WeixinHttp;
  secrets: WeixinSecretStore;
  cursorStore: (accountId: string) => CursorStore;
  dedup: (accountId: string) => DedupStore;
  sessionState: SessionStateRegistry;
  logger: Logger;
  clock: Clock;
  baseUrl: string;
  botAgent?: string;
  channelKind: string;
  onInbound: InboundHandler;
  /** 默认长轮询超时；服务端返回 longpolling_timeout_ms 时以服务端为准 */
  longPollTimeoutMs?: number;
  maxBatchFailures?: number;
  backoff?: { baseMs?: number; maxMs?: number; jitterRatio?: number; random?: () => number };
  /** 每轮之间最少间隔（默认 0；有消息时可设为很小值） */
  idleDelayMs?: number;
  hydrateMedia?: (candidates: InboundMediaCandidate[]) => Promise<Map<number, MediaReference>>;
}

/** 一批消息里有处理失败时抛出：不 commit 游标，整批重取。 */
export class BatchIncompleteError extends Error {
  readonly accountId: string;
  readonly failedMessageId: string;
  override readonly cause: unknown;

  constructor(accountId: string, failedMessageId: string, cause: unknown) {
    super(`batch incomplete for account ${accountId}: message ${failedMessageId} failed`);
    this.name = "BatchIncompleteError";
    this.accountId = accountId;
    this.failedMessageId = failedMessageId;
    this.cause = cause;
  }
}

export function createLongPollReceiver(deps: LongPollReceiverDeps) {
  const defaultLongPoll = deps.longPollTimeoutMs ?? 30_000;

  function readToken(accountId: string): Promise<string | null> {
    return deps.secrets.load(accountId).then((secret) => (secret.botToken.length > 0 ? secret.botToken : null));
  }

  /**
   * 拉取并处理一批消息（两阶段游标的完整一轮）。
   *
   * 顺序（不可调换）：
   *   读 committed 游标 → getupdates → 保存 pending 游标 → 逐条处理 → 全部完成才 commit
   * 任何一条处理失败：释放它的去重声明、抛出 BatchIncompleteError、**不 commit**。
   */
  async function runOnce(accountId: string, options: ReceiverOptions = {}): Promise<BatchOutcome> {
    const state = deps.sessionState.get(accountId);
    if (state.requiresRelogin) {
      return { received: 0, processed: 0, duplicates: 0, skipped: 0, failed: 0, committed: false, cursor: null, reason: "credential_invalid" };
    }

    const token = await readToken(accountId);
    if (token === null) {
      return { received: 0, processed: 0, duplicates: 0, skipped: 0, failed: 0, committed: false, cursor: null, reason: "no_credential" };
    }

    const secret = await deps.secrets.load(accountId);
    const baseUrl = secret.baseUrl.length > 0 ? secret.baseUrl : deps.baseUrl;
    const cursorStore = deps.cursorStore(accountId);
    const dedup = deps.dedup(accountId);

    // 崩溃恢复：上一轮有未提交的 pending → 从 committed 重新拉取（去重表保证不重复处理）
    const stale = cursorStore.pending(accountId);
    if (stale !== null) {
      deps.logger.warn("uncommitted cursor found; re-polling from last committed position", { accountId });
      cursorStore.savePending(accountId, "");
    }

    const requestBuffer = cursorStore.load(accountId).committed;
    const response = await deps.http.postJson<GetUpdatesResponse>(
      buildUrl(baseUrl, ENDPOINTS.getUpdates),
      { get_updates_buf: requestBuffer, base_info: buildBaseInfo(deps.botAgent) },
      {
        label: "getupdates",
        timeoutMs: defaultLongPoll + 5_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    const ret = response.ret ?? 0;
    const errcode = response.errcode ?? 0;
    if (ret === STALE_TOKEN_ERRCODE || errcode === STALE_TOKEN_ERRCODE) {
      deps.sessionState.markCredentialInvalid(accountId, "errcode -14");
      throw new WeixinTransportError("stale_token", "微信凭证已失效（errcode -14）", { retryable: false });
    }
    if (ret !== 0 || errcode !== 0) {
      deps.sessionState.recordFailure(accountId, `ret=${ret} errcode=${errcode}`);
      throw new WeixinTransportError("business", `getupdates 失败：ret=${ret} errcode=${errcode} ${response.errmsg ?? ""}`.trim(), {
        retryable: true,
      });
    }

    deps.sessionState.resetFailures(accountId);
    // 若这一轮与 -14 竞争，不要"复活"已失效的账号
    if (!deps.sessionState.get(accountId).requiresRelogin && deps.sessionState.get(accountId).state !== "connected") {
      deps.sessionState.markConnected(accountId);
    }

    const nextCursor = typeof response.get_updates_buf === "string" ? response.get_updates_buf : "";
    const messages: WeixinMessage[] = response.msgs ?? [];

    if (nextCursor.length > 0) cursorStore.savePending(accountId, nextCursor);

    let processed = 0;
    let duplicates = 0;
    let skippedCount = 0;

    for (const raw of messages) {
      const mapped = mapWeixinMessage({
        channelKind: deps.channelKind,
        accountId,
        raw,
        nowIso: deps.clock.nowIso(),
        // 自身 id = 机器人自己的 id（登录响应的 ilink_bot_id，也就是 accountId）。
        // 这里**不能**用 secret.ilinkUserId：那是扫码的那个"人"的 id，
        // 用它做 self 判定会把用户发给机器人的每一条消息都当成自己发的（self_echo）丢掉。
        selfUserId: accountId,
      });

      if (mapped.mapped === null) {
        skippedCount += 1;
        // 以前这里是 debug：真的把消息丢掉时日志里什么都看不见。丢消息必须可见。
        deps.logger.info("weixin inbound skipped", {
          step: "weixin.inbound",
          status: "skipped",
          accountId,
          reason: mapped.skipped satisfies InboundSkipReason | null,
        });
        continue;
      }

      const envelope = mapped.mapped;
      if (!dedup.claim(accountId, envelope.providerMessageId)) {
        duplicates += 1;
        continue;
      }

      try {
        // 先把 context_token 落到账号机密里（渠道 transport state），再交给 Core
        if (envelope.contextToken !== null) {
          await deps.secrets.setContextToken(accountId, envelope.conversationRef, envelope.contextToken);
        }

        // 媒体水化：下载 → 解密 → 校验 → 入库 → 写回引用；失败只影响该图片
        if (envelope.mediaCandidates.length > 0 && deps.hydrateMedia !== undefined) {
          const indices = envelope.mediaCandidates.map((candidate) => candidate.partIndex);
          try {
            const references = await deps.hydrateMedia(envelope.mediaCandidates);
            envelope.message.parts = applyMediaReferences(envelope.message.parts, references);
            const missing = indices.filter((index) => !references.has(index));
            if (missing.length > 0) {
              envelope.message.parts = markMediaFailed(envelope.message.parts, missing);
            }
          } catch (error) {
            // 媒体整体失败：标记 failed，消息继续投递
            deps.logger.warn("weixin inbound media hydration failed", { accountId, error: (error as Error).message });
            envelope.message.parts = markMediaFailed(envelope.message.parts, indices);
          }
        }

        await deps.onInbound(envelope);
        processed += 1;
      } catch (error) {
        // 释放去重声明，让重取时可以再次处理；并且不 commit 游标
        dedup.release(accountId, envelope.providerMessageId);
        deps.sessionState.recordFailure(accountId, (error as Error).message);
        deps.logger.warn("weixin inbound handling failed; batch will be retried", {
          accountId,
          error: (error as Error).message,
        });
        throw new BatchIncompleteError(accountId, envelope.providerMessageId, error);
      }
    }

    /**
     * 轮询心跳（默认关闭，COMPANION_WEIXIN_TRACE=1 打开）：
     * 只记协议层的"这一轮拉到了什么"，用来证明 long poll 是持续运行而不是请求一次就结束。
     * 不含任何 token / 消息内容。
     */
    if (process.env.COMPANION_WEIXIN_TRACE === "1") {
      deps.logger.info("weixin poll trace", {
        step: "weixin.poll",
        status: "completed",
        accountId,
        ret,
        errcode,
        received: messages.length,
        cursorChanged: nextCursor !== requestBuffer,
      });
    }

    if (messages.length > 0) {
      deps.logger.info("weixin inbound batch processed", {
        step: "weixin.inbound",
        status: "completed",
        accountId,
        received: messages.length,
        processed,
        duplicates,
        skipped: skippedCount,
      });
    }

    if (nextCursor.length > 0) {
      cursorStore.commit(accountId, nextCursor);
    }

    return {
      received: messages.length,
      processed,
      duplicates,
      skipped: skippedCount,
      failed: 0,
      committed: nextCursor.length > 0,
      cursor: nextCursor.length > 0 ? nextCursor : null,
      reason: null,
    };
  }

  /** 持续轮询：失败退避重连；凭证失效立即停止（不再无限重连）。 */
  async function loop(accountId: string, options: ReceiverOptions = {}): Promise<void> {
    const backoff = deps.backoff ?? {};
    let failures = 0;
    const maxFailures = deps.maxBatchFailures ?? 5;

    while (options.signal?.aborted !== true) {
      try {
        const outcome = await runOnce(accountId, options);
        failures = 0;
        // runOnce 在"凭证失效/没有凭证"时会立即返回（既不请求后端也不等待网络）。
        // 这种情况必须**退出循环**：否则就是一个没有任何 await 让出机会的忙等，
        // 会把事件循环彻底饿死（重登后由 reloginAccount 重新拉起循环）。
        if (outcome.reason === "credential_invalid" || outcome.reason === "no_credential") {
          deps.logger.info("weixin polling loop stopped; waiting for re-login", { accountId, reason: outcome.reason });
          return;
        }
        if (deps.idleDelayMs !== undefined && deps.idleDelayMs > 0) await sleep(deps.idleDelayMs, options.signal);
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) return;

        if (error instanceof WeixinTransportError && error.kind === "stale_token") {
          deps.logger.warn("weixin polling stopped: credential invalid", { accountId });
          return; // 等待重新登录，不做无限重连
        }

        failures += 1;
        const reason = error instanceof Error ? error.message : String(error);
        deps.sessionState.markReconnecting(accountId, reason);

        if (failures >= maxFailures) {
          deps.logger.error("weixin polling paused after repeated failures", { accountId, failures });
          const delay = computeBackoffMs(failures, { baseMs: backoff.baseMs ?? 2_000, maxMs: backoff.maxMs ?? 60_000, ...backoff });
          deps.sessionState.setPause(accountId, new Date(deps.clock.now().getTime() + delay).toISOString());
          try {
            await sleep(delay, options.signal);
          } catch {
            return;
          }
          failures = 0;
          continue;
        }

        const delay = computeBackoffMs(failures - 1, { baseMs: backoff.baseMs ?? 500, maxMs: backoff.maxMs ?? 30_000, ...backoff });
        try {
          await sleep(delay, options.signal);
        } catch {
          return;
        }
      }
    }
  }

  return { runOnce, loop };
}

export type LongPollReceiver = ReturnType<typeof createLongPollReceiver>;
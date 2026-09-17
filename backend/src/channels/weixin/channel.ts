import type { ChannelAccountInfo, ChannelCapabilities, ChannelHealth, ChannelKind } from "../../core/model/channel.ts";
import type { InternalMessage, InternalResponse } from "../../core/model/message.ts";
import type { ChannelAdapter, InboundHandler, SendReceipt } from "../../core/ports/channel.ts";
import type { CredentialStore } from "../../core/ports/credential-store.ts";
import type { DomainEventPublisher } from "../../core/ports/events.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";
import type { ChannelRepository, SettingsRepository } from "../../core/ports/repositories.ts";
import type { SqlDatabase } from "../../core/ports/channel-module.ts";
import { DomainError } from "../../core/model/errors.ts";
import { randomToken } from "../../util/ids.ts";

import { DEFAULT_API_BASE_URL } from "./protocol/endpoints.ts";
import { createWeixinHttp, type WeixinHttp } from "./protocol/http-client.ts";
import { WeixinTransportError } from "./protocol/errors.ts";
import { createWeixinSecretStore, type WeixinSecretStore } from "./auth/account-secret.ts";
import { createSessionStateRegistry, type SessionStateRegistry, type WeixinAccountState } from "./auth/session-state.ts";
import { createQrLoginService, type QrLoginService, type QrLoginSessionView } from "./auth/qr-login.ts";
import { createCursorStore, type CursorStore } from "./receiver/cursor-store.ts";
import { createDedupStore, type DedupStore } from "./receiver/dedup-store.ts";
import { createLongPollReceiver, type LongPollReceiver, type BatchOutcome } from "./receiver/long-poll.ts";
import { createWeixinSender } from "./sender/sender.ts";
import { DEFAULT_CDN_BASE_URL } from "./protocol/endpoints.ts";
import type { MediaTransport } from "../../core/ports/media-transport.ts";
import type { MediaStorage } from "../../core/ports/media-storage.ts";
import type { MediaReference } from "../../core/model/media.ts";
import type { AudioPart, FilePart, ImagePart, VideoPart } from "../../core/model/message.ts";
import { sanitizeMediaReference } from "../../core/model/media.ts";
import type { InboundMediaCandidate } from "./receiver/inbound-mapper.ts";
import { validateImage } from "./media/image-validation.ts";
import { exceedsMediaLimit, sanitizeAttachmentFilename, validateFile } from "./media/file-validation.ts";
import { validateVideo } from "./media/video-validation.ts";
import { validateAudio } from "./media/audio-validation.ts";
import { createVoiceCodec, isSilkBytes, type VoiceCodec } from "./media/voice-codec.ts";
import {
  MEDIA_SECRET_KEYS,
  createWeixinMediaTransport,
} from "./media/media-transport.ts";
import { AES_BLOCK_BYTES, decodeWireMediaKey, mediaKeyToProtocolBase64 } from "./media/aes-media.ts";
import type { WeixinSender, SendTextResult } from "./sender/sender.ts";

export const WEIXIN_CHANNEL_KIND: ChannelKind = "weixin";
export const WEIXIN_CAPABILITIES: ChannelCapabilities = {
  text: true,
  // Phase 4 只做文字通道；媒体能力在 Phase 4.5 之前一律声称不支持
  media: { image: false, audio: false, video: false, file: false },
  maxTextLength: 2000,
  supportsReplyQuote: true,
  supportsTyping: false,
  supportsEditMessage: false,
  supportsStreamingAppend: false,
  loginMethod: "qr",
};

export interface WeixinAccountView {
  accountId: string;
  displayName: string;
  state: WeixinAccountState;
  requiresRelogin: boolean;
  lastError: string | null;
  consecutiveFailures: number;
  lastEventAt: string | null;
  /** 已登录 = 有凭证且未被标记失效 */
  loggedIn: boolean;
  pendingReloginSessionId: string | null;
}

export interface WeixinChannel extends ChannelAdapter {
  startLogin(): Promise<QrLoginSessionView>;
  pollLogin(sessionId: string): Promise<QrLoginSessionView | null>;
  submitVerifyCode(sessionId: string, code: string): QrLoginSessionView | null;
  cancelLogin(sessionId: string): boolean;
  /** 用登录结果真正建立账号（保存凭证 + 注册账号 + 开始轮询） */
  completeLogin(sessionId: string): Promise<{ accountId: string; displayName: string }>;
  listAccountViews(): Promise<WeixinAccountView[]>;
  reloginAccount(accountId: string): Promise<{ ok: boolean; reason: string | null }>;
  /** 供测试/诊断：跑一轮长轮询 */
  pollOnce(accountId: string, options?: { signal?: AbortSignal }): Promise<BatchOutcome>;
  /**
   * 取得该账号的媒体传输实现（Phase 4.5-B 只提供基础设施，不接入消息收发）。
   * Core 只看到 MediaTransport 端口，看不到 CDN/加密等细节。
   */
  createMediaTransport(accountId: string): Promise<MediaTransport>;
  accountSecretStore: WeixinSecretStore;
}

export interface WeixinChannelDeps {
  logger: Logger;
  clock: Clock;
  events: DomainEventPublisher;
  credentials: CredentialStore;
  settings: SettingsRepository;
  accounts: ChannelRepository;
  mediaStorage: MediaStorage;
  db: SqlDatabase;
  userId: string;
  baseUrl?: string;
  botAgent?: string;
  fetchImpl?: typeof fetch;
  /** 测试注入：发送重试参数 */
  senderOptions?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number; random?: () => number; sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void> };
  receiverOptions?: { longPollTimeoutMs?: number; backoff?: { baseMs?: number; maxMs?: number; jitterRatio?: number; random?: () => number } };
  /** 语音编解码器（测试注入；默认是 silk-wasm 实现，库缺失时自动降级） */
  voiceCodec?: import("./media/voice-codec.ts").VoiceCodec;
  /** 媒体传输参数（测试注入：重试次数、随机源、CDN 客户端等） */
  mediaOptions?: Omit<import("./media/media-transport.ts").WeixinMediaTransportDeps, "http" | "secrets" | "logger" | "clock" | "cdnBaseUrl" | "baseUrl" | "botAgent">;
}

export function createWeixinChannel(deps: WeixinChannelDeps): WeixinChannel {
  const baseUrl = deps.baseUrl ?? deps.settings.get<string>("weixin.baseUrl", DEFAULT_API_BASE_URL);
  const botAgent = deps.botAgent ?? deps.settings.get<string>("weixin.botAgent", "AI-Companion");

  const secrets = createWeixinSecretStore({ credentials: deps.credentials, logger: deps.logger, nowIso: () => deps.clock.nowIso() });
  const sessionState = createSessionStateRegistry({ logger: deps.logger, clock: deps.clock });
  const cursorStores = new Map<string, CursorStore>();
  const dedupStores = new Map<string, DedupStore>();

  const cursorStore = (accountId: string): CursorStore => {
    const existing = cursorStores.get(accountId);
    if (existing !== undefined) return existing;
    const created = createCursorStore({ db: deps.db, clockNow: () => deps.clock.nowIso() });
    cursorStores.set(accountId, created);
    return created;
  };
  const dedup = (accountId: string): DedupStore => {
    const existing = dedupStores.get(accountId);
    if (existing !== undefined) return existing;
    const created = createDedupStore({ db: deps.db, clock: deps.clock, logger: deps.logger, channel: WEIXIN_CHANNEL_KIND });
    dedupStores.set(accountId, created);
    return created;
  };

  let loginHttp: WeixinHttp | null = null;
  let receiver: LongPollReceiver | null = null;
  let loginService: QrLoginService | null = null;
  let inbound: InboundHandler | null = null;

  const loops = new Map<string, AbortController>();
  const startedAccounts = new Set<string>();

  /** 登录阶段没有账号，因此使用不带 token 的 http；登录完成后凭证交给账号自己的实例。 */
  function ensureLoginHttp(): WeixinHttp {
    if (loginHttp !== null) return loginHttp;
    loginHttp = createWeixinHttp({
      baseUrl,
      timeoutMs: 20_000,
      botAgent,
      logger: deps.logger,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      token: null,
    });
    return loginHttp;
  }

  /**
   * 每个账号一个 http 实例：**token 不共享**，避免 A 账号的凭证被 B 账号使用。
   */
  const httpByAccount = new Map<string, WeixinHttp>();
  async function httpFor(accountId: string): Promise<WeixinHttp> {
    const existing = httpByAccount.get(accountId);
    if (existing !== undefined) return existing;
    const secret = await secrets.load(accountId);
    const created = createWeixinHttp({
      baseUrl: secret.baseUrl.length > 0 ? secret.baseUrl : baseUrl,
      timeoutMs: 20_000,
      botAgent,
      logger: deps.logger,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      token: secret.botToken.length > 0 ? secret.botToken : null,
    });
    httpByAccount.set(accountId, created);
    return created;
  }

  /** 错误信息里的中文种类名（日志/异常都只出现这些安全字样） */
  const LABELS: Record<"image" | "file" | "video" | "audio", string> = { image: "图片", file: "文件", video: "视频", audio: "语音" };

  /**
   * 语音编解码器：由渠道注入（生产用 silk-wasm，测试可注入假实现）。
   * Core 完全不知道 SILK 的存在。
   */
  const voiceCodec: VoiceCodec = deps.voiceCodec ?? createVoiceCodec();
  /** 降级只提示一次，避免刷日志 */
  let voiceCodecWarningLogged = false;

  interface ValidatedInboundMedia {
    /** 实际要入库的字节：语音可能已经被解码成 WAV，其余类型与下载字节完全一致 */
    bytes: Uint8Array;
    mimeType: string;
    sizeBytes: number;
    filename: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  }

  /** 统一校验结果：图片给出尺寸、文件给出文件名、语音给出时长，其余字段形状一致 */
  async function validateInboundMedia(candidate: InboundMediaCandidate, bytes: Uint8Array): Promise<{ ok: true } & ValidatedInboundMedia | { ok: false; reason: string }> {
    if (candidate.kind === "file") {
      const result = validateFile({ bytes, declaredMime: null, filename: candidate.filename });
      return result.ok
        ? { ok: true, bytes, mimeType: result.mimeType, sizeBytes: result.sizeBytes, filename: result.filename, width: null, height: null, durationMs: null }
        : { ok: false, reason: result.reason };
    }
    if (candidate.kind === "video") {
      // 协议没有视频的 MIME/宽高/时长：不猜、不解码，只做大小与 MIME 语法的安全校验
      const result = validateVideo({ bytes });
      return result.ok
        ? { ok: true, bytes, mimeType: result.mimeType, sizeBytes: result.sizeBytes, filename: null, width: null, height: null, durationMs: null }
        : { ok: false, reason: result.reason };
    }
    if (candidate.kind === "audio") {
      // 语音只做"传输"：这里唯一的处理是 SILK → WAV，绝不生成转写文本
      const result = validateAudio({ bytes });
      if (!result.ok) return { ok: false, reason: result.reason };
      if (!isSilkBytes(bytes)) return { ok: false, reason: "not_silk" };
      if (!(await voiceCodec.available())) {
        // Phase 0 风险 R6：编解码不可用时**不丢数据**，原样保存 SILK
        if (!voiceCodecWarningLogged) {
          voiceCodecWarningLogged = true;
          deps.logger.warn("weixin voice codec unavailable; storing raw SILK", { accountId: "n/a", mimeType: "audio/silk" });
        }
        return { ok: true, bytes, mimeType: "audio/silk", sizeBytes: bytes.byteLength, filename: null, width: null, height: null, durationMs: null };
      }
      // 解码失败（损坏/截断）由上层捕获 → 该部件 failed；消息本身照常投递
      const decoded = await voiceCodec.silkToWav(bytes);
      return { ok: true, bytes: decoded.bytes, mimeType: "audio/wav", sizeBytes: decoded.bytes.byteLength, filename: null, width: null, height: null, durationMs: decoded.durationMs };
    }
    const result = validateImage({ bytes });
    return result.ok
      ? {
          ok: true,
          bytes,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          filename: null,
          // 图片的尺寸来自文件头解析（不是解码），文件/视频/语音没有尺寸概念
          width: result.width,
          height: result.height,
          durationMs: null,
        }
      : { ok: false, reason: result.reason };
  }

  /**
   * 入站媒体：下载 → 解密 → 校验（语音再加 SILK→WAV）→ 入库 → 写回引用
   * （渠道内部完成，Core 只见 MediaReference）。四种媒体共用这一条路径。
   */
  async function hydrateInboundMedia(accountId: string, candidates: InboundMediaCandidate[]): Promise<Map<number, MediaReference>> {
    const references = new Map<number, MediaReference>();
    if (candidates.length === 0) return references;
    const transport = await createMediaTransportInternal(accountId);
    for (const candidate of candidates) {
      /** 失败时保留文件名/类型这类安全元数据，只把状态标成 failed */
      const failed = (): MediaReference =>
        sanitizeMediaReference({ origin: "channel", filename: candidate.filename, status: "failed" });
      try {
        if (candidate.aesKey === null) {
          references.set(candidate.partIndex, failed());
          continue;
        }
        /**
         * 下载前的大小闸门：
         * - 文件协议给的是**明文**大小（file_item.len），可以直接判断；
         * - 图片/视频协议给的是**密文**大小（mid_size / video_size）。PKCS#7 下
         *   密文 = 16*ceil((n+1)/16)，因此 n ≥ 密文长度 - 16。这个下界已经超上限时，
         *   明文必然超上限 → 可以安全地在下载之前拒绝（不会误伤合法媒体）。
         */
        const declaredPlaintextLowerBound =
          candidate.declaredSizeBytes ??
          (candidate.declaredCiphertextSize === null ? null : Math.max(0, candidate.declaredCiphertextSize - AES_BLOCK_BYTES));
        if (exceedsMediaLimit(declaredPlaintextLowerBound)) {
          deps.logger.warn("weixin inbound media rejected before download", { accountId, kind: candidate.kind, reason: "too_large" });
          references.set(candidate.partIndex, failed());
          continue;
        }
        const mediaKey = decodeWireMediaKey(candidate.aesKey);
        const downloaded = await transport.download({
          accountId,
          handle: {
            provider: "weixin-cdn",
            mediaId: null,
            sizeBytes: candidate.declaredCiphertextSize ?? 0,
            transferredSizeBytes: candidate.declaredCiphertextSize ?? 0,
            mimeType: null,
            filename: null,
            uploadedAt: deps.clock.nowIso(),
          },
          secretMaterial: {
            [MEDIA_SECRET_KEYS.mediaKey]: mediaKeyToProtocolBase64(mediaKey),
            [MEDIA_SECRET_KEYS.encryptQueryParam]: candidate.encryptQueryParam ?? "",
            ...(candidate.fullUrl === null ? {} : { [MEDIA_SECRET_KEYS.fullUrl]: candidate.fullUrl }),
          },
          expectedMimeType: null,
        });

        // 图片按魔数校验；文件/视频是不透明字节；语音额外做一次 SILK → WAV 解码
        const validated = await validateInboundMedia(candidate, downloaded.bytes);
        if (!validated.ok) {
          deps.logger.warn("weixin inbound media rejected", { accountId, kind: candidate.kind, reason: validated.reason });
          references.set(candidate.partIndex, failed());
          continue;
        }
        const asset = await deps.mediaStorage.put({
          // 入库的是**可用音频/媒体字节**，绝不是 CDN 上的密文
          bytes: validated.bytes,
          mimeType: validated.mimeType,
          filename: validated.filename,
          origin: "channel",
        });
        references.set(
          candidate.partIndex,
          sanitizeMediaReference({
            mediaId: asset.mediaId,
            mimeType: validated.mimeType,
            filename: asset.filename,
            sizeBytes: asset.sizeBytes,
            // 图片有尺寸；文件/视频没有尺寸概念；语音只有时长（由编解码器给出，非猜测）
            width: validated.width,
            height: validated.height,
            durationMs: validated.durationMs,
            origin: "channel",
            status: "available",
            url: { kind: "internal", value: `media:${asset.mediaId}` },
          }),
        );
      } catch (error) {
        // 失败只影响这一个媒体：消息本身仍然投递
        deps.logger.warn("weixin inbound media download failed", { accountId, kind: candidate.kind, error: (error as Error).message });
        references.set(candidate.partIndex, failed());
      }
    }
    return references;
  }

  /**
   * 出站媒体（图片/文件/视频/语音共用）：MediaStorage 取字节 → 校验 →（语音：转 SILK）→ 上传 CDN → 协议参数。
   * 密钥只在本函数内存里流转，调用方仅把它放进 item，不写日志、不写消息。
   */
  async function prepareOutboundMedia(
    accountId: string,
    conversationRef: string,
    part: ImagePart | FilePart | VideoPart | AudioPart,
  ): Promise<{
    encryptQueryParam: string;
    aesKeyProtocolBase64: string;
    ciphertextSizeBytes: number;
    plaintextSizeBytes: number;
    filename: string | null;
  }> {
    const kind = part.kind;
    const mediaId = part.media.mediaId;
    if (mediaId === null) {
      // 外部 URL 永不自动抓取（SSRF 防护）：只有地址、没有本地字节时明确失败
      if (part.media.url !== null && part.media.url.kind === "external") {
        throw new DomainError("invalid_input", "微信通道不会抓取外部媒体地址，请先把文件落到本地媒体存储");
      }
      throw new DomainError("invalid_input", `${LABELS[kind]}部件缺少可用的媒体数据`);
    }
    const stored = await deps.mediaStorage.get(mediaId);
    if (stored === null) throw new DomainError("not_found", `${LABELS[kind]}媒体不存在或已被清理`);

    const validated =
      kind === "file"
        ? validateFile({ bytes: stored.bytes, declaredMime: stored.mimeType, filename: stored.filename })
        : kind === "video"
          ? validateVideo({ bytes: stored.bytes, declaredMime: stored.mimeType })
          : kind === "audio"
            ? validateAudio({ bytes: stored.bytes, declaredMime: stored.mimeType })
            : validateImage({ bytes: stored.bytes, declaredMime: stored.mimeType });
    if (!validated.ok) {
      throw new DomainError("invalid_input", `${LABELS[kind]}不可用：${validated.reason}`);
    }

    /**
     * 语音：微信要的是 SILK。
     * - 存储里已经是 SILK → 原样上传（逐字节不变，不做无意义的转码）；
     * - 存储里是 WAV → 编码成 SILK；
     * - 其它容器 → 明确拒绝（本阶段没有通用音频解码器，绝不把 MP3 当 PCM 乱编）。
     * 存储里始终保留原始音频，转换只发生在出站这一侧。
     */
    let uploadBytes: Uint8Array = stored.bytes;
    let uploadMimeType: string = validated.mimeType;
    if (kind === "audio") {
      // 注意：这里**不**预先要求编解码器可用 —— 存储里已经是 SILK 时不需要转码，
      // 只有真的需要 WAV → SILK 时才会因为缺库失败（由 codec 内部判定）。
      try {
        const converted = await voiceCodec.toSilk(stored.bytes);
        uploadBytes = converted.bytes;
        uploadMimeType = "audio/silk";
      } catch (error) {
        if (error instanceof WeixinTransportError && /编解码不可用/.test(error.message)) {
          throw new DomainError("channel_unavailable", "SILK 编解码不可用，无法发送语音");
        }
        throw new DomainError("invalid_input", `${LABELS[kind]}无法转换为微信格式：${(error as Error).message}`);
      }
    }

    const transport = await createMediaTransportInternal(accountId);
    const uploaded = await transport.upload({
      accountId,
      conversationRef,
      kind,
      bytes: uploadBytes,
      mimeType: uploadMimeType,
      filename: kind === "file" ? stored.filename : null,
    });
    const aesKeyProtocolBase64 = uploaded.secretMaterial[MEDIA_SECRET_KEYS.mediaKey];
    const encryptQueryParam = uploaded.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam];
    if (aesKeyProtocolBase64 === undefined || encryptQueryParam === undefined) {
      throw new DomainError("channel_unavailable", "媒体上传未返回可用的协议参数");
    }
    return {
      encryptQueryParam,
      aesKeyProtocolBase64,
      ciphertextSizeBytes: uploaded.handle.transferredSizeBytes,
      plaintextSizeBytes: uploaded.handle.sizeBytes,
      // 只有文件协议里有 file_name；视频/图片不需要文件名
      filename: kind === "file" ? (stored.filename === null ? null : sanitizeAttachmentFilename(stored.filename)) : null,
    };
  }

  /** pollOnce（测试/诊断）复用与轮询循环相同的装配 */
  async function ensureReceiver(accountId: string): Promise<LongPollReceiver> {
    if (receiver !== null) return receiver;
    receiver = await createReceiverFor(accountId);
    return receiver;
  }

  async function createReceiverFor(accountId: string): Promise<LongPollReceiver> {
    return createLongPollReceiver({
      http: await httpFor(accountId),
      secrets,
      cursorStore,
      dedup,
      sessionState,
      logger: deps.logger,
      clock: deps.clock,
      baseUrl,
      botAgent,
      channelKind: WEIXIN_CHANNEL_KIND,
      onInbound: async (envelope) => {
        if (inbound === null) {
          deps.logger.warn("weixin inbound dropped: no handler registered", { accountId });
          return;
        }
        await inbound(envelope.message);
      },
      hydrateMedia: (candidates) => hydrateInboundMedia(accountId, candidates),
      ...(deps.receiverOptions?.longPollTimeoutMs === undefined ? {} : { longPollTimeoutMs: deps.receiverOptions.longPollTimeoutMs }),
      ...(deps.receiverOptions?.backoff === undefined ? {} : { backoff: deps.receiverOptions.backoff }),
    });
  }

  async function startAccountLoop(accountId: string): Promise<void> {
    if (loops.has(accountId)) return;
    const controller = new AbortController();
    loops.set(accountId, controller);
    sessionState.markConnecting(accountId);
    // 每个账号使用自己的 http（自己的 token）与自己的轮询循环
    const accountReceiver = await createReceiverFor(accountId);
    void accountReceiver
      .loop(accountId, { signal: controller.signal })
      .catch((error: unknown) => {
        deps.logger.error("weixin polling loop ended unexpectedly", { accountId, error: (error as Error).message });
      })
      .finally(() => {
        loops.delete(accountId);
      });
  }

  async function stopAccountLoop(accountId: string): Promise<void> {
    const controller = loops.get(accountId);
    if (controller === undefined) return;
    controller.abort();
    loops.delete(accountId);
    sessionState.markStopped(accountId);
  }

  function ensureLogin(): QrLoginService {
    if (loginService !== null) return loginService;
    loginService = createQrLoginService({
      baseUrl,
      http: ensureLoginHttp(),
      logger: deps.logger,
      clock: deps.clock,
    });
    return loginService;
  }

  async function accountViews(): Promise<WeixinAccountView[]> {
    const records = deps.accounts.listAccounts(WEIXIN_CHANNEL_KIND);
    const views: WeixinAccountView[] = [];
    for (const record of records) {
      const runtime = sessionState.get(record.id);
      const hasSecret = await secrets.has(record.id);
      views.push({
        accountId: record.id,
        displayName: record.displayName.length > 0 ? record.displayName : "微信账号",
        state: runtime.state,
        requiresRelogin: runtime.requiresRelogin,
        lastError: runtime.lastError,
        consecutiveFailures: runtime.consecutiveFailures,
        lastEventAt: runtime.lastEventAt,
        loggedIn: hasSecret && !runtime.requiresRelogin,
        pendingReloginSessionId: null,
      });
    }
    return views;
  }

  return {
    kind: WEIXIN_CHANNEL_KIND,
    capabilities: WEIXIN_CAPABILITIES,
    accountSecretStore: secrets,

    async start(): Promise<void> {
      const accounts = deps.accounts.listAccounts(WEIXIN_CHANNEL_KIND);
      deps.logger.info("weixin channel starting", { accounts: accounts.length });
      for (const account of accounts) {
        if (account.status === "logged_out") continue;
        const hasSecret = await secrets.has(account.id);
        if (!hasSecret) {
          sessionState.markDisconnected(account.id, "缺少凭证，需要重新登录");
          continue;
        }
        startedAccounts.add(account.id);
        await startAccountLoop(account.id);
      }
    },

    async stop(): Promise<void> {
      for (const accountId of [...loops.keys()]) {
        await stopAccountLoop(accountId);
      }
      await sendNotify("notifystop");
      deps.logger.info("weixin channel stopped");
    },

    async health(): Promise<ChannelHealth> {
      const accounts = deps.accounts.listAccounts(WEIXIN_CHANNEL_KIND);
      const states = accounts.map((account) => sessionState.get(account.id));
      const requiresRelogin = states.some((state) => state.requiresRelogin);
      const connected = states.filter((state) => state.state === "connected").length;
      const state: ChannelHealth["state"] =
        accounts.length === 0 ? "stopped" : requiresRelogin ? "degraded" : connected > 0 ? "healthy" : "starting";
      return {
        channel: WEIXIN_CHANNEL_KIND,
        state,
        accounts: accounts.length,
        lastEventAt: states.map((entry) => entry.lastEventAt).filter((value): value is string => value !== null).sort().at(-1) ?? null,
        message: requiresRelogin ? "有账号需要重新登录" : connected > 0 ? null : "尚未连接",
      };
    },

    async listAccounts(): Promise<ChannelAccountInfo[]> {
      return deps.accounts.listAccounts(WEIXIN_CHANNEL_KIND);
    },

    async removeAccount(accountId: string): Promise<void> {
      await stopAccountLoop(accountId);
      await secrets.clear(accountId);
      deps.accounts.deleteAccount(accountId);
      cursorStore(accountId).reset(accountId);
      httpByAccount.delete(accountId);
      deps.logger.info("weixin account removed", { accountId });
    },

    onInbound(handler: InboundHandler): void {
      inbound = handler;
    },

    /**
     * Core 的出站（包括 Phase 3 的主动消息）统一走这里。
     * Phase 4.5-C1 支持文字 + 图片；4.5-C2 增加文件；4.5-C3 增加视频；4.5-D1 增加语音（音频传输 + SILK）；
     * 其他媒体部件明确拒绝，而不是静默丢弃。这里**不做**任何语音理解（没有 ASR/TTS）。
     *
     * 顺序沿用既有策略：先文字，再按 parts 里出现的顺序逐条发媒体（协议要求一次 sendmessage 只带一个 item）。
     */
    async send(response: InternalResponse): Promise<SendReceipt> {
      const accountId = response.accountId;
      if (accountId.length === 0) throw new DomainError("invalid_input", "缺少微信账号，无法发送");
      const secret = await secrets.load(accountId);
      if (secret.botToken.length === 0) {
        sessionState.markCredentialInvalid(accountId, "缺少凭证");
        throw new DomainError("unauthorized", "微信账号未登录或凭证已失效", { httpStatus: 401 });
      }

      const text = response.parts
        .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const mediaParts = response.parts.filter(
        (part): part is ImagePart | FilePart | VideoPart | AudioPart =>
          part.kind === "image" || part.kind === "file" || part.kind === "video" || part.kind === "audio",
      );
      const unsupported = response.parts.filter(
        (part) => part.kind !== "text" && part.kind !== "image" && part.kind !== "file" && part.kind !== "video" && part.kind !== "audio",
      );
      if (unsupported.length > 0) {
        deps.logger.warn("weixin channel supports text, image, file, video and audio only in this phase; other parts ignored", { parts: unsupported.length });
      }
      if (text.length === 0 && mediaParts.length === 0) {
        throw new DomainError("invalid_input", "微信消息没有可发送的内容");
      }

      const activeSender = await senderFor(accountId);
      const conversationRef = response.conversationId;

      try {
        let providerMessageId: string | null = null;
        // 先文字后媒体：媒体上传失败时文字已经送达，不会被回滚
        if (text.length > 0) {
          const result = await activeSender.sendText({
            accountId,
            toUserId: conversationRef,
            conversationRef,
            text,
            idempotencyKey: response.idempotencyKey,
          });
          providerMessageId = result.providerMessageId;
        }
        /**
         * 每种媒体各自计数，幂等键 = <key>:<协议名>:<序号>：
         * - 图片 <key>:image:0 / 文件 <key>:file:0 / 视频 <key>:video:0
         * - 语音用**协议里的名字** voice（`<key>:voice:0`），与 MediaReference.kind=audio 区分开：
         *   "audio" 是 Core 的媒体种类，"voice" 是微信的语音消息类型。
         * 键必须确定性且可重放：重发同一响应不会重复上传/重复发送。
         */
        const kindCounters: Record<string, number> = {};
        for (const part of mediaParts) {
          const idempotencyKind = part.kind === "audio" ? "voice" : part.kind;
          const index = kindCounters[idempotencyKind] ?? 0;
          kindCounters[idempotencyKind] = index + 1;
          const prepared = await prepareOutboundMedia(accountId, conversationRef, part);
          const idempotencyKey = `${response.idempotencyKey}:${idempotencyKind}:${index}`;
          const result =
            part.kind === "file"
              ? await activeSender.sendFile({
                  accountId,
                  toUserId: conversationRef,
                  conversationRef,
                  encryptQueryParam: prepared.encryptQueryParam,
                  aesKeyProtocolBase64: prepared.aesKeyProtocolBase64,
                  // 文件名缺失时需要一个稳定的占位名；协议只要求它是个名字
                  fileName: prepared.filename ?? "file",
                  plaintextSizeBytes: prepared.plaintextSizeBytes,
                  idempotencyKey,
                })
              : part.kind === "video"
                ? await activeSender.sendVideo({
                    accountId,
                    toUserId: conversationRef,
                    conversationRef,
                    encryptQueryParam: prepared.encryptQueryParam,
                    aesKeyProtocolBase64: prepared.aesKeyProtocolBase64,
                    ciphertextSizeBytes: prepared.ciphertextSizeBytes,
                    idempotencyKey,
                  })
                : part.kind === "audio"
                  ? await activeSender.sendVoice({
                      accountId,
                      toUserId: conversationRef,
                      conversationRef,
                      encryptQueryParam: prepared.encryptQueryParam,
                      aesKeyProtocolBase64: prepared.aesKeyProtocolBase64,
                      idempotencyKey,
                    })
                  : await activeSender.sendImage({
                      accountId,
                      toUserId: conversationRef,
                      conversationRef,
                      encryptQueryParam: prepared.encryptQueryParam,
                      aesKeyProtocolBase64: prepared.aesKeyProtocolBase64,
                      ciphertextSizeBytes: prepared.ciphertextSizeBytes,
                      idempotencyKey,
                    });
          providerMessageId = providerMessageId ?? result.providerMessageId;
        }
        return { idempotencyKey: response.idempotencyKey, providerMessageId, acceptedAt: deps.clock.nowIso() };
      } catch (error) {
        if (error instanceof WeixinTransportError && error.kind === "stale_token") {
          sessionState.markCredentialInvalid(accountId, "errcode -14");
        }
        // 媒体本地的语义错误（缺媒体、格式不支持）原样上抛，不伪装成渠道故障
        if (error instanceof DomainError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error("weixin send failed", { accountId, error: message });
        throw new DomainError("channel_unavailable", `微信发送失败：${message}`, { details: { channel: WEIXIN_CHANNEL_KIND } });
      }
    },

    startLogin: () => ensureLogin().start({ baseUrl }),
    pollLogin: (sessionId) => ensureLogin().step(sessionId),
    submitVerifyCode: (sessionId, code) => ensureLogin().submitVerifyCode(sessionId, code),
    cancelLogin: (sessionId) => ensureLogin().cancel(sessionId),

    async completeLogin(sessionId: string): Promise<{ accountId: string; displayName: string }> {
      const credentials = ensureLogin().takeCredentials(sessionId);
      if (credentials === null) {
        throw new DomainError("invalid_input", "登录尚未完成，无法建立账号");
      }
      const accountId = credentials.accountId ?? `weixin-${randomToken(6)}`;
      await secrets.save(accountId, {
        botToken: credentials.botToken,
        baseUrl: credentials.baseUrl,
        ilinkUserId: credentials.userId,
        contextTokens: {},
        savedAt: deps.clock.nowIso(),
      });
      const displayName = `微信账号 ${accountId.slice(-4)}`;
      deps.accounts.upsertAccount({
        id: accountId,
        channel: WEIXIN_CHANNEL_KIND,
        externalAccountId: accountId,
        displayName,
        status: "active",
        createdAt: deps.clock.nowIso(),
        boundUserId: deps.userId,
      });
      sessionState.clearCredentialInvalid(accountId);
      httpByAccount.delete(accountId);
      await startAccountLoop(accountId);
      deps.logger.info("weixin account connected", { accountId });
      return { accountId, displayName };
    },

    listAccountViews: accountViews,

    async reloginAccount(accountId: string): Promise<{ ok: boolean; reason: string | null }> {
      const hasSecret = await secrets.has(accountId);
      if (!hasSecret) return { ok: false, reason: "no_credential" };
      sessionState.clearCredentialInvalid(accountId);
      httpByAccount.delete(accountId);
      await startAccountLoop(accountId);
      return { ok: true, reason: null };
    },

    async pollOnce(accountId: string, options: { signal?: AbortSignal } = {}): Promise<BatchOutcome> {
      const activeReceiver = await ensureReceiver(accountId);
      return activeReceiver.runOnce(accountId, options);
    },

    async createMediaTransport(accountId: string): Promise<MediaTransport> {
      return createMediaTransportInternal(accountId);
    },
  };

  /** 每个账号一个 sender（自己的 token 与 baseUrl） */
  async function senderFor(accountId: string): Promise<WeixinSender> {
    const secret = await secrets.load(accountId);
    return createWeixinSender({
      http: await httpFor(accountId),
      secrets,
      logger: deps.logger,
      clock: deps.clock,
      botAgent,
      baseUrl: secret.baseUrl.length > 0 ? secret.baseUrl : baseUrl,
      ...(deps.senderOptions ?? {}),
    });
  }

  async function createMediaTransportInternal(accountId: string): Promise<MediaTransport> {
    const secret = await secrets.load(accountId);
    return createWeixinMediaTransport({
      http: await httpFor(accountId),
      secrets,
      logger: deps.logger,
      clock: deps.clock,
      cdnBaseUrl: deps.settings.get<string>("weixin.cdnBaseUrl", DEFAULT_CDN_BASE_URL),
      baseUrl: secret.baseUrl.length > 0 ? secret.baseUrl : baseUrl,
      botAgent,
      ...(deps.mediaOptions ?? {}),
    });
  }

  async function sendNotify(kind: "notifystart" | "notifystop"): Promise<void> {
    const accounts = deps.accounts.listAccounts(WEIXIN_CHANNEL_KIND);
    for (const account of accounts) {
      try {
        const secret = await secrets.load(account.id);
        if (secret.botToken.length === 0) continue;
        const accountHttp = await httpFor(account.id);
        const endpoint = kind === "notifystart" ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop";
        await accountHttp.postJson(`${secret.baseUrl.replace(/\/+$/, "")}/${endpoint}`, { base_info: { channel_version: "0.0.0", bot_agent: botAgent } }, { label: kind, timeoutMs: 10_000 });
      } catch (error) {
        // 上下线通知失败不影响主流程
        deps.logger.debug("weixin notify failed", { kind, error: (error as Error).message });
      }
    }
  }
}
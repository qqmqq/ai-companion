import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import { ENDPOINTS, DEFAULT_API_BASE_URL, QR_BOT_TYPE, buildUrl } from "../protocol/endpoints.ts";
import type { QrCodeResponse, QrStatus, QrStatusResponse } from "../protocol/types.ts";
import { WeixinTransportError } from "../protocol/errors.ts";
import type { WeixinHttp } from "../protocol/http-client.ts";
import { toIdString } from "../protocol/lossless-json.ts";
import { randomToken } from "../../../util/ids.ts";

/** 对外暴露的登录阶段：普通用户看得懂，且不泄漏任何令牌。 */
export type QrLoginPhase =
  | "waiting_scan"
  | "scanned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "expired"
  | "redirected"
  | "already_bound"
  | "logged_in"
  | "failed"
  | "cancelled";

export interface QrLoginCredentials {
  botToken: string;
  accountId: string | null;
  baseUrl: string;
  userId: string | null;
}

export interface QrLoginSessionView {
  sessionId: string;
  phase: QrLoginPhase;
  /** 二维码内容（给前端渲染），不含凭证 */
  qrcode: string | null;
  qrcodeImageContent: string | null;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  /** 微信端显示的验证码需要用户输入时才为 true */
  needsVerifyCode: boolean;
  message: string;
  refreshCount: number;
  rawStatus: string | null;
}

interface InternalSession extends QrLoginSessionView {
  apiBaseUrl: string;
  redirectHost: string | null;
  pendingVerifyCode: string | null;
  credentials: QrLoginCredentials | null;
}

export interface QrLoginServiceDeps {
  baseUrl?: string;
  http: WeixinHttp;
  logger: Logger;
  clock: Clock;
  /** 二维码有效期（默认 5 分钟，与参考实现一致） */
  sessionTtlMs?: number;
  /** 允许刷新二维码的次数（默认 3） */
  maxRefreshes?: number;
  /**
   * 扫码状态请求的超时（默认 35s）。
   *
   * 为什么必须是 35s 而不是默认的 20s：get_qrcode_status 是一个**长轮询**接口，
   * 实测服务端会保持连接约 30 秒才返回 {ret:0,status:"wait"}。
   * 用 20s 的超时会**每一次都被我们自己的客户端中止**，于是状态永远是"未知"，
   * 二维码永远停在"等待扫描"，登录无法完成（这正是"添加微信账号用不了"的原因）。
   * 与 receiver/long-poll.ts 的 30s 长轮询 + 5s 余量保持同一约定。
   */
  statusTimeoutMs?: number;
}

/** 与服务端长轮询窗口配套的超时余量（参考实现里 35s 的由来） */
const LONG_POLL_WINDOW_MS = 30_000;
const LONG_POLL_MARGIN_MS = 5_000;

const STATUS_MESSAGES: Record<QrLoginPhase, string> = {
  waiting_scan: "请用微信扫描二维码",
  scanned: "已扫码，请在手机上确认",
  need_verifycode: "请输入手机微信上显示的验证码",
  verify_code_blocked: "验证码错误次数过多，请重新获取二维码",
  expired: "二维码已过期，请重新获取",
  redirected: "正在切换登录服务器，请稍候",
  already_bound: "这个微信已经绑定过本实例，无需重复登录",
  logged_in: "登录成功",
  failed: "登录失败，请重试",
  cancelled: "已取消登录",
};

export function createQrLoginService(deps: QrLoginServiceDeps) {
  const sessions = new Map<string, InternalSession>();
  const ttl = deps.sessionTtlMs ?? 5 * 60 * 1000;
  const maxRefreshes = deps.maxRefreshes ?? 3;
  const statusTimeoutMs = deps.statusTimeoutMs ?? LONG_POLL_WINDOW_MS + LONG_POLL_MARGIN_MS;

  function view(session: InternalSession): QrLoginSessionView {
    const {
      sessionId, phase, qrcode, qrcodeImageContent, startedAt, updatedAt, expiresAt,
      needsVerifyCode, message, refreshCount, rawStatus,
    } = session;
    return {
      sessionId, phase, qrcode, qrcodeImageContent, startedAt, updatedAt, expiresAt,
      needsVerifyCode, message, refreshCount, rawStatus,
    };
  }

  function patch(session: InternalSession, changes: Partial<InternalSession>): InternalSession {
    Object.assign(session, changes, { updatedAt: deps.clock.nowIso(), message: changes.message ?? session.message });
    return session;
  }

  async function fetchQrCode(apiBaseUrl: string, session: InternalSession): Promise<void> {
    const response = await deps.http.postJson<QrCodeResponse>(
      `${buildUrl(apiBaseUrl, ENDPOINTS.getBotQrCode)}?bot_type=${encodeURIComponent(QR_BOT_TYPE)}`,
      { local_token_list: [] },
      { label: "qrtoken" },
    );
    patch(session, {
      qrcode: typeof response.qrcode === "string" ? response.qrcode : null,
      qrcodeImageContent: typeof response.qrcode_img_content === "string" ? response.qrcode_img_content : null,
      phase: "waiting_scan",
      message: STATUS_MESSAGES.waiting_scan,
      rawStatus: null,
    });
  }

  function handleStatus(session: InternalSession, body: QrStatusResponse): void {
    const status = typeof body.status === "string" ? (body.status as QrStatus | string) : "";
    session.rawStatus = status;

    switch (status) {
      case "wait":
        patch(session, { phase: "waiting_scan", message: STATUS_MESSAGES.waiting_scan });
        return;
      case "scaned":
        // 扫码成功后微信不再需要验证码
        patch(session, { phase: "scanned", needsVerifyCode: false, pendingVerifyCode: null, message: STATUS_MESSAGES.scanned });
        return;
      case "need_verifycode":
        patch(session, { phase: "need_verifycode", needsVerifyCode: true, message: STATUS_MESSAGES.need_verifycode });
        return;
      case "verify_code_blocked":
        session.refreshCount += 1;
        patch(session, {
          phase: "verify_code_blocked",
          message: STATUS_MESSAGES.verify_code_blocked,
          pendingVerifyCode: null,
          needsVerifyCode: false,
        });
        return;
      case "expired":
        session.refreshCount += 1;
        patch(session, {
          phase: session.refreshCount > maxRefreshes ? "expired" : "waiting_scan",
          message: session.refreshCount > maxRefreshes ? STATUS_MESSAGES.expired : "二维码已刷新，请重新扫描",
        });
        return;
      case "scaned_but_redirect":
        session.redirectHost = typeof body.redirect_host === "string" && body.redirect_host.length > 0 ? body.redirect_host : session.redirectHost;
        session.apiBaseUrl = session.redirectHost === null ? session.apiBaseUrl : `https://${session.redirectHost}`;
        patch(session, { phase: "redirected", message: STATUS_MESSAGES.redirected });
        return;
      case "binded_redirect":
        patch(session, { phase: "already_bound", message: STATUS_MESSAGES.already_bound });
        return;
      case "confirmed": {
        const accountId = toIdString(body.ilink_bot_id);
        if (accountId === null || typeof body.bot_token !== "string" || body.bot_token.length === 0) {
          patch(session, { phase: "failed", message: "服务端未返回有效凭证" });
          return;
        }
        session.credentials = {
          botToken: body.bot_token,
          accountId,
          baseUrl: typeof body.baseurl === "string" && body.baseurl.length > 0 ? body.baseurl : session.apiBaseUrl,
          userId: toIdString(body.ilink_user_id),
        };
        patch(session, { phase: "logged_in", message: STATUS_MESSAGES.logged_in, needsVerifyCode: false });
        return;
      }
      default:
        patch(session, { phase: "failed", message: body.errmsg ?? `未知登录状态: ${status || "(空)"}` });
    }
  }

  return {
    async start(input: { baseUrl?: string } = {}): Promise<QrLoginSessionView> {
      const at = deps.clock.nowIso();
      const session: InternalSession = {
        sessionId: randomToken(12),
        phase: "waiting_scan",
        qrcode: null,
        qrcodeImageContent: null,
        startedAt: at,
        updatedAt: at,
        expiresAt: new Date(deps.clock.now().getTime() + ttl).toISOString(),
        needsVerifyCode: false,
        message: STATUS_MESSAGES.waiting_scan,
        refreshCount: 0,
        rawStatus: null,
        apiBaseUrl: input.baseUrl ?? deps.baseUrl ?? DEFAULT_API_BASE_URL,
        redirectHost: null,
        pendingVerifyCode: null,
        credentials: null,
      };
      sessions.set(session.sessionId, session);
      await fetchQrCode(session.apiBaseUrl, session);
      deps.logger.info("weixin qr login started", { sessionId: session.sessionId });
      return view(session);
    },

    get(sessionId: string): QrLoginSessionView | null {
      const session = sessions.get(sessionId);
      return session === undefined ? null : view(session);
    },

    /** 一次性凭据只在内部交接口，绝不进入 API 响应 */
    takeCredentials(sessionId: string): QrLoginCredentials | null {
      const session = sessions.get(sessionId);
      if (session === undefined || session.credentials === null) return null;
      const credentials = session.credentials;
      session.credentials = null;
      sessions.delete(sessionId);
      return credentials;
    },

    submitVerifyCode(sessionId: string, code: string): QrLoginSessionView | null {
      const session = sessions.get(sessionId);
      if (session === undefined) return null;
      patch(session, { pendingVerifyCode: code.trim(), needsVerifyCode: false, phase: "waiting_scan", message: "已提交验证码，等待确认" });
      return view(session);
    },

    cancel(sessionId: string): boolean {
      const session = sessions.get(sessionId);
      if (session === undefined) return false;
      patch(session, { phase: "cancelled", message: STATUS_MESSAGES.cancelled });
      sessions.delete(sessionId);
      return true;
    },

    /**
     * 推进一次轮询（不 sleep，方便测试与前端按需调用）。
     * 返回最新状态；调用方决定何时停止。
     */
    async step(sessionId: string): Promise<QrLoginSessionView | null> {
      const session = sessions.get(sessionId);
      if (session === undefined) return null;

      if (["logged_in", "failed", "cancelled", "already_bound"].includes(session.phase)) return view(session);
      if (Date.parse(session.expiresAt) < deps.clock.now().getTime() && session.phase !== "expired") {
        patch(session, { phase: "expired", message: STATUS_MESSAGES.expired });
        return view(session);
      }

      // 二维码到期或需要刷新时重新取码
      if (session.qrcode === null || session.phase === "expired" || (session.phase === "verify_code_blocked" && session.refreshCount <= maxRefreshes)) {
        if (session.refreshCount > maxRefreshes) {
          patch(session, { phase: "expired", message: STATUS_MESSAGES.expired });
          return view(session);
        }
        await fetchQrCode(session.apiBaseUrl, session);
        session.expiresAt = new Date(deps.clock.now().getTime() + ttl).toISOString();
        return view(session);
      }

      const url = new URL(buildUrl(session.apiBaseUrl, ENDPOINTS.getQrCodeStatus));
      url.searchParams.set("qrcode", session.qrcode);
      if (session.pendingVerifyCode !== null) url.searchParams.set("verify_code", session.pendingVerifyCode);

      try {
        // 关键：长轮询接口必须给足时间（默认 35s），否则会被我们自己的超时中止
        const body = await deps.http.getJson<QrStatusResponse>(url.toString(), { label: "qrstatus", timeoutMs: statusTimeoutMs });
        handleStatus(session, body);
      } catch (error) {
        /**
         * 轮询失败不是致命错误：退化为 wait，让前端继续轮询。
         * 但**必须留下可见的日志**：这类失败以前只写 debug，导致"永远停在等待扫描"
         * 这类问题在默认 info 级别下完全看不到（本次修复就是这么被抓出来的）。
         */
        const kind = error instanceof WeixinTransportError ? error.kind : "unknown";
        deps.logger.warn("qr status poll failed", { kind, timeoutMs: statusTimeoutMs });
        if (error instanceof WeixinTransportError && error.kind === "aborted") {
          patch(session, { phase: "cancelled", message: STATUS_MESSAGES.cancelled });
        }
      }
      return view(session);
    },
  };
}

export type QrLoginService = ReturnType<typeof createQrLoginService>;

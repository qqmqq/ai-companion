/**
 * 「打开真实网页 → 你登录 → 自动获取所需」的编排。
 *
 * 做的事：
 *   1. 开一个真实浏览器（独立 profile + 调试端口）打开 DeepSeek 登录页；
 *   2. 轮询页面，自动读出 device_id（数美设备指纹，反代登录必需）；
 *   3. 你把 DeepSeek 账号密码 + 反代管理密码交给我们 → 一次点击：
 *      写进反代账号池、配上 API Key、再把这侧的 provider 也配好。
 *
 * 纪律：密码只在这一次请求里用，不落库、不进日志；回给界面的只有掩码。
 */
import { join } from "node:path";
import type { Clock } from "../../core/ports/clock.ts";
import type { Logger } from "../../core/ports/logger.ts";
import { DomainError } from "../../core/model/errors.ts";
import {
  findBrowser as findBrowserDefault,
  findFreePort as findFreePortDefault,
  launchBrowser as launchBrowserDefault,
  waitForPageTarget as waitForPageTargetDefault,
  cdpEvaluate as cdpEvaluateDefault,
  type BrowserCandidate,
  type CdpTarget,
} from "./browser.ts";
import { DEVICE_ID_EXPRESSION, PAGE_STATE_EXPRESSION, describePageState, extractDeviceId, parsePageState, type PageState } from "./capture.ts";
import { createDsFreeAdminClient, generateProxyKey, maskKey, type DsFreeAdminClient } from "./admin-client.ts";

export const DS_FREE_DEFAULT_BASE_URL = "http://127.0.0.1:22217";
export const DS_FREE_SIGN_IN_URL = "https://chat.deepseek.com/sign_in";
export const DS_FREE_PROVIDER_ID = "ds-free-proxy";
const API_KEY_DESCRIPTION = "AI Companion（本机）";

export type DsFreeHelperPhase = "idle" | "waiting_login" | "captured" | "error";

export interface DsFreeHelperStatus {
  phase: DsFreeHelperPhase;
  deviceId: string | null;
  pageState: PageState | null;
  pageHint: string;
  browser: string | null;
  debugPort: number | null;
  signInUrl: string;
  proxyBaseUrl: string;
  proxyReachable: boolean | null;
  lastError: string | null;
}

export interface DsFreeLoginServiceDeps {
  logger: Logger;
  clock: Clock;
  dataDir: string;
  fetchImpl?: typeof fetch;
  /** 把这侧的 provider 落库（写配置 + 密钥 + 重载），由组合根注入 */
  upsertProvider: (input: { id: string; displayName: string; baseUrl: string; defaultModel: string; apiKey: string }) => Promise<void>;
  /** 测试注入 */
  findBrowserImpl?: () => BrowserCandidate | null;
  launchBrowserImpl?: (input: { exePath: string; url: string; profileDir: string; debugPort: number; logger: Logger }) => void;
  findFreePortImpl?: () => Promise<number>;
  waitForPageTargetImpl?: (input: { debugPort: number; fetchImpl?: typeof fetch; timeoutMs?: number; intervalMs?: number }) => Promise<CdpTarget | null>;
  cdpEvaluateImpl?: (input: { webSocketDebuggerUrl: string; expression: string }) => Promise<unknown>;
  randomKey?: () => string;
}

/** 默认随机源：够用即止，密钥只在本机反代用 */
function defaultRandomHex(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export function createDsFreeLoginService(deps: DsFreeLoginServiceDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const findBrowser = deps.findBrowserImpl ?? findBrowserDefault;
  const findFreePort = deps.findFreePortImpl ?? findFreePortDefault;
  const launch = deps.launchBrowserImpl ?? launchBrowserDefault;
  const waitForPageTarget = deps.waitForPageTargetImpl ?? waitForPageTargetDefault;
  const evaluate = deps.cdpEvaluateImpl ?? cdpEvaluateDefault;

  let phase: DsFreeHelperPhase = "idle";
  let deviceId: string | null = null;
  let pageState: PageState | null = null;
  let browserName: string | null = null;
  let debugPort: number | null = null;
  let lastError: string | null = null;
  let proxyBaseUrl = DS_FREE_DEFAULT_BASE_URL;
  let proxyReachable: boolean | null = null;
  let polling = false;

  function client(baseUrl: string): DsFreeAdminClient {
    return createDsFreeAdminClient({
      baseUrl,
      logger: deps.logger,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  }

  /** 轮询页面：读到设备指纹就收工；浏览器一直起不来或超时就如实报错 */
  async function poll(port: number, deadline: number): Promise<void> {
    while (polling && deviceId === null && Date.now() < deadline) {
      const target = await waitForPageTarget({ debugPort: port, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }), timeoutMs: 3000, intervalMs: 400 });
      if (target === null) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      const state = parsePageState(await evaluate({ webSocketDebuggerUrl: target.webSocketDebuggerUrl, expression: PAGE_STATE_EXPRESSION }));
      if (state !== null) pageState = state;
      const captured = extractDeviceId(await evaluate({ webSocketDebuggerUrl: target.webSocketDebuggerUrl, expression: DEVICE_ID_EXPRESSION }));
      if (captured !== null) {
        deviceId = captured;
        phase = "captured";
        deps.logger.info("ds-free device id captured from the real page", { step: "dsfree.capture", status: "completed", chars: captured.length });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (polling && deviceId === null) {
      phase = "error";
      lastError = "等了两分钟还没读到设备指纹。请确认浏览器窗口里的 DeepSeek 页面已经加载完（可以试着登录一次），然后点「重新获取」。";
    }
  }

  return {
    /** 打开真实浏览器并开始自动获取；重复调用不会开第二个窗口 */
    async start(input: { proxyBaseUrl?: string } = {}): Promise<DsFreeHelperStatus> {
      if (input.proxyBaseUrl !== undefined && input.proxyBaseUrl.trim().length > 0) proxyBaseUrl = input.proxyBaseUrl.trim().replace(/\/+$/, "");
      if (polling || phase === "captured") return this.status();

      const found = findBrowser();
      if (found === null) {
        phase = "error";
        lastError = "没找到 Chrome 或 Edge。装一个浏览器，或用环境变量 COMPANION_BROWSER_PATH 指定可执行文件路径。";
        return this.status();
      }
      browserName = found.name;
      lastError = null;
      deviceId = null;
      pageState = null;
      phase = "waiting_login";
      debugPort = await findFreePort();
      const profileDir = join(deps.dataDir, "ds-free-browser");
      launch({ exePath: found.path, url: DS_FREE_SIGN_IN_URL, profileDir, debugPort, logger: deps.logger });
      deps.logger.info("ds-free login helper started", { step: "dsfree.helper", status: "waiting_login", browser: found.name, debugPort });

      polling = true;
      const port = debugPort;
      void poll(port, Date.now() + 120_000);
      return this.status();
    },

    async status(): Promise<DsFreeHelperStatus> {
      proxyReachable = await client(proxyBaseUrl).reachable();
      return {
        phase,
        deviceId,
        pageState,
        pageHint: describePageState(pageState),
        browser: browserName,
        debugPort,
        signInUrl: DS_FREE_SIGN_IN_URL,
        proxyBaseUrl,
        proxyReachable,
        lastError,
      };
    },

    stop(): void {
      polling = false;
      phase = "idle";
      deviceId = null;
      pageState = null;
      lastError = null;
    },

    /**
     * 一次点击完成：写进反代账号池 → 配 API Key → 配好我们这侧的 provider。
     * 传入的密码只在这一刻使用，不落库。
     */
    async apply(input: {
      email: string;
      deepseekPassword: string;
      adminPassword: string;
      proxyBaseUrl?: string;
    }): Promise<{
      ok: true;
      providerId: string;
      proxyBaseUrl: string;
      apiKeyMasked: string;
      accountAdded: boolean;
      deviceIdAttached: boolean;
      adminPasswordCreated: boolean;
      steps: string[];
    }> {
      const baseUrl = (input.proxyBaseUrl ?? proxyBaseUrl).trim().replace(/\/+$/, "");
      proxyBaseUrl = baseUrl;
      if (deviceId === null) {
        throw new DomainError("invalid_input", "还没拿到设备指纹：先点「打开登录页并自动获取」，等浏览器里页面加载完（最好完成一次登录）。");
      }
      if (input.email.trim().length === 0) throw new DomainError("invalid_input", "请填 DeepSeek 账号邮箱");
      if (input.deepseekPassword.length === 0) throw new DomainError("invalid_input", "请填 DeepSeek 账号密码");
      if (input.adminPassword.length < 6) throw new DomainError("invalid_input", "反代管理密码至少 6 位（没设置过就会用它设上）");

      const admin = client(baseUrl);
      if (!(await admin.reachable())) {
        throw new DomainError("channel_unavailable", "反代没在跑（" + baseUrl + "）。先把 ds-free-api 启动起来（见 docs/DS-FREE-API-PROXY.md），再点重试。");
      }
      const steps: string[] = [];

      let token: string;
      let adminPasswordCreated = false;
      try {
        const auth = await admin.ensureAdminToken(input.adminPassword);
        token = auth.token;
        adminPasswordCreated = auth.createdPassword;
        steps.push(adminPasswordCreated ? "已用你给的密码设置反代管理密码（首次）" : "已登录反代管理面板");
      } catch (error) {
        throw new DomainError("invalid_input", "反代管理登录失败：" + (error as Error).message);
      }

      const current = await admin.getConfig(token);
      const withAccount = admin.addAccount(current, {
        email: input.email.trim(),
        mobile: "",
        area_code: "",
        password: input.deepseekPassword,
        device_id: deviceId,
      });
      steps.push(withAccount.added ? "已把 DeepSeek 账号加入反代账号池" : "账号已存在，已更新密码与设备指纹");

      const existingKey = (withAccount.config.api_keys ?? []).find((item) => item.description === API_KEY_DESCRIPTION);
      const apiKey = existingKey?.key ?? generateProxyKey(deps.randomKey ?? defaultRandomHex);
      const withKey = admin.addApiKey(withAccount.config, { key: apiKey, description: API_KEY_DESCRIPTION });
      if (withKey.added) steps.push("已在反代里创建本程序专用的 API Key");

      await admin.putConfig(token, withKey.config);
      steps.push("已写入反代配置并热重载");

      await deps.upsertProvider({
        id: DS_FREE_PROVIDER_ID,
        displayName: "DeepSeek 网页反代（本机）",
        baseUrl,
        defaultModel: "deepseek-default",
        apiKey,
      });
      steps.push("已在「模型设置」里配置好 provider（下一步把任务指向它即可）");
      deps.logger.info("ds-free onboarding finished", { step: "dsfree.apply", status: "completed", accountAdded: withAccount.added });

      return {
        ok: true,
        providerId: DS_FREE_PROVIDER_ID,
        proxyBaseUrl: baseUrl,
        apiKeyMasked: maskKey(apiKey),
        accountAdded: withAccount.added,
        deviceIdAttached: withAccount.deviceIdFilled,
        adminPasswordCreated,
        steps,
      };
    },
  };
}

export type DsFreeLoginService = ReturnType<typeof createDsFreeLoginService>;


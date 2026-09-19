/**
 * 「打开真实网页 → 你登录 → 自动获取所需」的编排。
 *
 * 做的事：
 *   1. 开一个真实浏览器（独立 profile + 调试端口）打开 DeepSeek 登录页；
 *   2. 轮询页面，自动读出 device_id（数美设备指纹，反代登录必需）；
 *   3. 拿到就**自动收尾**：关掉浏览器窗口 → 反代没在跑就替你启动它 → 把 deepseek-default
 *      加进「已配置的模型」（密钥等一键写入时再补）；
 *   4. 你把 DeepSeek 账号密码 + 反代管理密码交给我们 → 一次点击写进反代并补齐密钥。
 *
 * 反代程序是别人的开源项目（ds-free-api，GPL-3.0），本项目不打包也不下载它，只负责找到并启动。
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
  closeBrowser as closeBrowserDefault,
  type BrowserCandidate,
  type CdpTarget,
} from "./browser.ts";
import { DEVICE_ID_EXPRESSION, PAGE_STATE_EXPRESSION, describePageState, extractDeviceId, parsePageState, type PageState } from "./capture.ts";
import { createDsFreeAdminClient, generateProxyKey, maskKey, toAccountIdentity, type DsFreeAdminClient } from "./admin-client.ts";
import { createDsFreeProxyProcess, DS_FREE_PROJECT_URL } from "./proxy-process.ts";

export const DS_FREE_DEFAULT_BASE_URL = "http://127.0.0.1:22217";
export const DS_FREE_SIGN_IN_URL = "https://chat.deepseek.com/sign_in";
export const DS_FREE_PROVIDER_ID = "ds-free-proxy";
export const DS_FREE_MODEL = "deepseek-default";
const API_KEY_DESCRIPTION = "AI Companion（本机）";
const PROXY_BOOT_TIMEOUT_MS = 20_000;

export type DsFreeHelperPhase = "idle" | "waiting_login" | "captured" | "error";

export interface DsFreeHelperStatus {
  phase: DsFreeHelperPhase;
  /** 抓完之后还在自动收尾（关窗、起反代、加模型） */
  preparing: boolean;
  deviceId: string | null;
  pageState: PageState | null;
  pageHint: string;
  browser: string | null;
  debugPort: number | null;
  /** 拿到设备指纹后自动关掉浏览器窗口的结果（null = 还没到那一步） */
  browserClosed: boolean | null;
  signInUrl: string;
  proxyBaseUrl: string;
  proxyReachable: boolean | null;
  /** 这次是不是我们替你启动的反代（已经在跑就是 false） */
  proxyStarted: boolean | null;
  proxyNote: string;
  /** 反代程序来源：别人的开源项目，界面上要标出来 */
  proxyProjectUrl: string;
  /** 找到的反代可执行文件路径 */
  binaryPath: string | null;
  /** 自动加进「已配置的模型」的那条 provider */
  providerId: string | null;
  providerNote: string;
  /** 反代管理密码是否已经存在本机（存过就不用再填） */
  adminPasswordSaved: boolean;
  lastError: string | null;
}

/** 反代进程管理（组合根注入；测试可替换） */
export interface DsFreeProxyProcessPort {
  locate(): string | null;
  start(binaryPath: string): { ok: boolean; reason: string };
  remember(path: string): void;
  guidance(): string;
}

export interface DsFreeLoginServiceDeps {
  logger: Logger;
  clock: Clock;
  dataDir: string;
  fetchImpl?: typeof fetch;
  /** 把这侧的 provider 落库（写配置 + 重载），由组合根注入；返回真正写入的那条记录 id。apiKey 为空表示只登记模型、先不写密钥 */
  upsertProvider: (input: {
    id: string;
    displayName: string;
    baseUrl: string;
    defaultModel: string;
    apiKey?: string;
  }) => Promise<string>;
  /** 反代进程管理；不注入就用默认实现 */
  proxyProcess?: DsFreeProxyProcessPort;
  /**
   * 反代管理密码的本地保管（组合根接到本机加密库）。
   * 用一次就该记住：反代一旦设过管理密码，后面每次写入都要用它登录，
   * 不该让用户一遍遍重填。密码只进加密库，接口只回"有没有存过"。
   */
  adminPasswordStore?: {
    get(): Promise<string | null>;
    put(password: string): Promise<void>;
  };
  /** 测试注入 */
  findBrowserImpl?: () => BrowserCandidate | null;
  launchBrowserImpl?: (input: { exePath: string; url: string; profileDir: string; debugPort: number; logger: Logger }) => void;
  findFreePortImpl?: () => Promise<number>;
  waitForPageTargetImpl?: (input: { debugPort: number; fetchImpl?: typeof fetch; timeoutMs?: number; intervalMs?: number }) => Promise<CdpTarget | null>;
  cdpEvaluateImpl?: (input: { webSocketDebuggerUrl: string; expression: string }) => Promise<unknown>;
  closeBrowserImpl?: (input: { debugPort: number }) => Promise<boolean>;
  randomKey?: () => string;
}

/**
 * 该写哪一条 provider：已经有指向同一个反代的，就用它。
 * 否则「先手动配过、再点一键写入」会留下两条一样的记录（其中一条没密钥）。
 */
/**
 * 自动登记模型时要不要把它打开。
 * 抓到设备指纹那一刻还没有密钥：这时**先停用**，否则任务会被路由到一条打不通的 provider 上，
 * 用户看到的是 401/报错，而不是"还没配好"。一键写入补上密钥时才打开。
 */
export function providerEnabledAfterRegister(input: { existingEnabled: boolean | null; hasKey: boolean }): boolean {
  if (input.hasKey) return true;
  return input.existingEnabled ?? false;
}

export function pickProviderTarget(
  existing: Array<{ id: string; kind: string; baseUrl: string }>,
  input: { id: string; baseUrl: string },
): string {
  const exact = existing.find((provider) => provider.id === input.id);
  if (exact !== undefined) return exact.id;
  const normalized = input.baseUrl.trim().replace(/[/]+$/, "");
  const sameProxy = existing.find(
    (provider) => provider.kind === "openai-compatible" && provider.baseUrl.trim().replace(/[/]+$/, "") === normalized,
  );
  return sameProxy?.id ?? input.id;
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
  const closeBrowser = deps.closeBrowserImpl ?? closeBrowserDefault;
  const proxyProcess =
    deps.proxyProcess ??
    createDsFreeProxyProcess({
      logger: deps.logger,
      dataDir: deps.dataDir,
    });

  let phase: DsFreeHelperPhase = "idle";
  let preparing = false;
  let deviceId: string | null = null;
  let pageState: PageState | null = null;
  let browserName: string | null = null;
  let debugPort: number | null = null;
  let browserClosed: boolean | null = null;
  let lastError: string | null = null;
  let proxyBaseUrl = DS_FREE_DEFAULT_BASE_URL;
  let proxyReachable: boolean | null = null;
  let proxyStarted: boolean | null = null;
  let proxyNote = "";
  let binaryPath: string | null = null;
  let providerId: string | null = null;
  let providerNote = "";
  let adminPasswordSaved = false;
  let polling = false;

  function client(baseUrl: string): DsFreeAdminClient {
    return createDsFreeAdminClient({
      baseUrl,
      logger: deps.logger,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  }

  /** 等反代把端口监听起来（它启动要一点时间） */
  async function waitReachable(admin: DsFreeAdminClient, deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      if (await admin.reachable()) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /**
   * 抓到设备指纹之后的自动收尾：关窗 → 起反代 → 把模型加进「已配置的模型」。
   * 每一步失败都不推翻已经拿到的东西，只把原因写进对应的 note，让界面如实说。
   */
  async function afterCapture(): Promise<void> {
    preparing = true;
    try {
      if (debugPort !== null) {
        browserClosed = await closeBrowser({ debugPort });
        deps.logger.info("ds-free login helper closed the browser window", {
          step: "dsfree.browser",
          status: browserClosed ? "closed" : "already_gone",
        });
      }

      const admin = client(proxyBaseUrl);
      if (await admin.reachable()) {
        proxyReachable = true;
        proxyStarted = false;
        proxyNote = "反代已经在运行";
      } else {
        binaryPath = proxyProcess.locate();
        if (binaryPath === null) {
          proxyNote = proxyProcess.guidance();
        } else {
          const started = proxyProcess.start(binaryPath);
          if (!started.ok) {
            proxyNote = "反代没能启动：" + started.reason;
          } else {
            proxyStarted = true;
            proxyNote = "已替你启动反代，正在等它准备好…";
            proxyReachable = await waitReachable(admin, Date.now() + PROXY_BOOT_TIMEOUT_MS);
            proxyNote = proxyReachable
              ? "已自动启动反代（" + proxyBaseUrl + "）"
              : "反代进程起来了，但 " + String(PROXY_BOOT_TIMEOUT_MS / 1000) + " 秒内还没响应；可以先看看它的窗口/日志。";
          }
        }
      }

      providerId = await deps.upsertProvider({
        id: DS_FREE_PROVIDER_ID,
        displayName: "DeepSeek 网页反代（本机）",
        baseUrl: proxyBaseUrl,
        defaultModel: DS_FREE_MODEL,
      });
      providerNote =
        "已把模型 " + DS_FREE_MODEL + " 加入「已配置的模型」（先处于停用状态，不会参与调用）；填好下面三样点「一键写入」，它会自动补上密钥并启用。";
      deps.logger.info("ds-free model registered after capture", { step: "dsfree.provider", status: "completed" });
    } catch (error) {
      providerNote = "自动收尾没做完：" + (error as Error).message;
      deps.logger.warn("ds-free post-capture step failed", { step: "dsfree.provider", status: "failed", error: (error as Error).message });
    } finally {
      preparing = false;
    }
  }

  /**
   * 用刚写好的密钥真打一次请求，把"能不能用"当场问清楚。
   * 只生成 1 个 token，失败原因（账号密码错、账号池空、限流）原样带回来。
   */
  async function verifyThroughProxy(baseUrl: string, apiKey: string): Promise<{ ok: boolean; reason: string }> {
    try {
      const response = await doFetch(baseUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model: DS_FREE_MODEL,
          messages: [{ role: "user", content: "你好" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return { ok: true, reason: "" };
      const text = (await response.text()).slice(0, 300);
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = parsed.error?.message ?? parsed.message ?? text;
      } catch {
        // 不是 JSON 就原样
      }
      return { ok: false, reason: "HTTP " + String(response.status) + " " + message };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
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
        await afterCapture();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (polling && deviceId === null) {
      phase = "error";
      lastError = "等了两分钟还没读到设备指纹。请确认浏览器窗口里的 DeepSeek 页面已经加载完（可以试着登录一次），然后点「重新获取」。";
    }
  }

  function snapshot(): DsFreeHelperStatus {
    return {
      phase,
      preparing,
      deviceId,
      pageState,
      pageHint: describePageState(pageState),
      browser: browserName,
      debugPort,
      browserClosed,
      signInUrl: DS_FREE_SIGN_IN_URL,
      proxyBaseUrl,
      proxyReachable,
      proxyStarted,
      proxyNote,
      proxyProjectUrl: DS_FREE_PROJECT_URL,
      binaryPath,
      providerId,
      providerNote,
      adminPasswordSaved,
      lastError,
    };
  }

  return {
    /** 打开真实浏览器并开始自动获取；重复调用不会开第二个窗口 */
    async start(input: { proxyBaseUrl?: string; binaryPath?: string } = {}): Promise<DsFreeHelperStatus> {
      if (input.proxyBaseUrl !== undefined && input.proxyBaseUrl.trim().length > 0) proxyBaseUrl = input.proxyBaseUrl.trim().replace(/[/]+$/, "");
      if (input.binaryPath !== undefined && input.binaryPath.trim().length > 0) {
        proxyProcess.remember(input.binaryPath.trim());
        binaryPath = input.binaryPath.trim();
      }
      if (polling || phase === "captured") return await this.status();

      const found = findBrowser();
      if (found === null) {
        phase = "error";
        lastError = "没找到 Chrome 或 Edge。装一个浏览器，或用环境变量 COMPANION_BROWSER_PATH 指定可执行文件路径。";
        return await this.status();
      }
      browserName = found.name;
      lastError = null;
      deviceId = null;
      pageState = null;
      browserClosed = null;
      proxyStarted = null;
      proxyNote = "";
      providerId = null;
      providerNote = "";
      phase = "waiting_login";
      debugPort = await findFreePort();
      const profileDir = join(deps.dataDir, "ds-free-browser");
      launch({ exePath: found.path, url: DS_FREE_SIGN_IN_URL, profileDir, debugPort, logger: deps.logger });
      deps.logger.info("ds-free login helper started", { step: "dsfree.helper", status: "waiting_login", browser: found.name, debugPort });

      polling = true;
      const port = debugPort;
      void poll(port, Date.now() + 120_000);
      return await this.status();
    },

    async status(): Promise<DsFreeHelperStatus> {
      proxyReachable = await client(proxyBaseUrl).reachable();
      adminPasswordSaved = (await deps.adminPasswordStore?.get()) !== null;
      return snapshot();
    },

    stop(): void {
      polling = false;
      phase = "idle";
      deviceId = null;
      pageState = null;
      browserClosed = null;
      proxyStarted = null;
      proxyNote = "";
      providerId = null;
      providerNote = "";
      lastError = null;
    },

    /**
     * 一次点击完成：写进反代账号池 → 配 API Key → 补齐我们这侧 provider 的密钥。
     * 传入的密码只在这一刻使用，不落库。
     */
    async apply(input: {
      email: string;
      deepseekPassword: string;
      /** 反代管理密码：存过一次之后可以留空（留空就用本机记着的那把） */
      adminPassword?: string;
      proxyBaseUrl?: string;
    }): Promise<{
      ok: true;
      providerId: string;
      proxyBaseUrl: string;
      apiKeyMasked: string;
      accountAdded: boolean;
      deviceIdAttached: boolean;
      adminPasswordCreated: boolean;
      /** 写完当场跑一次真实请求的结果（不通时 reason 就是原因） */
      verify: { ok: boolean; reason: string };
      steps: string[];
    }> {
      const baseUrl = (input.proxyBaseUrl ?? proxyBaseUrl).trim().replace(/[/]+$/, "");
      proxyBaseUrl = baseUrl;
      if (deviceId === null) {
        throw new DomainError("invalid_input", "还没拿到设备指纹：先点「打开登录页并自动获取」，等浏览器里页面加载完（最好完成一次登录）。");
      }
      if (input.email.trim().length === 0) throw new DomainError("invalid_input", "请填 DeepSeek 账号（邮箱或手机号）");
      if (input.deepseekPassword.length === 0) throw new DomainError("invalid_input", "请填 DeepSeek 账号密码");
      const providedPassword = input.adminPassword ?? "";
      const storedPassword = (await deps.adminPasswordStore?.get()) ?? null;
      const adminPassword = providedPassword.length > 0 ? providedPassword : (storedPassword ?? "");
      if (adminPassword.length === 0) {
        throw new DomainError("invalid_input", "请填反代管理密码（ds-free-api 管理面板的密码；没设置过就会用它设上）");
      }
      if (providedPassword.length > 0 && providedPassword.length < 6) {
        throw new DomainError("invalid_input", "反代管理密码至少 6 位（没设置过就会用它设上）");
      }

      const admin = client(baseUrl);
      if (!(await admin.reachable())) {
        throw new DomainError(
          "channel_unavailable",
          "反代没在跑（" + baseUrl + "）。它是开源项目 ds-free-api（" + DS_FREE_PROJECT_URL + "）：先点「重新获取」让我们替你启动，或用下面那栏告诉它装在哪。",
        );
      }
      const steps: string[] = [];

      let token: string;
      let adminPasswordCreated = false;
      try {
        const auth = await admin.ensureAdminToken(adminPassword);
        token = auth.token;
        adminPasswordCreated = auth.createdPassword;
        steps.push(adminPasswordCreated ? "已用你给的密码设置反代管理密码（首次）" : "已登录反代管理面板");
      } catch (error) {
        throw new DomainError("invalid_input", "反代管理登录失败：" + (error as Error).message);
      }
      // 登录成功才记：错的密码一律不落库
      if (deps.adminPasswordStore !== undefined && adminPassword !== storedPassword) {
        await deps.adminPasswordStore.put(adminPassword);
        adminPasswordSaved = true;
        steps.push("已把反代管理密码记在本机加密库里（下次不用再填，界面也不会再问）");
      }

      const current = await admin.getConfig(token);
      // 手机号账号要写成 mobile + area_code，写成 email 会被反代当成用户名错误
      const identity = toAccountIdentity(input.email);
      const kindLabel = identity.mobile.length > 0 ? "手机号" : "邮箱";
      const withAccount = admin.addAccount(current, {
        email: identity.email,
        mobile: identity.mobile,
        area_code: identity.area_code,
        password: input.deepseekPassword,
        device_id: deviceId,
      });
      steps.push(withAccount.added ? "已把 DeepSeek 账号（" + kindLabel + "）加入反代账号池" : "账号（" + kindLabel + "）已存在，已更新密码与设备指纹");

      const existingKey = (withAccount.config.api_keys ?? []).find((item) => item.description === API_KEY_DESCRIPTION);
      const apiKey = existingKey?.key ?? generateProxyKey(deps.randomKey ?? defaultRandomHex);
      const withKey = admin.addApiKey(withAccount.config, { key: apiKey, description: API_KEY_DESCRIPTION });
      if (withKey.added) steps.push("已在反代里创建本程序专用的 API Key");

      await admin.putConfig(token, withKey.config);
      steps.push("已写入反代配置并热重载");

      const writtenId = await deps.upsertProvider({
        id: DS_FREE_PROVIDER_ID,
        displayName: "DeepSeek 网页反代（本机）",
        baseUrl,
        defaultModel: DS_FREE_MODEL,
        apiKey,
      });
      providerId = writtenId;
      steps.push("已在「模型设置」里配好 provider：" + writtenId + "（下一步把任务指向它即可）");

      // 写完就**当场试一次真实请求**：账号密码不对 / 账号池空 这类问题，
      // 必须在这一次点击里说清楚，而不是等你聊天时看到一句"生成超时"。
      const verify = await verifyThroughProxy(baseUrl, apiKey);
      steps.push(verify.ok ? "已实测一次真实请求：通" : "已实测一次真实请求：不通 —— " + verify.reason);
      deps.logger.info("ds-free onboarding finished", { step: "dsfree.apply", status: "completed", accountAdded: withAccount.added });

      return {
        ok: true,
        providerId: writtenId,
        proxyBaseUrl: baseUrl,
        apiKeyMasked: maskKey(apiKey),
        accountAdded: withAccount.added,
        deviceIdAttached: withAccount.deviceIdFilled,
        adminPasswordCreated,
        verify,
        steps,
      };
    },
  };
}

export type DsFreeLoginService = ReturnType<typeof createDsFreeLoginService>;

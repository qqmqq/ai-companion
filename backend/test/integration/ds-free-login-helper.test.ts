import assert from "node:assert/strict";
import { test } from "node:test";
import { createDsFreeLoginService, DS_FREE_MODEL, DS_FREE_PROVIDER_ID } from "../../src/integrations/ds-free/service.ts";
import { DS_FREE_PROJECT_URL } from "../../src/integrations/ds-free/proxy-process.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { startMockDsFreeServer } from "../helpers/mock-dsfree-server.ts";

const DEVICE_ID = "20250101120000abcdef0123456789abcdef0123456789abcdef0123456789ab";

function logger() {
  return createLogger({ level: "error", sink: () => {} });
}

interface ProviderCall {
  id: string;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
}

/** 假浏览器：不真的开窗口，只记录开在了哪个 URL、有没有被关掉 */
function fakeBrowserHarness(input: { deviceId?: string | null; pageState?: unknown } = {}) {
  const opened: Array<{ url: string; profileDir: string; debugPort: number }> = [];
  const closed: number[] = [];
  const deviceId = input.deviceId === undefined ? DEVICE_ID : input.deviceId;
  return {
    opened,
    closed,
    findBrowserImpl: () => ({ name: "测试浏览器", path: "C:/fake/chrome.exe" }),
    findFreePortImpl: async () => 9333,
    launchBrowserImpl: (options: { url: string; profileDir: string; debugPort: number }) => {
      opened.push({ url: options.url, profileDir: options.profileDir, debugPort: options.debugPort });
    },
    waitForPageTargetImpl: async () => ({ id: "page-1", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/page-1", url: "https://chat.deepseek.com/sign_in" }),
    // 注入的实现直接给「页面返回的值」（真实的那个会自己剥掉 CDP 外壳）
    cdpEvaluateImpl: async (options: { expression: string }) => {
      // 页面状态表达式里也提到 SMSdk，所以按它独有的字段区分
      if (options.expression.includes("hasSmsdk")) {
        return input.pageState === undefined ? { url: "https://chat.deepseek.com/sign_in", hasSmsdk: true, tokenKeys: [] } : input.pageState;
      }
      return deviceId;
    },
    closeBrowserImpl: async (options: { debugPort: number }) => {
      closed.push(options.debugPort);
      return true;
    },
  };
}

/** 假反代进程管理：记录"找到没、起没起" */
function fakeProxyProcess(input: { binaryPath?: string | null; onStart?: () => void; startResult?: { ok: boolean; reason: string } } = {}) {
  const binaryPath = input.binaryPath === undefined ? "C:/tools/ds-free-api.exe" : input.binaryPath;
  const calls: { located: number; started: string[]; remembered: string[] } = { located: 0, started: [], remembered: [] };
  return {
    calls,
    locate: () => {
      calls.located += 1;
      return binaryPath;
    },
    start: (path: string) => {
      calls.started.push(path);
      input.onStart?.();
      return input.startResult ?? { ok: true, reason: "" };
    },
    remember: (path: string) => {
      calls.remembered.push(path);
    },
    guidance: () => "没找到反代程序。它是开源项目 ds-free-api（" + DS_FREE_PROJECT_URL + "），需要你自己下载。",
  };
}

async function waitForCapture(service: { status: () => Promise<{ phase: string; preparing: boolean }> }): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const status = await service.status();
    if (status.phase === "error") return;
    if (status.phase === "captured" && !status.preparing) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 本机加密库里记着的反代管理密码（用一次就该记住，不该反复问） */
function fakeAdminPasswordStore(initial: string | null = null) {
  let stored = initial;
  return {
    get: async () => stored,
    put: async (password: string) => {
      stored = password;
    },
    current: () => stored,
  };
}

function makeService(input: {
  proxyBaseUrl: string;
  browser: ReturnType<typeof fakeBrowserHarness>;
  proxyProcess: ReturnType<typeof fakeProxyProcess>;
  written: ProviderCall[];
  randomKey?: () => string;
  adminPasswordStore?: ReturnType<typeof fakeAdminPasswordStore>;
}) {
  return createDsFreeLoginService({
    logger: logger(),
    clock: createFakeClock(),
    dataDir: "C:/tmp/companion-test",
    upsertProvider: async (call) => {
      input.written.push(call);
      return call.id;
    },
    proxyProcess: input.proxyProcess,
    adminPasswordStore: input.adminPasswordStore ?? fakeAdminPasswordStore(),
    findBrowserImpl: input.browser.findBrowserImpl,
    findFreePortImpl: input.browser.findFreePortImpl,
    launchBrowserImpl: input.browser.launchBrowserImpl,
    waitForPageTargetImpl: input.browser.waitForPageTargetImpl,
    cdpEvaluateImpl: input.browser.cdpEvaluateImpl,
    closeBrowserImpl: input.browser.closeBrowserImpl,
    ...(input.randomKey === undefined ? {} : { randomKey: input.randomKey }),
  });
}

test("接入助手：打开真实网页 → 自动拿到设备指纹 → 自动关窗、起反代、加模型 → 一键写入", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  const written: ProviderCall[] = [];
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written, randomKey: () => "0123456789abcdef" });

    const started = await service.start({ proxyBaseUrl: proxy.baseUrl });
    // 抓取是异步的：status 这一次返回可能是「等登录」也可能是已经抓到，两种都算正常
    assert.ok(started.phase === "waiting_login" || started.phase === "captured");
    assert.equal(started.browser, "测试浏览器");
    assert.equal(started.debugPort, 9333);
    // 打开的必须是真实的 DeepSeek 登录页，profile 独立
    assert.equal(browser.opened.length, 1);
    assert.equal(browser.opened[0]?.url, "https://chat.deepseek.com/sign_in");
    assert.ok((browser.opened[0]?.profileDir ?? "").includes("ds-free-browser"));

    await waitForCapture(service);
    const status = await service.status();
    assert.equal(status.phase, "captured");
    assert.equal(status.preparing, false, "收尾做完就不该还在 preparing");
    assert.equal(status.deviceId, DEVICE_ID);
    assert.equal(status.pageHint, "已读到页面，设备指纹 SDK 就绪");

    // 拿到就自动关窗，不用用户自己去关
    assert.deepEqual(browser.closed, [9333]);
    assert.equal(status.browserClosed, true);

    // 反代本来就在跑：不该重复启动它
    assert.equal(status.proxyStarted, false);
    assert.equal(status.proxyNote, "反代已经在运行");
    assert.deepEqual(proxyProcess.calls.started, []);

    // 模型自动进了「已配置的模型」，而且这一步不写密钥
    assert.equal(status.providerId, DS_FREE_PROVIDER_ID);
    assert.ok(status.providerNote.includes(DS_FREE_MODEL));
    assert.equal(written.length, 1);
    assert.equal(written[0]?.id, DS_FREE_PROVIDER_ID);
    assert.equal(written[0]?.baseUrl, proxy.baseUrl);
    assert.equal(written[0]?.defaultModel, DS_FREE_MODEL);
    assert.equal(written[0]?.apiKey, undefined, "抓到就自动登记模型时还没密钥");

    const result = await service.apply({
      email: "someone@example.com",
      deepseekPassword: "deepseek-password",
      adminPassword: "admin-password",
    });
    assert.equal(result.ok, true);
    assert.equal(result.providerId, DS_FREE_PROVIDER_ID);
    assert.equal(result.deviceIdAttached, true);
    assert.equal(result.accountAdded, true);
    assert.equal(result.adminPasswordCreated, true);
    assert.equal(proxy.setupCount, 1);
    assert.equal(proxy.putCount, 1);

    // 反代账号池里：邮箱 + 密码 + 设备指纹，一个都不能少
    assert.equal(proxy.accountsWritten.length, 1);
    assert.equal(proxy.accountsWritten[0]?.email, "someone@example.com");
    assert.equal(proxy.accountsWritten[0]?.mobile, "", "邮箱账号不该写进 mobile");
    assert.equal(proxy.accountsWritten[0]?.password, "deepseek-password");
    assert.equal(proxy.accountsWritten[0]?.device_id, DEVICE_ID);
    assert.equal(proxy.apiKeysWritten.length, 1);
    assert.equal(proxy.apiKeysWritten[0]?.description, "AI Companion（本机）");

    // 写完当场验一次真实请求：通了就说通
    assert.equal(proxy.chatCalls, 1);
    assert.equal(result.verify.ok, true);
    assert.ok(result.steps.some((step) => step.includes("已实测一次真实请求：通")));

    // 一键写入把密钥补到同一条 provider 上；baseUrl 不带 /v1（代码自己会拼）
    assert.equal(written.length, 2);
    assert.equal(written[1]?.id, DS_FREE_PROVIDER_ID);
    assert.equal(written[1]?.apiKey, proxy.apiKeysWritten[0]?.key);

    // 回给界面的只有掩码，永远不是完整密钥
    assert.ok(!result.apiKeyMasked.includes(written[1]?.apiKey ?? ""));
    assert.ok(result.apiKeyMasked.length < (written[1]?.apiKey ?? "").length);
    assert.ok(result.steps.length >= 4);
  } finally {
    await proxy.close();
  }
});

test("接入助手：管理密码用过一次就记住，之后不用再填（状态里只回「存过没有」）", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const store = fakeAdminPasswordStore();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess: fakeProxyProcess(), written: [], adminPasswordStore: store });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);

    const before = await service.status();
    assert.equal(before.adminPasswordSaved, false);

    await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" });
    assert.equal(store.current(), "admin-password", "登录成功了才记下来");

    const after = await service.status();
    assert.equal(after.adminPasswordSaved, true);
    assert.equal(JSON.stringify(after).includes("admin-password"), false, "状态里绝不能回显密码本身");

    // 第二次：不再传管理密码，用本机记着的那把登录
    const second = await service.apply({ email: "someone@example.com", deepseekPassword: "p2" });
    assert.equal(second.adminPasswordCreated, false);
    assert.equal(proxy.loginCount >= 2, true, "第二次是走登录，不是重新设置密码");
    assert.equal(proxy.setupCount, 1);
  } finally {
    await proxy.close();
  }
});

test("接入助手：密码不对时不会把错的密码记下来", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: "right-password" });
  try {
    const browser = fakeBrowserHarness();
    const store = fakeAdminPasswordStore();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess: fakeProxyProcess(), written: [], adminPasswordStore: store });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);

    await assert.rejects(
      async () => await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "wrong-password" }),
      /反代管理登录失败/,
    );
    assert.equal(store.current(), null, "错密码绝不能落库");
  } finally {
    await proxy.close();
  }
});

test("接入助手：本机没存过、这次也没填 → 明确说要填，而不是拿空密码去登录", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess: fakeProxyProcess(), written: [], adminPasswordStore: fakeAdminPasswordStore() });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    await assert.rejects(
      async () => await service.apply({ email: "someone@example.com", deepseekPassword: "p" }),
      /请填反代管理密码/,
    );
    assert.equal(proxy.loginCount, 0, "没密码就不该去试登录");
  } finally {
    await proxy.close();
  }
});

test("接入助手：用手机号登录时写成 mobile + area_code（写成 email 会 PASSWORD_OR_USER_NAME_IS_WRONG）", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written: [] });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const result = await service.apply({ email: " 138-0013-8000 ", deepseekPassword: "p", adminPassword: "admin-password" });

    assert.equal(proxy.accountsWritten[0]?.mobile, "13800138000");
    assert.equal(proxy.accountsWritten[0]?.area_code, "86");
    assert.equal(proxy.accountsWritten[0]?.email, "", "手机号不该被塞进 email 字段");
    assert.ok(result.steps.some((step) => step.includes("手机号")));
  } finally {
    await proxy.close();
  }
});

test("接入助手：账号密码不对时，这一次点击里就说明白，而不是等你聊天时看到超时", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  proxy.setChatOutcome({ status: 503, body: { error: { message: "账号池无可用账号" } } });
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written: [] });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const result = await service.apply({ email: "someone@example.com", deepseekPassword: "wrong", adminPassword: "admin-password" });

    assert.equal(result.ok, true, "配置该写的还是写进去");
    assert.equal(result.verify.ok, false);
    assert.match(result.verify.reason, /账号池无可用账号/);
    assert.ok(result.steps.some((step) => step.includes("已实测一次真实请求：不通")));
  } finally {
    await proxy.close();
  }
});

test("接入助手：反代没在跑时，抓到设备指纹后自动替你启动它", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  proxy.setReachable(false);
  const written: ProviderCall[] = [];
  try {
    const browser = fakeBrowserHarness();
    // 我们"启动"反代之后，它就起来了——这正是真实情况
    const proxyProcess = fakeProxyProcess({ binaryPath: "C:/tools/ds-free-api.exe", onStart: () => proxy.setReachable(true) });
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written });

    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const status = await service.status();

    assert.deepEqual(proxyProcess.calls.started, ["C:/tools/ds-free-api.exe"]);
    assert.equal(status.proxyStarted, true);
    assert.equal(status.proxyReachable, true);
    assert.equal(status.binaryPath, "C:/tools/ds-free-api.exe");
    assert.ok(status.proxyNote.includes("已自动启动反代"));
    assert.equal(status.browserClosed, true, "启动反代不该影响自动关窗");
    assert.equal(status.providerId, DS_FREE_PROVIDER_ID);
    // 反代来源必须能传给界面（界面要标明这是别人的开源项目）
    assert.equal(status.proxyProjectUrl, DS_FREE_PROJECT_URL);
  } finally {
    await proxy.close();
  }
});

test("接入助手：找不到反代程序时如实说清楚去哪儿下，但已经拿到的东西照旧保留", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  proxy.setReachable(false);
  const written: ProviderCall[] = [];
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess({ binaryPath: null });
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written });

    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const status = await service.status();

    assert.equal(status.deviceId, DEVICE_ID, "拿到的设备指纹不能因为反代没起来就丢");
    assert.equal(status.browserClosed, true);
    assert.deepEqual(proxyProcess.calls.started, []);
    assert.equal(status.proxyStarted, null);
    assert.ok(status.proxyNote.includes(DS_FREE_PROJECT_URL), "要告诉用户反代是哪个开源项目：" + status.proxyNote);
    assert.equal(status.binaryPath, null);
    // 模型照样先登记上，密钥等一键写入
    assert.equal(status.providerId, DS_FREE_PROVIDER_ID);
  } finally {
    await proxy.close();
  }
});

test("接入助手：填了反代路径就记下来，下次直接用", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written: [] });
    const status = await service.start({ proxyBaseUrl: proxy.baseUrl, binaryPath: "D:/tools/ds-free-api.exe" });
    assert.deepEqual(proxyProcess.calls.remembered, ["D:/tools/ds-free-api.exe"]);
    assert.equal(status.binaryPath, "D:/tools/ds-free-api.exe");
  } finally {
    await proxy.close();
  }
});

test("接入助手：已经有一条指向同一个反代的 provider 时，复用它而不是又建一条", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const service = createDsFreeLoginService({
      logger: logger(),
      clock: createFakeClock(),
      dataDir: "C:/tmp/companion-test",
      // 组合根在这一步做「同地址复用」：这里模拟它已经选中了既有那条
      upsertProvider: async (call) => (call.id === DS_FREE_PROVIDER_ID ? "openai-compatible-existing" : call.id),
      proxyProcess,
      findBrowserImpl: browser.findBrowserImpl,
      findFreePortImpl: browser.findFreePortImpl,
      launchBrowserImpl: browser.launchBrowserImpl,
      waitForPageTargetImpl: browser.waitForPageTargetImpl,
      cdpEvaluateImpl: browser.cdpEvaluateImpl,
      closeBrowserImpl: browser.closeBrowserImpl,
    });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const result = await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" });

    assert.equal(result.providerId, "openai-compatible-existing", "回给界面的必须是真正写进去的那条");
    assert.ok(result.steps.some((step) => step.includes("openai-compatible-existing")));
  } finally {
    await proxy.close();
  }
});

test("接入助手：反代已经设过管理密码时走登录，密码错就如实报错", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: "right-password" });
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written: [] });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);

    await assert.rejects(
      async () => await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "wrong-password" }),
      /反代管理登录失败/,
    );
    assert.equal(proxy.setupCount, 0, "已经设过密码就不该再 setup");
    assert.equal(proxy.putCount, 0, "登录失败时不该写配置");

    const ok = await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "right-password" });
    assert.equal(ok.adminPasswordCreated, false);
    assert.equal(proxy.putCount, 1);
  } finally {
    await proxy.close();
  }
});

test("接入助手：设备指纹是唯一硬门槛，没拿到就不写反代", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness({ deviceId: null });
    const proxyProcess = fakeProxyProcess();
    const written: ProviderCall[] = [];
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written });
    await service.start({ proxyBaseUrl: proxy.baseUrl });

    await assert.rejects(
      async () => await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" }),
      /还没拿到设备指纹/,
    );
    assert.equal(proxy.putCount, 0);
    assert.deepEqual(written, [], "没抓到指纹就不该动模型配置");

    // 停掉之后状态回到干净起点，不会留下半截状态
    service.stop();
    const status = await service.status();
    assert.equal(status.phase, "idle");
    assert.equal(status.deviceId, null);
    assert.equal(status.providerId, null);
    assert.equal(status.proxyNote, "");
  } finally {
    await proxy.close();
  }
});

test("接入助手：同一个账号再来一次不会重复加账号，密钥也复用同一把", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const proxyProcess = fakeProxyProcess();
    const written: ProviderCall[] = [];
    const service = makeService({ proxyBaseUrl: proxy.baseUrl, browser, proxyProcess, written, randomKey: () => "aaaaaaaaaaaaaaaa" });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const first = await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" });
    const second = await service.apply({ email: "someone@example.com", deepseekPassword: "p2", adminPassword: "admin-password" });

    assert.equal(proxy.accountsWritten.length, 1, "同一个邮箱只该有一个账号");
    assert.equal(proxy.accountsWritten[0]?.password, "p2", "再写一次应该是更新密码");
    assert.equal(proxy.apiKeysWritten.length, 1, "本程序只该有一把密钥");
    assert.equal(first.apiKeyMasked, second.apiKeyMasked);
    const withKey = written.filter((call) => call.apiKey !== undefined);
    assert.equal(withKey.length, 2);
    assert.equal(withKey[0]?.apiKey, withKey[1]?.apiKey);
  } finally {
    await proxy.close();
  }
});

test("接入助手：没找到浏览器时给出可操作的提示，而不是静默失败", async () => {
  const service = createDsFreeLoginService({
    logger: logger(),
    clock: createFakeClock(),
    dataDir: "C:/tmp/companion-test",
    upsertProvider: async (call) => call.id,
    proxyProcess: fakeProxyProcess(),
    findBrowserImpl: () => null,
  });
  const status = await service.start({});
  assert.equal(status.phase, "error");
  assert.ok((status.lastError ?? "").includes("COMPANION_BROWSER_PATH"));
  assert.equal(status.deviceId, null);
  assert.equal(status.providerId, null);
});

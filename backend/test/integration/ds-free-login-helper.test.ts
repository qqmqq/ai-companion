import assert from "node:assert/strict";
import { test } from "node:test";
import { createDsFreeLoginService, DS_FREE_PROVIDER_ID } from "../../src/integrations/ds-free/service.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { startMockDsFreeServer } from "../helpers/mock-dsfree-server.ts";

const DEVICE_ID = "20250101120000abcdef0123456789abcdef0123456789abcdef0123456789ab";

function logger() {
  return createLogger({ level: "error", sink: () => {} });
}

/** 假浏览器：不真的开窗口，只记录开在了哪个 URL、哪个 profile */
function fakeBrowserHarness(input: { deviceId?: string | null; pageState?: unknown } = {}) {
  const opened: Array<{ url: string; profileDir: string; debugPort: number }> = [];
  const evaluated: string[] = [];
  const deviceId = input.deviceId === undefined ? DEVICE_ID : input.deviceId;
  return {
    opened,
    evaluated,
    findBrowserImpl: () => ({ name: "测试浏览器", path: "C:/fake/chrome.exe" }),
    findFreePortImpl: async () => 9333,
    launchBrowserImpl: (options: { url: string; profileDir: string; debugPort: number }) => {
      opened.push({ url: options.url, profileDir: options.profileDir, debugPort: options.debugPort });
    },
    waitForPageTargetImpl: async () => ({ id: "page-1", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/page-1", url: "https://chat.deepseek.com/sign_in" }),
    // 注入的实现直接给「页面返回的值」（真实的那个会自己剥掉 CDP 外壳）
    cdpEvaluateImpl: async (options: { expression: string }) => {
      evaluated.push(options.expression);
      // 页面状态表达式里也提到 SMSdk，所以按它独有的字段区分
      if (options.expression.includes("hasSmsdk")) {
        return input.pageState === undefined ? { url: "https://chat.deepseek.com/sign_in", hasSmsdk: true, tokenKeys: [] } : input.pageState;
      }
      return deviceId;
    },
  };
}

async function waitForCapture(service: { status: () => Promise<{ phase: string }> }): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const status = await service.status();
    if (status.phase === "captured" || status.phase === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("接入助手：打开真实网页 → 自动拿到设备指纹 → 一键写进反代并配好 provider", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  const written: Array<{ id: string; baseUrl: string; defaultModel: string; apiKey: string }> = [];
  try {
    const browser = fakeBrowserHarness();
    const service = createDsFreeLoginService({
      logger: logger(),
      clock: createFakeClock(),
      dataDir: "C:/tmp/companion-test",
      upsertProvider: async (input) => { written.push(input); },
      randomKey: () => "0123456789abcdef",
      findBrowserImpl: browser.findBrowserImpl,
      findFreePortImpl: browser.findFreePortImpl,
      launchBrowserImpl: browser.launchBrowserImpl,
      waitForPageTargetImpl: browser.waitForPageTargetImpl,
      cdpEvaluateImpl: browser.cdpEvaluateImpl,
    });

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
    assert.equal(status.deviceId, DEVICE_ID);
    assert.equal(status.proxyReachable, true);
    assert.equal(status.pageHint, "已读到页面，设备指纹 SDK 就绪");

    const result = await service.apply({
      email: "someone@example.com",
      deepseekPassword: "deepseek-password",
      adminPassword: "admin-password",
    });
    assert.equal(result.ok, true);
    assert.equal(result.providerId, DS_FREE_PROVIDER_ID);
    assert.equal(result.deviceIdAttached, true);
    assert.equal(result.accountAdded, true);
    // 首次使用：管理密码是这一次设上的
    assert.equal(result.adminPasswordCreated, true);
    assert.equal(proxy.setupCount, 1);
    assert.equal(proxy.putCount, 1);

    // 反代账号池里：邮箱 + 密码 + 设备指纹，一个都不能少
    assert.equal(proxy.accountsWritten.length, 1);
    assert.equal(proxy.accountsWritten[0]?.email, "someone@example.com");
    assert.equal(proxy.accountsWritten[0]?.password, "deepseek-password");
    assert.equal(proxy.accountsWritten[0]?.device_id, DEVICE_ID);
    assert.equal(proxy.apiKeysWritten.length, 1);
    assert.equal(proxy.apiKeysWritten[0]?.description, "AI Companion（本机）");

    // 我们这侧的 provider 也配好了；baseUrl 不带 /v1（代码自己会拼）
    assert.equal(written.length, 1);
    assert.equal(written[0]?.id, DS_FREE_PROVIDER_ID);
    assert.equal(written[0]?.baseUrl, proxy.baseUrl);
    assert.equal(written[0]?.defaultModel, "deepseek-default");
    assert.equal(written[0]?.apiKey, proxy.apiKeysWritten[0]?.key);

    // 回给界面的只有掩码，永远不是完整密钥
    assert.ok(!result.apiKeyMasked.includes(written[0]?.apiKey ?? ""));
    assert.ok(result.apiKeyMasked.length < (written[0]?.apiKey ?? "").length);
    assert.ok(result.steps.length >= 4);
  } finally {
    await proxy.close();
  }
});

test("接入助手：反代已经设过管理密码时走登录，密码错就如实报错", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: "right-password" });
  try {
    const browser = fakeBrowserHarness();
    const service = createDsFreeLoginService({
      logger: logger(),
      clock: createFakeClock(),
      dataDir: "C:/tmp/companion-test",
      upsertProvider: async () => {},
      findBrowserImpl: browser.findBrowserImpl,
      findFreePortImpl: browser.findFreePortImpl,
      launchBrowserImpl: browser.launchBrowserImpl,
      waitForPageTargetImpl: browser.waitForPageTargetImpl,
      cdpEvaluateImpl: browser.cdpEvaluateImpl,
    });
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
    const written: string[] = [];
    const service = createDsFreeLoginService({
      logger: logger(),
      clock: createFakeClock(),
      dataDir: "C:/tmp/companion-test",
      upsertProvider: async (input) => { written.push(input.id); },
      findBrowserImpl: browser.findBrowserImpl,
      findFreePortImpl: browser.findFreePortImpl,
      launchBrowserImpl: browser.launchBrowserImpl,
      waitForPageTargetImpl: browser.waitForPageTargetImpl,
      cdpEvaluateImpl: browser.cdpEvaluateImpl,
    });
    await service.start({ proxyBaseUrl: proxy.baseUrl });

    await assert.rejects(
      async () => await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" }),
      /还没拿到设备指纹/,
    );
    assert.equal(proxy.putCount, 0);
    assert.deepEqual(written, []);

    // 停掉之后状态回到干净起点，不会留下半截状态
    service.stop();
    const status = await service.status();
    assert.equal(status.phase, "idle");
    assert.equal(status.deviceId, null);
  } finally {
    await proxy.close();
  }
});

test("接入助手：同一个账号再来一次不会重复加账号，密钥也复用同一把", async () => {
  const proxy = await startMockDsFreeServer({ adminPassword: null });
  try {
    const browser = fakeBrowserHarness();
    const written: Array<{ apiKey: string }> = [];
    const service = createDsFreeLoginService({
      logger: logger(),
      clock: createFakeClock(),
      dataDir: "C:/tmp/companion-test",
      upsertProvider: async (input) => { written.push(input); },
      randomKey: () => "aaaaaaaaaaaaaaaa",
      findBrowserImpl: browser.findBrowserImpl,
      findFreePortImpl: browser.findFreePortImpl,
      launchBrowserImpl: browser.launchBrowserImpl,
      waitForPageTargetImpl: browser.waitForPageTargetImpl,
      cdpEvaluateImpl: browser.cdpEvaluateImpl,
    });
    await service.start({ proxyBaseUrl: proxy.baseUrl });
    await waitForCapture(service);
    const first = await service.apply({ email: "someone@example.com", deepseekPassword: "p", adminPassword: "admin-password" });
    const second = await service.apply({ email: "someone@example.com", deepseekPassword: "p2", adminPassword: "admin-password" });

    assert.equal(proxy.accountsWritten.length, 1, "同一个邮箱只该有一个账号");
    assert.equal(proxy.accountsWritten[0]?.password, "p2", "再写一次应该是更新密码");
    assert.equal(proxy.apiKeysWritten.length, 1, "本程序只该有一把密钥");
    assert.equal(first.apiKeyMasked, second.apiKeyMasked);
    assert.equal(written[0]?.apiKey, written[1]?.apiKey);
  } finally {
    await proxy.close();
  }
});

test("接入助手：没找到浏览器时给出可操作的提示，而不是静默失败", async () => {
  const service = createDsFreeLoginService({
    logger: logger(),
    clock: createFakeClock(),
    dataDir: "C:/tmp/companion-test",
    upsertProvider: async () => {},
    findBrowserImpl: () => null,
  });
  const status = await service.start({});
  assert.equal(status.phase, "error");
  assert.ok((status.lastError ?? "").includes("COMPANION_BROWSER_PATH"));
  assert.equal(status.deviceId, null);
});


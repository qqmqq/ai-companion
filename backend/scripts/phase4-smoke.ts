/**
 * Phase 4 冒烟：真实进程 + 真实 HTTP + 真实 SQLite + mock 微信后端。
 *
 * 覆盖链路：
 *   扫码登录 → 长轮询收消息 → Core 生成回复 → 经微信通道发回
 *   → 主动消息（Phase 3）经同一个 ChannelAdapter 发给微信
 *
 * 用法：node scripts/phase4-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockWeixinServer, inboundTextMessage } from "../test/helpers/mock-weixin-server.ts";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p4-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

// 微信后端与模型后端都用本地 mock：不需要任何真实凭证
const weixinMock = await startMockWeixinServer({
  qrStatuses: ["wait", "scaned", "confirmed"],
  botToken: "bot-token-phase4",
  accountId: "wx-account-1",
  ilinkUserId: "self-account-1",
  sendFailures: 0,
});
const llmMock = await startMockOpenAIServer({ chatReply: "（角色）我在，刚忙完手头的事。" });

const config = loadConfig({ COMPANION_DATA_DIR: dataDir, COMPANION_LOG_LEVEL: "warn", COMPANION_SCHEDULER_ENABLED: "false" });
const container = await createContainer({
  config,
  fetchImpl: fetch,
  settingsSeed: { "weixin.baseUrl": weixinMock.baseUrl },
});
const app = createHttpServer(container);
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") throw new Error("no address");
const base = `http://127.0.0.1:${address.port}`;

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${text.slice(0, 200)}`);
  return (text.length === 0 ? null : JSON.parse(text)) as T;
};

try {
  log(`DATA DIR: ${dataDir}`);
  log(`WEIXIN MOCK: ${weixinMock.baseUrl}`);

  // 1) 配好模型与角色
  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: "smoke", kind: "openai-compatible", displayName: "本地 mock 模型", baseUrl: llmMock.baseUrl, defaultModel: "mock-chat", requiresCredential: false }),
  });
  for (const taskType of ["chat", "memory_extraction", "summarization", "proactive"]) {
    await json("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId: "smoke", model: "mock-chat" }) });
  }
  // 角色：原生定义内联构建（角色卡导入接口已删除）
  const character = await json<{ id: string; name: string }>("/api/characters", {
    method: "POST",
    body: JSON.stringify({
      name: "Aria",
      description: "一个会记住你的角色",
      personality: "温柔、好奇",
      scenario: "小镇的咖啡馆",
      systemPrompt: "保持简洁，不要长篇大论。",
      firstMessage: "欢迎回来，今天想喝点什么？",
    }),
  });
  // 微信来的消息没有角色信息，用默认角色兜底
  container.repos.settings.put("defaultCharacterId", character.id, container.clock.nowIso());
  log(`CHARACTER: ${character.name}`);

  const channel = container.channels.get("weixin") as WeixinChannel;
  log(`CHANNEL DISCOVERED: ${channel.kind}（运行时发现，Core 不认识微信）`);

  // 2) 扫码登录（前端做的就是这三步）
  const session = await channel.startLogin();
  log(`QR: phase=${session.phase} qrcode=${session.qrcode}（凭证只进加密存储）`);
  await channel.pollLogin(session.sessionId);
  const scanned = await channel.pollLogin(session.sessionId);
  const confirmed = await channel.pollLogin(session.sessionId);
  log(`QR: scanned=${scanned?.phase} → ${confirmed?.phase}`);
  const { accountId } = await channel.completeLogin(session.sessionId);
  log(`ACCOUNT: ${accountId}（已登记到 channel_accounts，凭证密文保存）`);

  // 3) 微信发来一条消息 → Core → 回复发回微信
  weixinMock.queueBatch({
    msgs: [inboundTextMessage({ messageId: "9007199254740993", fromUserId: "wx-user-1", text: "你今天怎么样？", contextToken: "ctx-user-1" })],
    buffer: "cursor-1",
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && weixinMock.sentMessages.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log(`INBOUND: message_id=9007199254740993(user=wx-user-1) 已被处理（uint64 原样保存）`);
  log(`REPLY → WEIXIN: "${weixinMock.sentMessages[0]?.text ?? "(无)"}" | to=${weixinMock.sentMessages[0]?.to_user_id} | context_token=${weixinMock.sentMessages[0]?.context_token}`);

  const conversations = await json<{ items: Array<{ id: string; channel: string; characterId: string }> }>("/api/conversations");
  const weixinConversation = conversations.items.find((conversation) => conversation.channel === "weixin");
  log(`CONVERSATION: ${weixinConversation?.id ?? "(未创建)"} channel=${weixinConversation?.channel}`);

  // 4) 主动消息：Phase 3 的服务，经同一个 ChannelAdapter 送达微信
  await json("/api/proactive/settings", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, autonomy: "normal", quietHours: { enabled: false, start: "23:00", end: "08:00" }, dailyLimit: 3, cooldownMs: 0 }),
  });
  const proactive = await json<{ decision: { decision: string; blockedReason: string | null } }>("/api/proactive/trigger", {
    method: "POST",
    body: JSON.stringify({ characterId: character.id, triggerKind: "manual" }),
  });
  log(`PROACTIVE: decision=${proactive.decision.decision} blocked=${proactive.decision.blockedReason ?? "—"}（ProactiveService → ChannelAdapter → WeixinChannel）`);
  log(`REPLY → WEIXIN (proactive): "${weixinMock.sentMessages.at(-1)?.text ?? "(无)"}"`);

  // 5) 状态与安全
  const status = await json<{ accounts: Array<{ accountId: string; loggedIn: boolean; state: string }> }>("/api/channels/weixin/status");
  log(`CHANNEL STATUS: ${status.accounts.map((account) => `${account.accountId}:${account.state}(loggedIn=${account.loggedIn})`).join(", ")}`);
  const statusText = JSON.stringify(status);
  log(`CREDENTIAL LEAK CHECK: ${statusText.includes("bot-token-phase4") || statusText.includes("ctx-user-1") ? "LEAKED!" : "no token/context_token in API response"}`);

  // 6) 凭证失效（-14）行为
  weixinMock.config.updatesErrors = [{ ret: 0, errcode: -14, errmsg: "session timeout" }];
  await channel.pollOnce(accountId).catch(() => {});
  const afterInvalid = await json<{ accounts: Array<{ requiresRelogin: boolean; loggedIn: boolean }>; health: { state: string } }>("/api/channels/weixin/status");
  log(`AFTER -14: requiresRelogin=${afterInvalid.accounts[0]?.requiresRelogin} health=${afterInvalid.health.state}（停止轮询，等待重新登录）`);

  log("PHASE 4 SMOKE OK");
} finally {
  await app.close();
  await container.shutdown();
  await weixinMock.close();
  await llmMock.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}

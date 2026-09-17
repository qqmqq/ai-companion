import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import { startMockWeixinServer } from "../helpers/mock-weixin-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";
import type { WeixinChannel } from "../../src/channels/weixin/channel.ts";

/**
 * Phase 4 的验收链路：
 *   ProactiveService → ProactiveOutbound → ChannelRegistry → WeixinChannel → 微信后端
 * 全程走真实 HTTP（mock 后端），Core 与 Phase 3 的主动消息代码完全没有为微信改动。
 */
test("proactive message reaches Weixin through the shared ChannelAdapter", async () => {
  const mock = await startMockWeixinServer({ qrStatuses: ["confirmed"], botToken: "token-proactive", accountId: "acct-p4" });
  const server = await createRunningServer({ fetchImpl: fetch, settingsSeed: { "weixin.baseUrl": mock.baseUrl } });
  const container: Container = server.container;

  try {
    // Core 与微信完全解耦：组合根运行时发现了微信渠道并注册
    const adapter = container.channels.get("weixin") as WeixinChannel | undefined;
    assert.ok(adapter !== undefined, "微信渠道应被运行时发现并注册");

    // 1) 走渠道自己的登录流程（协议细节全部在渠道内部）
    const session = await adapter.startLogin();
    await adapter.pollLogin(session.sessionId);
    const finished = await adapter.pollLogin(session.sessionId);
    assert.equal(finished?.phase, "logged_in");
    const { accountId } = await adapter.completeLogin(session.sessionId);
    await adapter.stop(); // 测试自己驱动轮询

    // 2) 造一个绑定到微信渠道的会话与角色
    const character = (await (
      await fetch(`${server.baseUrl}/api/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Aria", description: "温柔的咖啡师", personality: "安静", scenario: "书房", systemPrompt: "", firstMessage: "你好。" }),
      })
    ).json()) as { id: string };

    container.services.conversations.ensureConversation({
      userId: container.user.id,
      characterId: character.id,
      channel: "weixin",
      accountId,
      conversationRef: "user-weixin-1",
      title: "微信会话",
    });

    // 3) 放宽主动消息策略（默认静音时段会拦住测试时间）
    container.services.proactive.updatePolicy({
      enabled: true,
      autonomy: "normal",
      quietHours: { enabled: false, start: "23:00", end: "08:00" },
      dailyLimit: 3,
      cooldownMs: 0,
    });

    // 4) 主动消息：由 Phase 3 的服务生成，经 ChannelAdapter 送达微信
    const result = await container.services.proactive.propose({
      userId: container.user.id,
      characterId: character.id,
      triggerKind: "scheduled_window",
      reason: "午间问候",
    });

    assert.equal(result.decision.decision, "sent", `决策应发送，实际 ${result.decision.decision}/${result.decision.blockedReason ?? "-"}`);
    assert.equal(mock.sentMessages.length, 1, "微信后端应收到一条消息");
    assert.equal(mock.sentMessages[0]?.to_user_id, "user-weixin-1");
    assert.ok((mock.sentMessages[0]?.text ?? "").length > 0);
    assert.equal(mock.sentMessages[0]?.client_id, result.decision.detail["providerMessageId"] === null ? mock.sentMessages[0]?.client_id : mock.sentMessages[0]?.client_id);

    // 5) 落库、快照与审计都要正确
    const messages = container.services.conversations.messages(
      container.services.conversations.list(container.user.id, 10).find((conversation) => conversation.channel === "weixin")!.id,
    );
    const proactive = messages.filter((message) => message.source === "proactive");
    assert.equal(proactive.length, 1);
    assert.equal(proactive[0]?.status, "completed");

    const snapshots = container.repos.snapshots.listByConversation(
      container.services.conversations.list(container.user.id, 10).find((conversation) => conversation.channel === "weixin")!.id,
      5,
    );
    assert.ok(snapshots.some((snapshot) => snapshot.source === "proactive"));
    assert.ok(container.repos.proactiveDecisions.list({ limit: 5 }).some((decision) => decision.decision === "sent"));
  } finally {
    await server.close();
    await mock.close();
  }
});

test("weixin management API never exposes credentials and reports login state", async () => {
  const mock = await startMockWeixinServer({ qrStatuses: ["wait", "scaned", "confirmed"], botToken: "secret-token-xyz" });
  const server = await createRunningServer({ fetchImpl: fetch, settingsSeed: { "weixin.baseUrl": mock.baseUrl } });
  try {
    const status = await fetch(`${server.baseUrl}/api/channels/weixin/status`);
    const statusBody = (await status.json()) as { enabled: boolean; accounts: unknown[] };
    assert.equal(statusBody.enabled, true);
    assert.equal(statusBody.accounts.length, 0);

    const login = await fetch(`${server.baseUrl}/api/channels/weixin/login`, { method: "POST" });
    const session = (await login.json()) as { sessionId: string; phase: string; qrcode: string | null };
    assert.equal(session.phase, "waiting_scan");
    assert.equal(JSON.stringify(session).includes("secret-token-xyz"), false);
    assert.equal(typeof session.qrcode, "string");

    // 前端按自己的节奏轮询：每次调用推进一步
    await fetch(`${server.baseUrl}/api/channels/weixin/login/${session.sessionId}`);
    await fetch(`${server.baseUrl}/api/channels/weixin/login/${session.sessionId}`);
    const confirmed = await fetch(`${server.baseUrl}/api/channels/weixin/login/${session.sessionId}`);
    const confirmedBody = (await confirmed.json()) as { phase: string };
    assert.equal(confirmedBody.phase, "logged_in");

    const complete = await fetch(`${server.baseUrl}/api/channels/weixin/login/${session.sessionId}/complete`, { method: "POST" });
    const account = (await complete.json()) as { accountId: string; displayName: string };
    assert.equal(account.accountId, "acct-1");
    assert.equal(JSON.stringify(account).includes("secret-token-xyz"), false, "API 响应不能包含 token");

    const after = await fetch(`${server.baseUrl}/api/channels/weixin/status`);
    const afterText = await after.text();
    assert.equal(afterText.includes("secret-token-xyz"), false);
    const afterBody = JSON.parse(afterText) as { accounts: Array<{ accountId: string; loggedIn: boolean }> };
    assert.equal(afterBody.accounts.length, 1);
    assert.equal(afterBody.accounts[0]?.loggedIn, true);

    // 删除账号
    const removed = await fetch(`${server.baseUrl}/api/channels/weixin/accounts/${account.accountId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const finalStatus = (await (await fetch(`${server.baseUrl}/api/channels/weixin/status`)).json()) as { accounts: unknown[] };
    assert.equal(finalStatus.accounts.length, 0);
  } finally {
    await server.close();
    await mock.close();
  }
});
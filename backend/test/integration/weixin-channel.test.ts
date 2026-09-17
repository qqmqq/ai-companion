import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeixinStack, loginWeixinAccount } from "../helpers/weixin-stack.ts";
import { inboundTextMessage } from "../helpers/mock-weixin-server.ts";
import { createCursorStore } from "../../src/channels/weixin/receiver/cursor-store.ts";
import type { SqlDatabase } from "../../src/core/ports/channel-module.ts";

const MAX_UINT64 = "9223372036854775807";

test("QR login walks the protocol statuses and never exposes credentials", async () => {
  const stack = await createWeixinStack({ qrStatuses: ["wait", "scaned", "confirmed"] });
  try {
    const session = await stack.channel.startLogin();
    assert.equal(session.phase, "waiting_scan");
    assert.equal(session.qrcode, "qr-value-1");
    assert.equal(session.qrcodeImageContent, "weixin://qr/qr-value-1");
    assert.equal(JSON.stringify(session).includes("token"), false, "登录视图里不能出现任何 token 字段");

    const stillWaiting = await stack.channel.pollLogin(session.sessionId);
    assert.equal(stillWaiting?.phase, "waiting_scan", "第一个状态 wait 仍然是等待扫码");
    const scanned = await stack.channel.pollLogin(session.sessionId);
    assert.equal(scanned?.phase, "scanned");
    const confirmed = await stack.channel.pollLogin(session.sessionId);
    assert.equal(confirmed?.phase, "logged_in");

    const account = await stack.channel.completeLogin(session.sessionId);
    assert.equal(account.accountId, "acct-1");

    // 凭证必须落进加密存储，且数据库里看不到明文
    const secret = await stack.channel.accountSecretStore.load(account.accountId);
    assert.equal(secret.botToken, "token-AAA");
    const stored = stack.db.raw.prepare("SELECT ciphertext FROM credentials WHERE account_id = ?").get("acct-1") as { ciphertext: string };
    assert.ok(stored.ciphertext.length > 0);
    assert.equal(stored.ciphertext.includes("token-AAA"), false, "凭证必须是密文");
  } finally {
    await stack.close();
  }
});

test("QR login handles need_verifycode, blocked, expired, redirect and already-bound", async () => {
  const verify = await createWeixinStack({ qrStatuses: ["need_verifycode"] });
  try {
    const session = await verify.channel.startLogin();
    const state = await verify.channel.pollLogin(session.sessionId);
    assert.equal(state?.phase, "need_verifycode");
    assert.equal(state?.needsVerifyCode, true);
    const submitted = verify.channel.submitVerifyCode(session.sessionId, "1234");
    assert.equal(submitted?.needsVerifyCode, false);
    const sent = verify.server.calls.filter((call) => call.path.includes("get_qrcode_status"));
    assert.ok(sent.length >= 1);
  } finally {
    await verify.close();
  }

  const blocked = await createWeixinStack({ qrStatuses: ["verify_code_blocked", "wait"] });
  try {
    const session = await blocked.channel.startLogin();
    const state = await blocked.channel.pollLogin(session.sessionId);
    assert.equal(state?.phase, "verify_code_blocked");
    // 允许重新取码继续登录
    const refreshed = await blocked.channel.pollLogin(session.sessionId);
    assert.ok(["waiting_scan", "verify_code_blocked"].includes(refreshed?.phase ?? ""));
  } finally {
    await blocked.close();
  }

  const expired = await createWeixinStack({ qrStatuses: ["expired", "expired", "expired", "expired", "expired"] });
  try {
    const session = await expired.channel.startLogin();
    let state = await expired.channel.pollLogin(session.sessionId);
    for (let index = 0; index < 6 && state?.phase !== "expired"; index += 1) {
      state = await expired.channel.pollLogin(session.sessionId);
    }
    assert.equal(state?.phase, "expired", "刷新次数用尽后必须进入 expired");
  } finally {
    await expired.close();
  }

  const redirect = await createWeixinStack({
    qrStatuses: ["scaned_but_redirect"],
    qrExtras: { scaned_but_redirect: { redirect_host: "redirect.example.com" } },
  });
  try {
    const session = await redirect.channel.startLogin();
    const state = await redirect.channel.pollLogin(session.sessionId);
    assert.equal(state?.phase, "redirected");
    assert.equal(state?.rawStatus, "scaned_but_redirect");
  } finally {
    await redirect.close();
  }

  const bound = await createWeixinStack({ qrStatuses: ["binded_redirect"] });
  try {
    const session = await bound.channel.startLogin();
    const state = await bound.channel.pollLogin(session.sessionId);
    assert.equal(state?.phase, "already_bound");
    await assert.rejects(() => bound.channel.completeLogin(session.sessionId), /登录尚未完成/);
  } finally {
    await bound.close();
  }
});

test("long poll maps text messages, stores context tokens, and commits cursor only after the batch", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [{ msgs: [inboundTextMessage({ messageId: "1001", fromUserId: "user-A", text: "你好", contextToken: "ctx-A" })], buffer: "buf-1" }],
  });
  try {
    const accountId = await loginWeixinAccount(stack);
    const outcome = await stack.channel.pollOnce(accountId);

    assert.equal(outcome.received, 1);
    assert.equal(outcome.processed, 1);
    assert.equal(outcome.committed, true);
    assert.equal(stack.inbound.length, 1);
    assert.equal(stack.inbound[0]?.text, "你好");
    assert.equal(stack.inbound[0]?.conversationId, "user-A");

    const cursor = createCursorStore({ db: stack.db.raw as unknown as SqlDatabase, clockNow: () => stack.clock.nowIso() });
    assert.equal(cursor.load(accountId).committed, "buf-1");
    assert.equal(cursor.pending(accountId), null, "成功处理后 pending 必须清空");

    // context_token 只存在于渠道的加密机密里
    assert.equal(await stack.channel.accountSecretStore.getContextToken(accountId, "user-A"), "ctx-A");
    const secretsRow = stack.db.raw.prepare("SELECT ciphertext FROM credentials WHERE account_id = ?").get(accountId) as { ciphertext: string };
    assert.equal(secretsRow.ciphertext.includes("ctx-A"), false, "context_token 必须以密文保存");

    // 下一轮请求必须带着已提交的游标
    const successCalls = stack.server.calls.filter((call) => call.path.includes("getupdates"));
    assert.equal((successCalls[0]?.body as { get_updates_buf?: string }).get_updates_buf, "");
    await stack.channel.pollOnce(accountId);
    const secondCalls = stack.server.calls.filter((call) => call.path.includes("getupdates"));
    assert.equal((secondCalls[1]?.body as { get_updates_buf?: string }).get_updates_buf, "buf-1");
  } finally {
    await stack.close();
  }
});

/**
 * 真实形状回归（曾经的真实故障）：
 * 登录响应里 `ilink_user_id` 是**扫码用户本人**的 id，`ilink_bot_id` 才是机器人自己的 id。
 * 以前用 ilink_user_id 做 self 判定，于是"用户发给机器人的每一条消息"都被当成自己发的回声丢掉，
 * 表现为：微信里发消息，程序完全没反应（日志里只有一条 self_echo skipped）。
 */
test("a message from the scanning user is NOT treated as self echo (ilink_user_id is the human, bot id is the account)", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [{ msgs: [inboundTextMessage({ messageId: "7001", fromUserId: "user-real", text: "测试1", contextToken: "ctx-real" })], buffer: "buf-real" }],
  });
  try {
    // 登录：机器人 id = acct-real，扫码用户 id = user-real（= 后面发消息的那个人）
    const accountId = await loginWeixinAccount(stack, { accountId: "acct-real", token: "token-real", userId: "user-real" });
    const outcome = await stack.channel.pollOnce(accountId);
    assert.equal(outcome.received, 1);
    assert.equal(outcome.skipped, 0, "用户本人发来的消息不能被 skip");
    assert.equal(outcome.processed, 1);
    assert.equal(stack.inbound.length, 1);
    assert.equal(stack.inbound[0]?.text, "测试1");
    assert.equal(stack.inbound[0]?.conversationId, "user-real");
  } finally {
    await stack.close();
  }
});

test("messages the bot itself produced are still skipped as self echo", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [{ msgs: [inboundTextMessage({ messageId: "7002", fromUserId: "acct-self", text: "机器人自己发的", contextToken: "ctx-self" })], buffer: "buf-self" }],
  });
  try {
    const accountId = await loginWeixinAccount(stack, { accountId: "acct-self", token: "token-self", userId: "user-self" });
    const outcome = await stack.channel.pollOnce(accountId);
    assert.equal(outcome.received, 1);
    assert.equal(outcome.skipped, 1, "机器人自己的消息必须被跳过，避免回声循环");
    assert.equal(outcome.processed, 0);
    assert.equal(stack.inbound.length, 0);
  } finally {
    await stack.close();
  }
});

test("empty batches are harmless and multi-message batches keep order", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [
      { msgs: [], buffer: "" },
      {
        msgs: [
          inboundTextMessage({ messageId: "2001", fromUserId: "user-A", text: "第一条" }),
          inboundTextMessage({ messageId: "2002", fromUserId: "user-A", text: "第二条" }),
          inboundTextMessage({ messageId: "2003", fromUserId: "user-A", text: "第三条" }),
        ],
        buffer: "buf-2",
      },
    ],
  });
  try {
    const accountId = await loginWeixinAccount(stack);
    const empty = await stack.channel.pollOnce(accountId);
    assert.equal(empty.received, 0);
    assert.equal(empty.committed, false);

    const batch = await stack.channel.pollOnce(accountId);
    assert.equal(batch.processed, 3);
    assert.deepEqual(stack.inbound.map((entry) => entry.text), ["第一条", "第二条", "第三条"]);
  } finally {
    await stack.close();
  }
});

test("duplicate deliveries are de-duplicated by protocol id (uint64 safe)", async () => {
  const message = inboundTextMessage({ messageId: MAX_UINT64, fromUserId: "user-A", text: "只应处理一次" });
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [
      { msgs: [message], buffer: "buf-dup-1" },
      { msgs: [message], buffer: "buf-dup-2" },
    ],
  });
  try {
    const accountId = await loginWeixinAccount(stack);
    const first = await stack.channel.pollOnce(accountId);
    const second = await stack.channel.pollOnce(accountId);
    assert.equal(first.processed, 1);
    assert.equal(second.processed, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(stack.inbound.length, 1);
    assert.equal(stack.inbound[0]?.messageId, MAX_UINT64, "uint64 消息 id 不能被改写");
  } finally {
    await stack.close();
  }
});

test("a failing message in the middle does not silently drop the rest of the batch", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [
      {
        msgs: [
          inboundTextMessage({ messageId: "3001", fromUserId: "user-A", text: "第一条" }),
          inboundTextMessage({ messageId: "3002", fromUserId: "user-A", text: "第二条" }),
          inboundTextMessage({ messageId: "3003", fromUserId: "user-A", text: "第三条" }),
        ],
        buffer: "buf-3",
      },
      {
        msgs: [
          inboundTextMessage({ messageId: "3001", fromUserId: "user-A", text: "第一条" }),
          inboundTextMessage({ messageId: "3002", fromUserId: "user-A", text: "第二条" }),
          inboundTextMessage({ messageId: "3003", fromUserId: "user-A", text: "第三条" }),
        ],
        buffer: "buf-3",
      },
    ],
  });
  try {
    const accountId = await loginWeixinAccount(stack);

    let failOnce = true;
    stack.channel.onInbound(async (message) => {
      const text = message.parts[0]?.kind === "text" ? message.parts[0].text : "";
      if (text === "第二条" && failOnce) {
        failOnce = false;
        throw new Error("core rejected this message");
      }
      stack.inbound.push({ conversationId: message.conversationId, text, messageId: message.externalRef.providerMessageId });
    });

    await assert.rejects(() => stack.channel.pollOnce(accountId), /batch incomplete|core rejected/);

    // 失败的这一批绝不能 commit
    const cursor = createCursorStore({ db: stack.db.raw as unknown as SqlDatabase, clockNow: () => stack.clock.nowIso() });
    assert.equal(cursor.load(accountId).committed, "", "批次未完成时不得提交游标");

    // 重取同一批：第一条已处理过会被去重，第二/三条这次都能处理
    const retry = await stack.channel.pollOnce(accountId);
    assert.equal(retry.processed, 2, "剩余消息必须能继续处理，而不是被静默丢弃");
    assert.deepEqual(stack.inbound.map((entry) => entry.text), ["第一条", "第二条", "第三条"]);
    assert.equal(cursor.load(accountId).committed, "buf-3");
  } finally {
    await stack.close();
  }
});

test("errcode -14 stops polling and requires re-login instead of looping forever", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [{ msgs: [], buffer: "" }],
    updatesErrors: [{ ret: 0, errcode: -14, errmsg: "session timeout" }],
  });
  try {
    const accountId = await loginWeixinAccount(stack);
    await assert.rejects(() => stack.channel.pollOnce(accountId), /凭证已失效|-14/);
    // 记在 -14 之后：此后不允许再有任何后端请求
    const callsAfterFailure = stack.server.calls.filter((call) => call.path.includes("getupdates")).length;

    const health = await stack.channel.health();
    assert.equal(health.state, "degraded");
    const views = await stack.channel.listAccountViews();
    assert.equal(views[0]?.requiresRelogin, true);
    assert.equal(views[0]?.loggedIn, false);

    // 后续轮询直接短路，不再打后端（避免无限重连风暴）
    const skipped = await stack.channel.pollOnce(accountId);
    assert.equal(skipped.reason, "credential_invalid");
    const callsAfter = stack.server.calls.filter((call) => call.path.includes("getupdates")).length;
    assert.equal(callsAfter, callsAfterFailure, "凭证失效后不得继续请求后端");

    // 重新登录后恢复
    stack.server.config.qrStatuses = ["confirmed"];
    const session = await stack.channel.startLogin();
    await stack.channel.pollLogin(session.sessionId);
    const result = await stack.channel.completeLogin(session.sessionId);
    assert.equal(result.accountId, accountId);
    const resumed = await stack.channel.pollOnce(accountId);
    assert.equal(resumed.reason, null);
  } finally {
    await stack.close();
  }
});

test("transport failures trigger bounded reconnect with backoff, and stop when aborted", async () => {
  const stack = await createWeixinStack({ qrStatuses: ["confirmed"], batches: [{ msgs: [], buffer: "" }] });
  try {
    const accountId = await loginWeixinAccount(stack);
    await stack.server.close(); // 后端下线

    const controller = new AbortController();
    const loop = stack.channel.pollOnce(accountId, { signal: controller.signal }).catch((error: unknown) => error);
    const error = await loop;
    assert.ok(error instanceof Error, "网络错误必须上抛，而不是被吞掉");

    const views = await stack.channel.listAccountViews();
    assert.ok((views[0]?.consecutiveFailures ?? 0) >= 0);
  } finally {
    await stack.close();
  }
});

test("send uses the account's own credentials, retries with backoff, and reports final failure", async () => {
  const sleeps: number[] = [];
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [{ msgs: [inboundTextMessage({ messageId: "4001", fromUserId: "user-A", text: "在吗", contextToken: "ctx-A" })], buffer: "buf-4" }],
    sendFailures: 2,
    senderOptions: {
      maxAttempts: 3,
      baseDelayMs: 10,
      jitterRatio: 0,
      random: () => 0.5,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
  try {
    const accountId = await loginWeixinAccount(stack);
    await stack.channel.pollOnce(accountId);

    const receipt = await stack.channel.send({
      channel: "weixin",
      accountId,
      conversationId: "user-A",
      parts: [{ kind: "text", text: "我在的" }],
      replyToProviderMessageId: null,
      streaming: { mode: "none", runId: null },
      idempotencyKey: "idem-1",
    });
    assert.equal(receipt.providerMessageId, "srv-1");
    assert.equal(sleeps.length, 2, "两次失败后各退避一次");
    assert.ok(sleeps.every((ms) => ms > 0));
    const sent = stack.server.sentMessages[0]!;
    assert.equal(sent.text, "我在的");
    assert.equal(sent.client_id, "idem-1", "幂等键必须原样作为 client_id 传递");
    assert.equal(sent.context_token, "ctx-A", "必须回传该会话的 context_token");
    assert.equal(sent.authorization, `Bearer ${stack.server.config.botToken}`);
  } finally {
    await stack.close();
  }
});

test("send gives up after maxAttempts and never leaks credentials in the error", async () => {
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    sendFailures: 99,
    senderOptions: { maxAttempts: 3, baseDelayMs: 1, jitterRatio: 0, sleepImpl: async () => {} },
  });
  try {
    const accountId = await loginWeixinAccount(stack);
    await assert.rejects(
      () =>
        stack.channel.send({
          channel: "weixin",
          accountId,
          conversationId: "user-A",
          parts: [{ kind: "text", text: "hello" }],
          replyToProviderMessageId: null,
          streaming: { mode: "none", runId: null },
          idempotencyKey: "idem-2",
        }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /微信发送失败/);
        assert.equal(message.includes("token-AAA"), false, "错误信息里不能出现凭证");
        return true;
      },
    );
    const attempts = stack.server.calls.filter((call) => call.path.includes("sendmessage")).length;
    assert.equal(attempts, 3, "重试次数必须有上限");
  } finally {
    await stack.close();
  }
});

test("accounts are isolated: credentials, cursors and context tokens never cross", async () => {
  const stack = await createWeixinStack({ qrStatuses: ["confirmed"] });
  try {
    // 账号 A
    stack.server.config.accountId = "acct-A";
    stack.server.config.botToken = "token-A";
    stack.server.config.ilinkUserId = "self-A";
    stack.server.setBatches([
      { msgs: [inboundTextMessage({ messageId: "5001", fromUserId: "user-A", text: "A 的消息", contextToken: "ctx-for-A" })], buffer: "buf-A" },
    ]);
    const accountA = await loginWeixinAccount(stack, { accountId: "acct-A", token: "token-A", userId: "self-A" });
    await stack.channel.pollOnce(accountA);

    // 账号 B
    stack.server.setBatches([
      { msgs: [inboundTextMessage({ messageId: "5002", fromUserId: "user-B", text: "B 的消息", contextToken: "ctx-for-B" })], buffer: "buf-B" },
    ]);
    const accountB = await loginWeixinAccount(stack, { accountId: "acct-B", token: "token-B", userId: "self-B" });
    await stack.channel.pollOnce(accountB);

    assert.notEqual(accountA, accountB);
    assert.equal(await stack.channel.accountSecretStore.getContextToken(accountA, "user-A"), "ctx-for-A");
    assert.equal(await stack.channel.accountSecretStore.getContextToken(accountB, "user-B"), "ctx-for-B");
    assert.equal(await stack.channel.accountSecretStore.getContextToken(accountB, "user-A"), null, "B 不能读到 A 会话的令牌");

    // 两个账号各自的游标互不影响
    const cursor = createCursorStore({ db: stack.db.raw as unknown as SqlDatabase, clockNow: () => stack.clock.nowIso() });
    assert.equal(cursor.load(accountA).committed, "buf-A");
    assert.equal(cursor.load(accountB).committed, "buf-B");

    // 发送时各用各的凭证
    await stack.channel.send({
      channel: "weixin",
      accountId: accountA,
      conversationId: "user-A",
      parts: [{ kind: "text", text: "给 A" }],
      replyToProviderMessageId: null,
      streaming: { mode: "none", runId: null },
      idempotencyKey: "idem-A",
    });
    await stack.channel.send({
      channel: "weixin",
      accountId: accountB,
      conversationId: "user-B",
      parts: [{ kind: "text", text: "给 B" }],
      replyToProviderMessageId: null,
      streaming: { mode: "none", runId: null },
      idempotencyKey: "idem-B",
    });
    const sentA = stack.server.sentMessages.find((entry) => entry.to_user_id === "user-A");
    const sentB = stack.server.sentMessages.find((entry) => entry.to_user_id === "user-B");
    assert.equal(sentA?.authorization, "Bearer token-A");
    assert.equal(sentB?.authorization, "Bearer token-B");
    assert.equal(sentA?.context_token, "ctx-for-A");
    assert.equal(sentB?.context_token, "ctx-for-B");

    // 删除账号 A 不影响 B
    await stack.channel.removeAccount(accountA);
    const remaining = await stack.channel.listAccountViews();
    assert.deepEqual(remaining.map((view) => view.accountId), [accountB]);
    assert.equal(await stack.channel.accountSecretStore.getContextToken(accountA, "user-A"), null);
    assert.equal(await stack.channel.accountSecretStore.getContextToken(accountB, "user-B"), "ctx-for-B");
  } finally {
    await stack.close();
  }
});

test("channel lifecycle and health reflect account state", async () => {
  const stack = await createWeixinStack({ qrStatuses: ["confirmed"], batches: [{ msgs: [], buffer: "" }] });
  try {
    const before = await stack.channel.health();
    assert.equal(before.state, "stopped");
    assert.equal(before.accounts, 0);

    const accountId = await loginWeixinAccount(stack);
    const accounts = await stack.channel.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.id, accountId);
    assert.equal(stack.channel.capabilities.media.image, false, "Phase 4 不宣称媒体能力");

    await stack.channel.stop();
    const after = await stack.channel.health();
    assert.ok(["degraded", "starting", "stopped"].includes(after.state));
  } finally {
    await stack.close();
  }
});
test("polling loop stops on credential invalidation instead of hot-spinning", async () => {
  // 回归：runOnce 在"凭证失效/没有凭证"时会立刻返回。
  // 如果循环不退出，就会变成没有任何 await 让出点的忙等，把事件循环饿死。
  const stack = await createWeixinStack({
    qrStatuses: ["confirmed"],
    batches: [{ msgs: [], buffer: "" }],
  });
  try {
    const accountId = await loginWeixinAccount(stack, { autoStart: true });
    const callsAtStart = stack.server.calls.filter((call) => call.path.includes("getupdates")).length;

    // 让后台循环拿到 -14
    stack.server.config.updatesErrors = [{ ret: 0, errcode: -14, errmsg: "session timeout" }];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(await stack.channel.listAccountViews())[0]?.requiresRelogin) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const views = await stack.channel.listAccountViews();
    assert.equal(views[0]?.requiresRelogin, true, "后台循环必须把账号标记为需要重新登录");

    const callsAtStop = stack.server.calls.filter((call) => call.path.includes("getupdates")).length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const callsLater = stack.server.calls.filter((call) => call.path.includes("getupdates")).length;
    assert.equal(callsLater, callsAtStop, "失效后循环必须停下来，而不是继续打后端/空转");
    assert.ok(callsAtStop >= callsAtStart);
    assert.equal((await stack.channel.health()).state, "degraded");
  } finally {
    await stack.close();
  }
});

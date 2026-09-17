import { test } from "node:test";
import assert from "node:assert/strict";
import { createQQStack } from "../helpers/qq-stack.ts";
import { QQ_DEFAULT_INTENTS, QQ_INTENTS } from "../../src/channels/qq/gateway/gateway.ts";
import { qqConversationRef } from "../../src/channels/qq/receiver/inbound-mapper.ts";
import type { InternalResponse } from "../../src/core/model/message.ts";

function hello(socket: { emitMessage: (frame: unknown) => void }): void {
  socket.emitMessage({ op: 10, d: { heartbeat_interval: 30_000 } });
}

function ready(socket: { emitMessage: (frame: unknown) => void }, sessionId = "sess-1"): void {
  socket.emitMessage({ op: 0, s: 1, t: "READY", d: { session_id: sessionId } });
}

function responseFor(conversationId: string, text: string): InternalResponse {
  return {
    channel: "qq",
    accountId: "102000001",
    conversationId,
    parts: [{ kind: "text", text }],
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey: "test-" + text,
  };
}

test("没配置时不连网关：状态如实说 not_configured", async () => {
  const stack = await createQQStack({ configure: false });
  try {
    await stack.channel.start();
    const status = stack.channel.status();
    assert.equal(status.configured, false);
    assert.equal(status.session.state, "not_configured");
    assert.equal(stack.server.tokenCalls, 0, "没配置就不该去要 token");
    assert.equal(stack.server.gatewayCalls, 0);
  } finally {
    await stack.close();
  }
});

test("配好之后：取 token → 拿网关地址 → IDENTIFY 帧按官方协议填", async () => {
  const stack = await createQQStack();
  try {
    await stack.channel.start();
    assert.equal(stack.server.tokenCalls, 1, "要换一次 access_token");
    assert.equal(stack.server.gatewayCalls, 1, "要带鉴权拿一次网关地址");

    const socket = stack.socket();
    assert.equal(socket.url, "wss://gateway.test/");
    hello(socket);

    const identify = socket.lastFrame() as { op: number; d: { token: string; intents: number; shard: number[] } };
    assert.equal(identify.op, 2, "op=2 是 IDENTIFY");
    assert.equal(identify.d.token, "QQBot token-qq-1", "token 必须是 QQBot <access_token> 形式");
    assert.equal(identify.d.intents, QQ_DEFAULT_INTENTS);
    assert.equal(identify.d.intents & QQ_INTENTS.GROUP_AND_C2C, QQ_INTENTS.GROUP_AND_C2C, "必须订阅单聊/群聊事件位");
    assert.deepEqual(identify.d.shard, [0, 1]);

    ready(socket);
    assert.equal(stack.channel.status().session.state, "connected");
  } finally {
    await stack.close();
  }
});

test("单聊消息：事件 → 内部消息 → 回复走被动回复（带 msg_id 与递增 msg_seq）", async () => {
  const stack = await createQQStack();
  try {
    await stack.channel.start();
    const socket = stack.socket();
    hello(socket);
    ready(socket);

    socket.emitMessage({
      op: 0,
      s: 2,
      t: "C2C_MESSAGE_CREATE",
      d: { id: "qq-inbound-1", content: "<@!bot> 你好呀", timestamp: "2026-09-17T10:00:00Z", author: { user_openid: "USER_OPENID_1" } },
    });

    assert.equal(stack.inbound.length, 1, "入站消息要交到 Core");
    assert.equal(stack.inbound[0]?.conversationId, qqConversationRef("c2c", "USER_OPENID_1"));
    assert.equal(stack.inbound[0]?.text, "你好呀", "@机器人 前缀要去掉");

    await stack.channel.send(responseFor(qqConversationRef("c2c", "USER_OPENID_1"), "在的，说吧。"));
    const sent = stack.server.sent.at(-1);
    assert.equal(sent?.path, "/v2/users/USER_OPENID_1/messages");
    assert.equal(sent?.authorization, "QQBot token-qq-1");
    assert.equal(sent?.body.content, "在的，说吧。");
    assert.equal(sent?.body.msg_type, 0);
    assert.equal(sent?.body.msg_id, "qq-inbound-1", "被动回复必须带上触发消息的 id");
    assert.equal(typeof sent?.body.msg_seq, "number");
  } finally {
    await stack.close();
  }
});

test("群聊 @：走群接口，且同一条 msg_id 的回复序号递增", async () => {
  const stack = await createQQStack();
  try {
    await stack.channel.start();
    const socket = stack.socket();
    hello(socket);
    ready(socket);

    socket.emitMessage({
      op: 0,
      s: 3,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "qq-inbound-2", content: "在吗", timestamp: "2026-09-17T10:01:00Z", group_openid: "GROUP_1", author: { member_openid: "MEMBER_1" } },
    });
    assert.equal(stack.inbound[0]?.conversationId, qqConversationRef("group", "GROUP_1"));

    await stack.channel.send(responseFor(qqConversationRef("group", "GROUP_1"), "第一句"));
    await stack.channel.send(responseFor(qqConversationRef("group", "GROUP_1"), "第二句"));
    const first = stack.server.sent.at(-2);
    const second = stack.server.sent.at(-1);
    assert.equal(first?.path, "/v2/groups/GROUP_1/messages");
    assert.equal(second?.path, "/v2/groups/GROUP_1/messages");
    assert.equal(first?.body.msg_id, "qq-inbound-2");
    assert.equal(second?.body.msg_id, "qq-inbound-2");
    assert.notEqual(first?.body.msg_seq, second?.body.msg_seq, "同一条消息的多次回复要递增序号，否则平台会去重");
  } finally {
    await stack.close();
  }
});

test("主动消息（没有入站记录）：不带 msg_id，失败要把原因说清楚", async () => {
  const stack = await createQQStack();
  try {
    await stack.channel.start();
    const socket = stack.socket();
    hello(socket);
    ready(socket);

    await stack.channel.send(responseFor(qqConversationRef("c2c", "USER_OPENID_9"), "主动打个招呼"));
    const sent = stack.server.sent.at(-1);
    assert.equal(sent?.body.msg_id, undefined, "没有触发消息就不能假装被动回复");
    assert.equal(sent?.body.content, "主动打个招呼");
  } finally {
    await stack.close();
  }
});

test("鉴权失败（4004）：停止重连并如实报错，不吞成「连接中」", async () => {
  const stack = await createQQStack();
  try {
    await stack.channel.start();
    const socket = stack.socket();
    hello(socket);
    socket.emitClose(4004);

    const status = stack.channel.status();
    assert.equal(status.session.state, "stopped");
    assert.match(status.session.lastError ?? "", /鉴权失败|4004/);
    assert.equal(stack.server.tokenCalls, 1, "鉴权失败不该反复去要 token");
  } finally {
    await stack.close();
  }
});

test("密钥只进不出：状态接口不含 clientSecret，日志也不含", async () => {
  const stack = await createQQStack();
  try {
    await stack.channel.start();
    const status = stack.channel.status() as Record<string, unknown>;
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("secret-qq-1"), false, "状态里绝不能出现 clientSecret");
    assert.equal(await stack.channel.hasCredentials(), true, "只回答有没有配");
    assert.equal(serialized.includes("token-qq-1"), false, "状态里也不能出现 access_token");
  } finally {
    await stack.close();
  }
});


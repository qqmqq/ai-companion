import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import type { Container } from "../../src/app/bootstrap.ts";
import type { InternalMessage } from "../../src/core/model/message.ts";

/**
 * 渠道重投的幂等：真实事故是一条微信消息在会话里出现了 5 次。
 * 链路：微信 long-poll 处理失败 → 释放去重声明、不 commit 游标 → 下一轮重投同一批消息。
 * 如果入站落库不幂等，每次重投都会再插一条用户消息（而且每一条都会触发一次模型调用）。
 */

const REF = "wx-friend-idem";

function inbound(text: string, id: string, characterId: string): InternalMessage {
  return {
    id,
    channel: "weixin",
    accountId: "acct-idem",
    conversationId: REF,
    sender: { id: REF, name: null, isSelf: false },
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    type: "text",
    parts: [{ kind: "text", text }],
    replyTo: null,
    metadata: { characterId },
    externalRef: { providerMessageId: id },
  };
}

/** 建一个角色：渠道消息必须能解析到角色，否则会在"没有角色"这一步就被丢掉 */
function createCharacter(container: Container): string {
  return container.services.characters.create({
    userId: container.user.id,
    importedFrom: "create",
    definition: {
      name: "蛛",
      description: "住在飞船上的人",
      personality: "话少",
      scenario: "飞船驾驶舱",
      systemPrompt: "",
      firstMessage: "……醒了？",
    },
  }).record.id;
}

async function dropAllProviders(baseUrl: string): Promise<void> {
  const listed = (await (await fetch(baseUrl + "/api/providers")).json()) as { items: Array<{ id: string }> };
  for (const provider of listed.items) {
    await fetch(baseUrl + "/api/providers/" + provider.id, { method: "DELETE" });
  }
}

test("回复失败后同一条消息被重投 5 次：会话里只该有一条用户消息", async () => {
  const server = await createRunningServer();
  const container: Container = server.container;
  try {
    const characterId = createCharacter(container);
    // 模拟"模型不可用"（正是事故当晚的情形：上游超时/过载）
    await dropAllProviders(server.baseUrl);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        async () => await container.pipeline.handleInbound(inbound("道德是天生的还是后天的", "7507177687585915528", characterId)),
        /模型|provider/i,
        "第 " + String(attempt + 1) + " 次重投依然该如实失败",
      );
    }

    const conversation = container.services.conversations
      .list(container.user.id, 100)
      .find((entry) => entry.channel === "weixin" && entry.conversationId === REF);
    assert.ok(conversation !== undefined, "会话应该被建出来");
    const messages = container.repos.messages.listByConversation(conversation.id);
    const userMessages = messages.filter((message) => message.role === "user");
    assert.equal(userMessages.length, 1, "重投 5 次也只能有一条用户消息，实际 " + String(userMessages.length));
    assert.equal(userMessages[0]?.providerMessageId, "7507177687585915528");
    const characterMessages = messages.filter((message) => message.role === "character");
    assert.equal(characterMessages.length, 1, "回复都失败了，只该剩下会话开场白那一条");
    assert.equal(messages.length, 2, "一条用户消息 + 一条开场白，不该再多");
  } finally {
    await server.close();
  }
});

test("已经回过的那条消息被重投：不再调一次模型，而是把同一条回复再送一遍", async () => {
  const server = await createRunningServer();
  const container: Container = server.container;
  try {
    const characterId = createCharacter(container);
    const first = await container.pipeline.handleInbound(inbound("在吗", "dup-once", characterId));
    assert.ok(first !== null, "第一次应该正常回");
    // 响应里的 conversationId 是渠道侧的会话引用，落库用的是内部 id
    const conversation = container.services.conversations
      .list(container.user.id, 100)
      .find((entry) => entry.channel === "weixin" && entry.conversationId === REF);
    assert.ok(conversation !== undefined, "会话应该被建出来");
    const conversationId = conversation.id;
    const afterFirst = container.repos.messages.listByConversation(conversationId);

    // 渠道重投同一条消息（客户端没收到回复时会这样）
    const second = await container.pipeline.handleInbound(inbound("在吗", "dup-once", characterId));
    assert.ok(second !== null);
    const afterSecond = container.repos.messages.listByConversation(conversationId);

    assert.equal(
      afterSecond.filter((message) => message.role === "user").length,
      1,
      "重投不该再插一条用户消息",
    );
    assert.equal(afterSecond.length, afterFirst.length, "也不该再生成一条角色消息：应该复用上一条");
    assert.equal(second.idempotencyKey, first.idempotencyKey, "重投送的还是同一条回复，出站幂等键必须一样");
    assert.match(second.idempotencyKey, /^reply:/, "幂等键由回复本身派生，而不是随机值");
    assert.deepEqual(second.parts, first.parts, "重投送出去的内容应与首次一致");
  } finally {
    await server.close();
  }
});

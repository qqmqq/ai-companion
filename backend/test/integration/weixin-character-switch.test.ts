import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import { startMockWeixinServer } from "../helpers/mock-weixin-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";
import type { InternalMessage } from "../../src/core/model/message.ts";
import type { WeixinChannel } from "../../src/channels/weixin/channel.ts";

/**
 * 微信里换角色：口令 → 换会话 → 新会话的第一句话是那个角色的开场白。
 * 全程真 HTTP（mock 微信后端）+ 真 SQLite；口令解析、会话创建、开场白送达都在这条链路上。
 */

const REF = "wx-friend-1";

function inbound(text: string, accountId: string, id: string): InternalMessage {
  return {
    id,
    channel: "weixin",
    accountId,
    conversationId: REF,
    sender: { id: REF, name: null, isSelf: false },
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    type: "text",
    parts: [{ kind: "text", text }],
    replyTo: null,
    metadata: {},
    externalRef: { providerMessageId: id },
  };
}

async function createCharacter(container: Container, input: { name: string; firstMessage: string }): Promise<string> {
  const view = container.services.characters.create({
    userId: container.user.id,
    importedFrom: "create",
    definition: {
      name: input.name,
      description: input.name + " 的设定",
      personality: "安静",
      scenario: "书房",
      systemPrompt: "",
      firstMessage: input.firstMessage,
    },
  });
  return view.record.id;
}

function weixinConversations(container: Container, characterId: string) {
  return container.services.conversations
    .list(container.user.id, 100)
    .filter((conversation) => conversation.channel === "weixin" && conversation.characterId === characterId);
}

test("微信里「切换角色」：换人 = 换会话，新会话第一句就是那个角色的开场白", async () => {
  const mock = await startMockWeixinServer({ qrStatuses: ["confirmed"], botToken: "token-switch", accountId: "acct-switch" });
  const server = await createRunningServer({ fetchImpl: fetch, settingsSeed: { "weixin.baseUrl": mock.baseUrl } });
  const container = server.container;

  try {
    const adapter = container.channels.get("weixin") as WeixinChannel | undefined;
    assert.ok(adapter !== undefined, "微信渠道应被注册");
    const session = await adapter.startLogin();
    await adapter.pollLogin(session.sessionId);
    const finished = await adapter.pollLogin(session.sessionId);
    assert.equal(finished?.phase, "logged_in");
    const { accountId } = await adapter.completeLogin(session.sessionId);
    await adapter.stop();

    const aria = await createCharacter(container, { name: "Aria", firstMessage: "在的，今天想聊点什么？" });
    const kai = await createCharacter(container, { name: "Kai", firstMessage: "……说吧。" });

    // 1) 第一条消息：没有任何指定，按兜底走第一个角色（Aria），新建微信会话
    await container.pipeline.handleInbound(inbound("你好呀", accountId, "m-1"));
    assert.equal(mock.sentMessages.length, 1, "第一条消息要有回复");
    assert.equal(weixinConversations(container, aria).length, 1, "Aria的微信会话被创建");
    const ariaConversation = weixinConversations(container, aria)[0]!;

    // 2) 切换口令：换到Kai → 新会话 + 开场白直接发出去
    const sentBefore = mock.sentMessages.length;
    const switched = await container.pipeline.handleInbound(inbound("切换角色 Kai", accountId, "m-2"));
    assert.ok(switched !== null);
    assert.equal(switched.parts[0]?.kind, "text");
    assert.equal((switched.parts[0] as { text: string }).text, "……说吧。", "切换后的第一句就是Kai的开场白");
    assert.equal(mock.sentMessages.length, sentBefore + 1, "开场白必须真的发到微信");
    assert.equal(mock.sentMessages.at(-1)?.to_user_id, REF);
    assert.equal(mock.sentMessages.at(-1)?.text, "……说吧。");

    const kaiConversations = weixinConversations(container, kai);
    assert.equal(kaiConversations.length, 1, "Kai有一个新的微信会话");
    assert.notEqual(kaiConversations[0]?.id, ariaConversation.id, "必须是新会话，不是塞进旧会话");
    const kaiMessages = container.services.conversations.messages(kaiConversations[0]!.id);
    assert.equal(kaiMessages.length, 1, "新会话里先落库的只有开场白");
    assert.equal(kaiMessages[0]?.textRender, "……说吧。");
    assert.equal(kaiMessages[0]?.role, "character");

    // 旧会话一条都没多：开场白 + 用户那句 + 一句回复 = 3
    const ariaBaseline = container.services.conversations.messages(ariaConversation.id).length;
    assert.equal(ariaBaseline, 3, "Aria那边就是开场白 + 一问一答");

    // 3) 之后的普通消息进的是Kai的会话
    await container.pipeline.handleInbound(inbound("在吗", accountId, "m-3"));
    const kaiAfter = container.services.conversations.messages(kaiConversations[0]!.id);
    assert.ok(kaiAfter.length >= 3, "Kai的会话里应该多了用户消息与回复，实际 " + String(kaiAfter.length));
    assert.ok(kaiAfter.some((message) => message.role === "user" && message.textRender === "在吗"));
    assert.equal(container.services.conversations.messages(ariaConversation.id).length, ariaBaseline, "Aria的会话不再增长");

    // 4) 角色列表：说得出现在在跟谁聊
    const listed = await container.pipeline.handleInbound(inbound("角色列表", accountId, "m-4"));
    const listText = (listed?.parts[0] as { text: string }).text;
    assert.match(listText, /Aria/);
    assert.match(listText, /Kai/);
    assert.match(listText, /Kai（现在在聊）/, "要标出现在在跟谁聊");
    assert.match(listText, /切换角色/);

    // 5) 名字对不上：说清楚并给列表，不瞎切
    const missing = await container.pipeline.handleInbound(inbound("切换角色 张三", accountId, "m-5"));
    const missingText = (missing?.parts[0] as { text: string }).text;
    assert.match(missingText, /没有叫「张三」的角色/);
    assert.match(missingText, /Kai/);

    // 6) 切回去：复用已有会话，不新建
    const back = await container.pipeline.handleInbound(inbound("切换角色 Aria", accountId, "m-6"));
    assert.match((back?.parts[0] as { text: string }).text, /已经切回「Aria」/);
    assert.equal(weixinConversations(container, aria).length, 1, "切回去不该再建一个会话");

    // 7) 带"换"字的普通聊天不能被当成口令
    const chat = await container.pipeline.handleInbound(inbound("换成什么样都行吗", accountId, "m-7"));
    const chatText = (chat?.parts[0] as { text: string }).text;
    assert.equal(chatText.includes("现在的角色："), false, "这不是切换口令，不该回列表");
    assert.equal(weixinConversations(container, kai).length, 1, "没有因为一句话就多出会话");
  } finally {
    await server.close();
    await mock.close();
  }
});

test("后台界面也能换角色：同一个逻辑，开场白照样发到微信", async () => {
  const mock = await startMockWeixinServer({ qrStatuses: ["confirmed"], botToken: "token-ui-switch", accountId: "acct-ui" });
  const server = await createRunningServer({ fetchImpl: fetch, settingsSeed: { "weixin.baseUrl": mock.baseUrl } });
  const container = server.container;

  try {
    const adapter = container.channels.get("weixin") as WeixinChannel | undefined;
    assert.ok(adapter !== undefined);
    const session = await adapter.startLogin();
    await adapter.pollLogin(session.sessionId);
    await adapter.pollLogin(session.sessionId);
    const { accountId } = await adapter.completeLogin(session.sessionId);
    await adapter.stop();

    const aria = await createCharacter(container, { name: "Aria", firstMessage: "在的，今天想聊点什么？" });
    const kai = await createCharacter(container, { name: "Kai", firstMessage: "……说吧。" });

    // 微信侧已经跟Aria聊上了（会话由入站消息创建）
    await container.pipeline.handleInbound(inbound("你好", accountId, "ui-1"));
    const chat = weixinConversations(container, aria)[0]!;

    const listed = (await (await fetch(server.baseUrl + "/api/conversations")).json()) as {
      items: Array<{ id: string; channel: string; activeCharacterId: string | null }>;
    };
    const listedChat = listed.items.find((item) => item.id === chat.id);
    assert.ok(listedChat !== undefined, "会话列表里要有这条微信会话");
    assert.equal(listedChat?.activeCharacterId, null, "没切过就是 null，界面据此显示按第一个角色回复");

    const sentBefore = mock.sentMessages.length;
    const response = await fetch(server.baseUrl + "/api/conversations/" + chat.id + "/active-character", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: kai }),
    });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as {
      conversationId: string;
      characterName: string;
      newConversation: boolean;
      text: string;
      delivered: boolean;
      deliveryError: string | null;
    };
    assert.equal(outcome.characterName, "Kai");
    assert.equal(outcome.newConversation, true, "没聊过的角色 → 新会话");
    assert.equal(outcome.text, "……说吧。", "返回的开场白就是那个角色的话");
    assert.equal(outcome.delivered, true, "点按钮也要把开场白发到微信");
    assert.equal(outcome.deliveryError, null);
    assert.equal(mock.sentMessages.length, sentBefore + 1);
    assert.equal(mock.sentMessages.at(-1)?.text, "……说吧。");
    assert.equal(weixinConversations(container, kai).length, 1, "Kai有了新会话");

    const afterSwitch = (await (await fetch(server.baseUrl + "/api/conversations")).json()) as {
      items: Array<{ id: string; activeCharacterId: string | null }>;
    };
    assert.equal(afterSwitch.items.find((item) => item.id === chat.id)?.activeCharacterId, kai, "当前角色记在这条聊天上");

    // 切回Aria：复用原会话，不再新建
    const back = await fetch(server.baseUrl + "/api/conversations/" + chat.id + "/active-character", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: aria }),
    });
    const backOutcome = (await back.json()) as { newConversation: boolean; text: string };
    assert.equal(backOutcome.newConversation, false);
    assert.match(backOutcome.text, /已经切回「Aria」/);
    assert.equal(weixinConversations(container, aria).length, 1, "不该多出会话");

    // 角色不存在 → 404，而不是静默切换
    const missing = await fetch(server.baseUrl + "/api/conversations/" + chat.id + "/active-character", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: "no-such-character" }),
    });
    assert.equal(missing.status, 404);

    assert.ok(
      container.repos.audit.list(50).some((entry) => entry.action === "conversation.character_switched"),
      "后台换角色要留审计",
    );
  } finally {
    await server.close();
    await mock.close();
  }
});

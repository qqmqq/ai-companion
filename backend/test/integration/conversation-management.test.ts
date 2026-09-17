import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestContainer } from "../helpers/container.ts";
import { createHttpServer } from "../../src/app/http-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";

type App = ReturnType<typeof createHttpServer>;

async function withServer(run: (ctx: { app: App; container: Container }) => Promise<void>): Promise<void> {
  const container = await createTestContainer();
  const app = createHttpServer(container);
  try {
    await run({ app, container });
  } finally {
    await app.close();
    await container.shutdown();
  }
}

async function createCharacter(app: App, name = "Aria"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/characters",
    payload: { name, description: "测试角色", personality: "安静", scenario: "书房", systemPrompt: "", firstMessage: "在的。" },
  });
  assert.equal(response.statusCode, 201);
  return (response.json() as { id: string }).id;
}

/** 用渠道无关的路由入口造一条微信会话（与入站管线用的是同一个方法） */
function ensureWeixinConversation(container: Container, characterId: string, ref = "wx-user-1", accountId = "test-account@im.bot") {
  return container.services.conversations.ensureConversation({
    userId: container.user.id,
    characterId,
    channel: "weixin",
    accountId,
    conversationRef: ref,
  });
}

interface ConversationItem {
  id: string;
  characterId: string;
  source: string;
  channel: string;
  lastMessageText: string | null;
  lastMessageAt: string | null;
}

async function listConversations(app: App): Promise<ConversationItem[]> {
  const response = await app.inject({ method: "GET", url: "/api/conversations" });
  assert.equal(response.statusCode, 200);
  return (response.json() as { items: ConversationItem[] }).items;
}

function memoryRow(container: Container, input: { id: string; scope: "conversation" | "character"; conversationId: string | null; characterId: string; content: string }) {
  const at = container.clock.nowIso();
  container.repos.memories.insert({
    id: input.id,
    scope: input.scope,
    type: "fact",
    content: input.content,
    contentHash: "hash-" + input.id,
    importance: 0.5,
    confidence: 0.8,
    userId: container.user.id,
    characterId: input.characterId,
    conversationId: input.conversationId,
    sourceMessageId: null,
    tags: [],
    reinforcement: 0,
    accessCount: 0,
    lastAccessedAt: null,
    embedding: null,
    supersededBy: null,
    status: "active",
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

test("Test 1 + Test 2：网页会话 source=web，微信会话 source=weixin（来源写在会话本身）", async () => {
  await withServer(async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const web = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId } });
    assert.equal(web.statusCode, 201);
    assert.equal((web.json() as ConversationItem).source, "web");

    const weixin = ensureWeixinConversation(container, characterId);
    container.services.conversations.appendUserMessage(weixin.id, [{ kind: "text", text: "测试1" }], "pm-1");

    const items = await listConversations(app);
    assert.equal(items.length, 2);
    const sources = items.map((item) => item.source).sort();
    assert.deepEqual(sources, ["web", "weixin"]);
    const weixinItem = items.find((item) => item.id === weixin.id);
    assert.equal(weixinItem?.source, "weixin");
    assert.equal(weixinItem?.characterId, characterId, "同一个角色可以有不同来源的会话，来源不混进角色名");
    assert.equal(weixinItem?.lastMessageText, "测试1", "列表要能显示最后一条消息");
    assert.equal(items.find((item) => item.id !== weixin.id)?.lastMessageText, "在的。", "网页会话的最后一条是开场白");
  });
});

test("Test 6：删除网页会话 → 会话与消息都没了，角色和其它会话不受影响", async () => {
  await withServer(async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const web = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId } });
    const webId = (web.json() as ConversationItem).id;
    const weixin = ensureWeixinConversation(container, characterId);

    assert.ok(container.repos.messages.listByConversation(webId).length > 0);
    const removed = await app.inject({ method: "DELETE", url: "/api/conversations/" + webId });
    assert.equal(removed.statusCode, 204);

    const items = await listConversations(app);
    assert.deepEqual(items.map((item) => item.id), [weixin.id], "只剩微信会话");
    assert.equal(container.repos.messages.listByConversation(webId).length, 0, "消息必须一起删掉");
    assert.equal(container.repos.conversations.getById(webId), null);
    const character = await app.inject({ method: "GET", url: "/api/characters/" + characterId });
    assert.equal(character.statusCode, 200, "角色不能被删掉");
  });
});

test("Test 7：删除微信会话 → 账号 / 游标 / 凭据都不动，后续消息仍能恢复会话", async () => {
  await withServer(async ({ app, container }) => {
    const at = container.clock.nowIso();
    const characterId = await createCharacter(app);
    const accountId = "keep-me@im.bot";
    container.db.raw
      .prepare("INSERT INTO channel_accounts (id, channel_kind, external_account_id, display_name, status, bound_user_id, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(accountId, "weixin", accountId, "微信账号 .bot", "active", container.user.id, null, at);
    container.db.raw
      .prepare("INSERT INTO channel_cursors (account_id, conversation_ref, cursor, pending_cursor, committed_at) VALUES (?, ?, ?, ?, ?)")
      .run(accountId, "poll", "cursor-value", null, at);
    await container.credentials.putSecret(accountId, { botToken: "secret-token" });

    const conversation = ensureWeixinConversation(container, characterId, "wx-user-9", accountId);
    container.services.conversations.appendUserMessage(conversation.id, [{ kind: "text", text: "测试2" }], "pm-2");

    const removed = await app.inject({ method: "DELETE", url: "/api/conversations/" + conversation.id });
    assert.equal(removed.statusCode, 204);

    const accounts = container.db.raw.prepare("SELECT id FROM channel_accounts WHERE id = ?").all(accountId);
    assert.equal(accounts.length, 1, "微信账号必须保留（否则等于把微信踢下线）");
    const cursors = container.db.raw.prepare("SELECT cursor FROM channel_cursors WHERE account_id = ?").all(accountId) as Array<{ cursor: string }>;
    assert.equal(cursors[0]?.cursor, "cursor-value", "渠道游标不能被清掉");
    assert.equal(await container.credentials.hasSecret(accountId), true, "登录凭据必须保留");

    // 路由恢复：同一条入站消息再次到达时，会话会被重新创建（新 id），不会报错
    const restored = ensureWeixinConversation(container, characterId, "wx-user-9", accountId);
    assert.notEqual(restored.id, conversation.id);
    assert.equal(restored.channel, "weixin");
    assert.equal(restored.characterVersionId, conversation.characterVersionId, "恢复的会话仍然冻结当前角色版本");
  });
});

test("记忆：会话作用域的记忆随会话删除，长期记忆只解除引用，链接不悬空", async () => {
  await withServer(async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const conversation = ensureWeixinConversation(container, characterId);
    memoryRow(container, { id: "mem-scoped", scope: "conversation", conversationId: conversation.id, characterId, content: "这次会话里说的临时事" });
    memoryRow(container, { id: "mem-long", scope: "character", conversationId: conversation.id, characterId, content: "用户喜欢深烘咖啡" });
    container.repos.memories.insertLink({ id: "link-1", fromMemoryId: "mem-long", relation: "same_subject", targetType: "conversation", targetId: conversation.id, weight: 1, createdAt: container.clock.nowIso() });

    const removed = await app.inject({ method: "DELETE", url: "/api/conversations/" + conversation.id });
    assert.equal(removed.statusCode, 204);

    assert.equal(container.repos.memories.getById("mem-scoped"), null, "属于该会话的记忆应该被删除");
    const kept = container.repos.memories.getById("mem-long");
    assert.ok(kept !== null, "长期记忆不能被删掉");
    assert.equal(kept?.conversationId, null, "只解除会话引用");
    assert.equal(container.repos.memories.listLinks("mem-long").length, 0, "指向已删除会话的链接必须清掉");
  });
});

test("Test 9：重复删除返回 404 not_found，而不是 500 或崩溃", async () => {
  await withServer(async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const conversation = ensureWeixinConversation(container, characterId);
    const first = await app.inject({ method: "DELETE", url: "/api/conversations/" + conversation.id });
    assert.equal(first.statusCode, 204);
    const second = await app.inject({ method: "DELETE", url: "/api/conversations/" + conversation.id });
    assert.equal(second.statusCode, 404);
    const body = second.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "not_found");
    assert.equal(body.error.message.includes("at "), false, "错误信息里不能出现堆栈");
    const missing = await app.inject({ method: "DELETE", url: "/api/conversations/does-not-exist" });
    assert.equal(missing.statusCode, 404);
  });
});

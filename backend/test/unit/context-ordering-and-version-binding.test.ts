import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStack, type ChatStack } from "../helpers/chat-stack.ts";
import { SECTION_PRESENTATION_ORDER, SECTION_PRIORITY } from "../../src/core/context/context-engine.ts";
import { simpleHash } from "../../src/core/memory/memory-service.ts";
import type { ContextSectionKind } from "../../src/core/model/context.ts";
import type { Message } from "../../src/core/model/message.ts";

/**
 * 角色定义就是本程序自己的模型：六个字段，没有任何第三方卡格式的概念。
 * 本文件覆盖两件容易回归的事：
 *   1) 上下文分区的确定性顺序 / 优先级（只覆盖仍然存在的分区）；
 *   2) 会话在创建时冻结角色版本 —— 改卡只影响之后新建的会话。
 */

const DEFINITION = {
  name: "Aria",
  description: "温柔的咖啡师",
  personality: "耐心、说话很慢",
  scenario: "小镇上的咖啡馆",
  systemPrompt: "始终用中文回答，一次最多两句话。",
  firstMessage: "欢迎回来。",
};

/** 仍然存在的全部上下文分区，按呈现顺序书写。 */
const ORDERED_KINDS: ContextSectionKind[] = [
  "app_instructions",
  "character_system_prompt",
  "character_definition",
  "relationship_state",
  "emotion_state",
  "runtime_state",
  "memories",
  "events",
  "conversation_summary",
  "background",
  "recent_conversation",
  "proactive_intent",
  "current_message",
];

/** 被删掉的第三方分区：既不在顺序表里，也不在优先级表里。 */
const REMOVED_KINDS = ["character_book", "message_examples", "post_history_instructions"];

/** 把定义写进当前角色版本（夹具的角色定义是空的，这里换成可控内容）。 */
function installDefinition(stack: ChatStack, definition: Record<string, unknown>): void {
  stack.db.raw
    .prepare("UPDATE character_versions SET definition_json = ? WHERE character_id = ?")
    .run(JSON.stringify(definition), stack.characterId);
}

function insertUserMessage(stack: ChatStack, conversationId: string, id: string, text: string): Message {
  const message: Message = {
    id,
    conversationId,
    role: "user",
    parts: [{ kind: "text", text }],
    textRender: text,
    replyToId: null,
    providerMessageId: null,
    tokenCount: null,
    status: "completed",
    errorText: null,
    source: "conversation",
    createdAt: stack.clock.nowIso(),
    editedAt: null,
    branchOfId: null,
  };
  stack.messages.insert(message);
  return message;
}

function newConversation(stack: ChatStack, ref: string): ReturnType<ChatStack["conversationService"]["ensureConversation"]> {
  return stack.conversationService.ensureConversation({
    userId: stack.userId,
    characterId: stack.characterId,
    channel: "web",
    accountId: null,
    conversationRef: ref,
  });
}

test("上下文分区顺序与优先级是确定的，且只覆盖仍然存在的分区", async () => {
  const stack = createChatStack();
  try {
    installDefinition(stack, DEFINITION);
    const conversation = newConversation(stack, "web:context-order");
    const at = stack.clock.nowIso();

    // 让每一个仍然存在的分区都有内容：记忆 / 事件 / 摘要 / 当前消息
    stack.memories.insert({
      id: "mem-coffee",
      scope: "user",
      type: "preference",
      content: "用户只喝深烘咖啡豆",
      contentHash: simpleHash("用户只喝深烘咖啡豆"),
      importance: 0.8,
      confidence: 0.9,
      userId: stack.userId,
      characterId: stack.characterId,
      conversationId: conversation.id,
      sourceMessageId: null,
      tags: [],
      reinforcement: 1,
      accessCount: 0,
      lastAccessedAt: null,
      embedding: null,
      supersededBy: null,
      status: "active",
      occurredAt: at,
      createdAt: at,
      updatedAt: at,
    });
    stack.eventService.create({
      userId: stack.userId,
      characterId: stack.characterId,
      type: "promise",
      title: "周末一起去书店",
      importance: 0.9,
      dueAt: new Date(Date.parse(at) + 86_400_000).toISOString(),
    });
    stack.summaries.insert({
      id: "sum-1",
      conversationId: conversation.id,
      fromMessageId: "msg-old-1",
      toMessageId: "msg-old-2",
      summary: "之前聊过咖啡豆的烘焙度。",
      tokenEstimate: 12,
      model: "scripted-model",
      providerId: "scripted",
      createdAt: at,
    });

    const incoming = insertUserMessage(stack, conversation.id, "msg-current", "我今天想喝一杯深烘咖啡");
    const built = await stack.context.build({
      conversation,
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
      source: "proactive",
      proactiveIntent: "想起对方喜欢深烘豆",
    });

    const kinds = built.bundle.sections.map((section) => section.kind);

    // 顺序表 / 优先级表声明的分区集合就是这 13 个（background 目前没有生产者）
    assert.deepEqual([...ORDERED_KINDS].sort(), Object.keys(SECTION_PRESENTATION_ORDER).sort());
    assert.deepEqual([...ORDERED_KINDS].sort(), Object.keys(SECTION_PRIORITY).sort());

    // 本次装配产出的分区：全部仍然存在的分区，减去没有生产者的 background
    assert.deepEqual(kinds, ORDERED_KINDS.filter((kind) => kind !== "background"));

    // 呈现顺序严格递增，且每个分区只出现一次
    const ranks = kinds.map((kind) => SECTION_PRESENTATION_ORDER[kind]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "分区必须按呈现顺序排列");
    assert.equal(new Set(kinds).size, kinds.length, "不允许出现重复分区");

    // 每个分区的优先级与集中声明的表一致（预算裁剪顺序因此可复现）
    for (const section of built.bundle.sections) {
      assert.equal(section.priority, SECTION_PRIORITY[section.kind], section.kind);
      assert.ok(section.text.length > 0, section.kind);
    }
    assert.deepEqual(SECTION_PRIORITY, {
      current_message: 0,
      proactive_intent: 1,
      app_instructions: 2,
      character_definition: 2,
      character_system_prompt: 3,
      recent_conversation: 3,
      runtime_state: 5,
      emotion_state: 5,
      relationship_state: 5,
      memories: 6,
      events: 7,
      conversation_summary: 8,
      background: 9,
    });

    // 内容也确实落到了对应的分区里
    assert.match(built.bundle.sections.find((s) => s.kind === "memories")?.text ?? "", /深烘/);
    assert.match(built.bundle.sections.find((s) => s.kind === "events")?.text ?? "", /书店/);
    assert.match(built.bundle.sections.find((s) => s.kind === "conversation_summary")?.text ?? "", /咖啡豆/);
    assert.equal(built.bundle.sections.at(-1)?.kind, "current_message", "当前消息永远在最后");
    assert.equal(built.bundle.sections.at(-1)?.text, incoming.textRender);
    assert.match(built.bundle.sections.find((s) => s.kind === "character_system_prompt")?.text ?? "", /最多两句话/);
    assert.equal(built.bundle.totalTokens > 0, true);
    assert.equal(built.bundle.totalTokens <= built.bundle.budgetTokens, true);

    // 被删除的第三方分区在任何一张表里都不存在
    for (const removed of REMOVED_KINDS) {
      assert.equal(removed in SECTION_PRESENTATION_ORDER, false, `${removed} 不应再是上下文分区`);
      assert.equal(removed in SECTION_PRIORITY, false, `${removed} 不应再是上下文分区`);
    }
    assert.equal((kinds as string[]).some((kind) => REMOVED_KINDS.includes(kind)), false);
  } finally {
    stack.close();
  }
});

test("会话冻结角色版本：改卡不影响旧会话的上下文，新会话才用新版本", async () => {
  const stack = createChatStack();
  try {
    installDefinition(stack, DEFINITION);
    const conversation = newConversation(stack, "web:version-binding-1");
    assert.equal(conversation.characterVersionId, "v1", "会话必须冻结创建时的角色版本");

    // 开场白只在创建会话时写一条，重复进入不重新生成
    const opened = stack.messages.listByConversation(conversation.id, { limit: 50 });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.role, "character");
    assert.equal(opened[0]?.textRender, DEFINITION.firstMessage);
    const again = newConversation(stack, "web:version-binding-1");
    assert.equal(again.id, conversation.id);
    assert.equal(stack.messages.listByConversation(conversation.id, { limit: 50 }).length, 1);

    // 改卡 = 新版本 + current_version_id 指向它
    const edited = { ...DEFINITION, name: "Aria（改名）", description: "改过的描述", firstMessage: "我换了个开场白。" };
    stack.db.raw
      .prepare("INSERT INTO character_versions (id, character_id, spec_version, definition_json, imported_from, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("v2", stack.characterId, "companion-v1", JSON.stringify(edited), "manual-edit", stack.clock.nowIso());
    stack.db.raw.prepare("UPDATE characters SET current_version_id = ? WHERE id = ?").run("v2", stack.characterId);

    // 旧会话仍然解析旧版本：文本、标题、开场白都不变
    const frozen = stack.conversations.getById(conversation.id);
    assert.equal(frozen?.characterVersionId, "v1");
    const built = await stack.context.build({ conversation: frozen!, userId: stack.userId, incomingMessage: null, taskType: "chat" });
    const definition = built.bundle.sections.find((section) => section.kind === "character_definition");
    assert.equal(definition?.text, "角色设定：温柔的咖啡师\n性格：耐心、说话很慢\n场景：小镇上的咖啡馆");
    const frozenText = built.bundle.sections.map((section) => section.text).join("\n");
    assert.equal(frozenText.includes("改过的描述"), false, "旧会话不得看到新版本");
    assert.match(built.bundle.sections.find((section) => section.kind === "app_instructions")?.text ?? "", /「Aria」/);

    // 新会话绑定新版本
    const fresh = newConversation(stack, "web:version-binding-2");
    assert.equal(fresh.characterVersionId, "v2");
    const freshBuilt = await stack.context.build({ conversation: fresh, userId: stack.userId, incomingMessage: null, taskType: "chat" });
    assert.match(freshBuilt.bundle.sections.find((section) => section.kind === "character_definition")?.text ?? "", /改过的描述/);
    assert.match(freshBuilt.bundle.sections.find((section) => section.kind === "app_instructions")?.text ?? "", /「Aria（改名）」/);
    assert.equal(
      stack.messages.listByConversation(fresh.id, { limit: 50 })[0]?.textRender,
      edited.firstMessage,
      "新会话的开场白来自新版本",
    );
  } finally {
    stack.close();
  }
});

test("删掉 character_book / message_examples / post_history_instructions 之后装配依旧完整", async () => {
  const stack = createChatStack();
  try {
    // 旧数据里可能还留着的第三方字段：读取边界安全忽略，既不崩也不注入
    installDefinition(stack, {
      ...DEFINITION,
      characterBook: { entries: [{ keys: ["便利店"], content: "SETTING-SHOULD-NOT-LEAK" }] },
      messageExamples: "<START>{{char}}: EXAMPLE-SHOULD-NOT-LEAK",
      postHistoryInstructions: "POST-HISTORY-SHOULD-NOT-LEAK",
      alternateGreetings: ["ALT-GREETING-SHOULD-NOT-LEAK"],
    });
    const conversation = newConversation(stack, "web:no-legacy-sections");
    const built = await stack.context.build({ conversation, userId: stack.userId, incomingMessage: null, taskType: "chat" });

    const kinds = built.bundle.sections.map((section) => section.kind);
    for (const kind of kinds) assert.ok(kind in SECTION_PRESENTATION_ORDER, `${kind} 不是已知分区`);
    assert.equal(kinds.includes("app_instructions"), true);
    assert.equal(kinds.includes("character_system_prompt"), true);
    assert.equal(kinds.includes("character_definition"), true);
    assert.equal(built.bundle.sections.length >= 5, true, "装配结果不能是空壳");

    const text = built.bundle.sections.map((section) => section.text).join("\n");
    for (const leak of ["SETTING-SHOULD-NOT-LEAK", "EXAMPLE-SHOULD-NOT-LEAK", "POST-HISTORY-SHOULD-NOT-LEAK", "ALT-GREETING-SHOULD-NOT-LEAK"]) {
      assert.equal(text.includes(leak), false, `${leak} 不该出现在上下文里`);
    }

    // 开场白仍然只有原生 firstMessage 一条
    const messages = stack.messages.listByConversation(conversation.id, { limit: 50 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.textRender, DEFINITION.firstMessage);
  } finally {
    stack.close();
  }
});

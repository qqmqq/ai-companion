import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStack } from "../helpers/chat-stack.ts";
import { estimateTokens } from "../../src/core/context/tokens.ts";

const AT = "2026-01-01T00:00:00.000Z";

test("token estimation is stable and CJK-aware", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("你好世界"), 4, "中文按每字 1 token");
  assert.equal(estimateTokens("abcdefgh"), 2, "拉丁按 4 字符 1 token");
  assert.ok(estimateTokens("你好abcd") > estimateTokens("你好"));
});

test("context bundles definition, recent messages, state, memories and summary with priorities", async () => {
  const stack = createChatStack({
    extractionReply: JSON.stringify([
      { scope: "user", type: "preference", content: "用户喜欢手冲咖啡", importance: 0.8, confidence: 0.9, tags: ["咖啡"] },
    ]),
  });
  try {
    // 造一轮历史 + 一条记忆 + 一条摘要
    const first = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "我平时爱喝手冲咖啡" }]);
    await stack.conversationService.reply(stack.conversationId, stack.userId, first);
    await stack.memory.extract({
      userId: stack.userId,
      characterId: stack.characterId,
      conversationId: stack.conversationId,
      userMessageId: first.id,
      assistantMessageId: null,
      userText: "我平时爱喝手冲咖啡",
      assistantText: "记住了",
      characterName: "Aria",
      userName: "你",
    });
    stack.summaries.insert({
      id: "sum1",
      conversationId: stack.conversationId,
      fromMessageId: first.id,
      toMessageId: first.id,
      summary: "用户提到自己喜欢手冲咖啡。",
      tokenEstimate: 12,
      model: "scripted-model",
      providerId: "scripted",
      createdAt: AT,
    });

    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "今天想喝点咖啡" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });

    const kinds = built.bundle.sections.map((section) => section.kind);
    assert.ok(kinds.includes("current_message"));
    assert.ok(kinds.includes("character_definition"));
    assert.ok(kinds.includes("recent_conversation"));
    assert.ok(kinds.includes("runtime_state"));
    assert.ok(kinds.includes("memories"), "相关记忆必须进入上下文");
    assert.ok(kinds.includes("conversation_summary"));

    const priorityOf = (kind: string): number => built.bundle.sections.find((s) => s.kind === kind)!.priority;
    assert.ok(priorityOf("current_message") < priorityOf("character_definition"));
    assert.ok(priorityOf("character_definition") < priorityOf("recent_conversation"));
    assert.ok(priorityOf("recent_conversation") < priorityOf("memories"));
    assert.ok(priorityOf("memories") < priorityOf("conversation_summary"));

    // 按角色合并成模型消息：system 在前、user 在后
    const chat = stack.context.toChatMessages(built.bundle);
    assert.equal(chat[0]?.role, "system");
    assert.equal(chat[chat.length - 1]?.role, "user");
    assert.match(chat[chat.length - 1]!.content, /今天想喝点咖啡/);

    // 快照必须落库，且带可追溯的 sourceIds
    assert.ok(built.snapshotId !== null);
    const snapshot = stack.snapshots.getById(built.snapshotId!);
    assert.ok(snapshot !== null);
    assert.equal(snapshot?.memoryIds.length, 1);
    assert.equal(snapshot?.model, "scripted-model");
    assert.ok((snapshot?.sections.length ?? 0) >= 5);
  } finally {
    stack.close();
  }
});

test("budget drops low priority sections first, never the current message or definition", async () => {
  const stack = createChatStack();
  try {
    for (let index = 0; index < 12; index += 1) {
      stack.conversationService.appendUserMessage(stack.conversationId, [
        { kind: "text", text: `历史消息 ${index} ${"很长的内容".repeat(20)}` },
      ]);
    }
    stack.settings.put("context.budgetTokens", 400, AT);
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "现在这条必须保留" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });

    const kinds = built.bundle.sections.map((s) => s.kind);
    assert.ok(kinds.includes("current_message"));
    assert.ok(kinds.includes("character_definition"));
    assert.ok(built.bundle.totalTokens <= built.bundle.budgetTokens + 1, "装配结果不得超过预算");
    assert.ok(built.bundle.dropped.length > 0, "超预算时必须记录被丢弃的内容");
    assert.ok(built.bundle.dropped.every((drop) => drop.reason === "over_budget" || drop.reason === "duplicate"));
  } finally {
    stack.close();
  }
});

test("duplicate content is dropped and reported as duplicate", async () => {
  const stack = createChatStack();
  try {
    const same = "今天天气真的很好适合出门散步";
    stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: same }]);
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: same }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });
    const recent = built.bundle.sections.filter((section) => section.kind === "recent_conversation");
    assert.equal(recent.length, 1, "和当前消息重复的历史不该重复注入");
    assert.equal(recent[0]?.text, same);
  } finally {
    stack.close();
  }
});

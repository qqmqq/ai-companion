import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStack } from "../helpers/chat-stack.ts";
import { planSummary } from "../../src/core/services/summary-service.ts";
import type { Message } from "../../src/core/model/message.ts";

function fakeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `m${index}`,
    conversationId: "cv",
    role: index % 2 === 0 ? "user" : "character",
    parts: [{ kind: "text", text: `消息 ${index}` }],
    textRender: `消息 ${index}`,
    replyToId: null,
    providerMessageId: null,
    tokenCount: null,
    status: "completed",
    errorText: null,
    source: "conversation",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    branchOfId: null,
  }));
}

test("summary planning respects trigger, coverage and keepRecent", () => {
  const below = planSummary({ messages: fakeMessages(5), latest: null, triggerMessages: 40, keepRecent: 10, minBatch: 10 });
  assert.equal(below.run, false);
  assert.match(below.reason, /belowTrigger/);

  const small = planSummary({ messages: fakeMessages(12), latest: null, triggerMessages: 10, keepRecent: 10, minBatch: 10 });
  assert.equal(small.run, false);
  assert.match(small.reason, /batchTooSmall/);

  const ok = planSummary({ messages: fakeMessages(30), latest: null, triggerMessages: 10, keepRecent: 10, minBatch: 10 });
  assert.equal(ok.run, true);
  assert.equal(ok.candidates.length, 20, "最近 10 条必须留给原文");

  const covered = planSummary({
    messages: fakeMessages(30),
    latest: {
      id: "s1",
      conversationId: "cv",
      fromMessageId: "m0",
      toMessageId: "m19",
      summary: "已有摘要",
      tokenEstimate: 10,
      model: "m",
      providerId: "p",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    triggerMessages: 10,
    keepRecent: 5,
    minBatch: 1,
  });
  assert.equal(covered.run, true);
  assert.deepEqual(
    covered.candidates.map((m) => m.id),
    ["m20", "m21", "m22", "m23", "m24"],
    "只压缩尚未被摘要覆盖的部分",
  );
});

test("summarization stores a summary, keeps originals, and later enters the context", async () => {
  const stack = createChatStack({ summaryReply: "用户与 Aria 聊了咖啡与日常。", chatReply: "嗯" });
  try {
    for (let index = 0; index < 14; index += 1) {
      const user = stack.conversationService.appendUserMessage(stack.conversationId, [
        { kind: "text", text: `第 ${index} 条消息：今天聊点日常` },
      ]);
      await stack.conversationService.reply(stack.conversationId, stack.userId, user);
    }
    stack.settings.put("summary.triggerMessages", 10, "2026-01-01T00:00:00.000Z");
    stack.settings.put("summary.keepRecent", 4, "2026-01-01T00:00:00.000Z");
    stack.settings.put("summary.minBatch", 4, "2026-01-01T00:00:00.000Z");

    const beforeCount = stack.messages.listByConversation(stack.conversationId).length;
    const summary = await stack.summaryService.summarize(stack.conversationId);
    assert.ok(summary !== null);
    assert.equal(summary?.summary, "用户与 Aria 聊了咖啡与日常。");
    assert.equal(stack.messages.listByConversation(stack.conversationId).length, beforeCount, "原始消息绝不能删除");

    const user = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "继续聊" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: user,
      taskType: "chat",
    });
    assert.ok(built.bundle.sections.some((section) => section.kind === "conversation_summary"));
    assert.equal(stack.summaries.count(stack.conversationId), 1);

    // 压缩任务必须走 summarization 路由（而不是 chat 模型）
    const summaryRequests = stack.requests.filter((request) => (request.messages[0]?.content ?? "").includes("对话压缩器"));
    assert.equal(summaryRequests.length, 1);
    assert.ok(stack.usage.listRecent(50).some((record) => record.taskType === "summarization"));
  } finally {
    stack.close();
  }
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStack } from "../helpers/chat-stack.ts";

test("streaming reply persists exactly one assistant message", async () => {
  const stack = createChatStack({ chatReply: "这是被分块输出的回复内容，一共要分成很多块。", chunkSize: 4 });
  try {
    const user = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "你好" }]);
    const deltas: string[] = [];
    const message = await stack.conversationService.streamReply(stack.conversationId, stack.userId, user, {
      onDelta: (chunk) => deltas.push(chunk),
    });

    assert.ok(deltas.length > 5, "应当收到多个增量");
    assert.equal(message.textRender, "这是被分块输出的回复内容，一共要分成很多块。");
    assert.equal(message.status, "completed");

    const all = stack.messages.listByConversation(stack.conversationId);
    const assistant = all.filter((m) => m.role === "character");
    assert.equal(assistant.length, 1, "几十个 chunk 只能对应一条消息");
    assert.equal(all.length, 2, "用户消息 + 助手消息");
  } finally {
    stack.close();
  }
});

test("a mid-stream failure keeps the partial text and marks the message failed", async () => {
  const stack = createChatStack({ chatReply: "前半段会被保存下来，后半段会失败。", chunkSize: 3, failAfterChunks: 3 });
  try {
    const user = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "讲个长故事" }]);
    await assert.rejects(() => stack.conversationService.streamReply(stack.conversationId, stack.userId, user), /上游断开/);

    const assistant = stack.messages.listByConversation(stack.conversationId).filter((m) => m.role === "character");
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.status, "failed");
    assert.ok((assistant[0]?.textRender.length ?? 0) > 0, "已生成的部分必须保留，不能丢");
    assert.match(assistant[0]?.errorText ?? "", /上游断开/);
    assert.ok((assistant[0]?.textRender.length ?? 0) < "前半段会被保存下来，后半段会失败。".length);
  } finally {
    stack.close();
  }
});

test("an aborted stream marks the message failed instead of leaving it partial", async () => {
  const stack = createChatStack({ chatReply: "会被取消的回复。", chunkSize: 2 });
  try {
    const user = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "在吗" }]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() =>
      stack.conversationService.streamReply(stack.conversationId, stack.userId, user, { signal: controller.signal }),
    );
    const assistant = stack.messages.listByConversation(stack.conversationId).filter((m) => m.role === "character");
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.status, "failed");
    assert.equal(assistant[0]?.textRender, "");
  } finally {
    stack.close();
  }
});

test("user message is persisted before the model call and a snapshot exists afterwards", async () => {
  const stack = createChatStack({ chatReply: "好" });
  try {
    const user = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "记住我喜欢深烘豆" }]);
    const storedBeforeCall = stack.messages.getById(user.id);
    assert.ok(storedBeforeCall !== null, "用户消息必须先落库");

    await stack.conversationService.reply(stack.conversationId, stack.userId, user);
    const all = stack.messages.listByConversation(stack.conversationId);
    assert.deepEqual(
      all.map((m) => m.role),
      ["user", "character"],
    );
    assert.ok(stack.snapshots.listByConversation(stack.conversationId, 5).length >= 1, "每次真实调用前都要有上下文快照");

    const chatRequests = stack.requests.filter((request) => (request.messages[0]?.content ?? "").includes("你是「"));
    assert.equal(chatRequests.length, 1);
    assert.ok(stack.usage.listRecent(10).some((record) => record.taskType === "chat"));
  } finally {
    stack.close();
  }
});

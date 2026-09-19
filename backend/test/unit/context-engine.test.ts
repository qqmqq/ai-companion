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
test("角色有时间概念：上下文里给出「现在」与「上次说话是多久以前」，记忆带现实时间戳", async () => {
  const stack = createChatStack({
    startIso: "2026-03-01T09:00:00.000Z",
    extractionReply: JSON.stringify([
      { scope: "user", type: "preference", content: "用户喜欢手冲咖啡", importance: 0.8, confidence: 0.9, tags: ["咖啡"] },
    ]),
  });
  try {
    // 固定时区，断言就与跑测试的机器无关（CI 在 UTC，本机可能在 UTC+8）
    stack.settings.put("context.timeZone", "Asia/Shanghai", stack.clock.nowIso());

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

    // 三天后再开口
    stack.clock.advance(3 * 24 * 60 * 60 * 1000);
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "今天想喝点咖啡" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });

    const time = built.bundle.sections.find((section) => section.kind === "time_context");
    assert.ok(time !== undefined, "必须有现实时间这一段");
    assert.match(time.text, /现在是 2026年3月4日 周三/, "要说清现在是什么时候：" + time.text);
    assert.match(time.text, /你们上一次说话是 2026-03-01 17:00（3 天前）/, "要说清隔了多久：" + time.text);
    assert.match(time.text, /不要念出具体日期数字/, "要给措辞边界，而不是替角色写台词");

    // 时间基准必须排在人设之前、当前消息之前
    const kinds = built.bundle.sections.map((section) => section.kind);
    assert.ok(kinds.indexOf("time_context") < kinds.indexOf("character_definition"));
    assert.equal(kinds.at(-1), "current_message");

    // 记忆带时间戳：方括号里是它发生的时间与距今多久
    const memories = built.bundle.sections.find((section) => section.kind === "memories");
    assert.ok(memories !== undefined);
    assert.match(memories.text, /- \[2026-03-01 17:00・3 天前\] 用户喜欢手冲咖啡/, memories.text);
    assert.match(memories.text, /很久以前的事别当成刚刚发生/);
  } finally {
    stack.close();
  }
});

test("第一次说话时不说「上次聊过」，直接说这是你们第一次", async () => {
  const stack = createChatStack({ startIso: "2026-03-01T09:00:00.000Z" });
  try {
    stack.settings.put("context.timeZone", "Asia/Shanghai", stack.clock.nowIso());
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "在吗" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });
    const time = built.bundle.sections.find((section) => section.kind === "time_context");
    assert.ok(time !== undefined);
    assert.match(time.text, /这是你们第一次说话/);
    assert.equal(time.text.includes("上一次说话"), false, "第一次没有「上一次」可说");
  } finally {
    stack.close();
  }
});
test("隔了很久（几小时）时：提示词要求「重新开口」，并在当前消息前再钉一句间隔提醒", async () => {
  const stack = createChatStack({ startIso: "2026-03-01T09:00:00.000Z" });
  try {
    stack.settings.put("context.timeZone", "Asia/Shanghai", stack.clock.nowIso());
    const first = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "我们刚才在聊飞船的事" }]);
    await stack.conversationService.reply(stack.conversationId, stack.userId, first);

    // 六小时后再开口
    stack.clock.advance(6 * 60 * 60 * 1000);
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "在吗" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });

    const time = built.bundle.sections.find((section) => section.kind === "time_context");
    assert.ok(time !== undefined);
    assert.match(time.text, /隔了几个小时/, time.text);
    assert.match(time.text, /隔了很久之后重新开口/);
    assert.match(time.text, /不要.{0,4}接着几个小时前的话题往下讲/, "要说清「别接着旧话题」");

    // 紧贴当前消息的位置必须有一条间隔提醒
    const gap = built.bundle.sections.find((section) => section.kind === "time_gap");
    assert.ok(gap !== undefined, "隔了这么久，必须在新消息前提醒一次");
    assert.match(gap.text, /上一句对话是 /);
    assert.match(gap.text, /隔了几个小时/);
    const kinds = built.bundle.sections.map((section) => section.kind);
    assert.ok(kinds.indexOf("time_gap") > kinds.indexOf("recent_conversation"), "提醒要排在历史之后");
    assert.equal(kinds.at(-1), "current_message", "提醒紧贴当前消息");
  } finally {
    stack.close();
  }
});

test("刚聊完（几分钟）时：不说「好久不见」，也不插间隔提醒", async () => {
  const stack = createChatStack({ startIso: "2026-03-01T09:00:00.000Z" });
  try {
    stack.settings.put("context.timeZone", "Asia/Shanghai", stack.clock.nowIso());
    const first = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "在吗" }]);
    await stack.conversationService.reply(stack.conversationId, stack.userId, first);
    stack.clock.advance(2 * 60 * 1000);
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "继续说" }]);
    const built = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });
    const time = built.bundle.sections.find((section) => section.kind === "time_context");
    assert.match(time?.text ?? "", /接着刚才聊/);
    assert.equal(built.bundle.sections.some((section) => section.kind === "time_gap"), false);
  } finally {
    stack.close();
  }
});

test("对话提示词补充：填了就以「用户自定义要求」进系统约束，留空就不出现", async () => {
  const stack = createChatStack({ startIso: "2026-03-01T09:00:00.000Z" });
  try {
    const incoming = stack.conversationService.appendUserMessage(stack.conversationId, [{ kind: "text", text: "你好" }]);
    const before = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });
    const beforeText = before.bundle.sections.find((section) => section.kind === "app_instructions")?.text ?? "";
    assert.equal(beforeText.includes("用户自定义要求"), false, "没填就不该出现这一段");

    stack.settings.put("prompt.custom", "说话短一点，别用感叹号。", stack.clock.nowIso());
    const after = await stack.context.build({
      conversation: stack.conversationService.get(stack.conversationId),
      userId: stack.userId,
      incomingMessage: incoming,
      taskType: "chat",
    });
    const afterText = after.bundle.sections.find((section) => section.kind === "app_instructions")?.text ?? "";
    assert.match(afterText, /用户自定义要求/);
    assert.match(afterText, /说话短一点，别用感叹号。/);
    assert.match(afterText, /不得违反上面的约束/, "自定义要求不能盖过基础约束");
  } finally {
    stack.close();
  }
});

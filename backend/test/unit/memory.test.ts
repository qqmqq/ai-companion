import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStack } from "../helpers/memory-stack.ts";
import { parseCandidates, looksWorthExtracting, extractJsonArray } from "../../src/core/memory/extractor.ts";
import { heuristicImportance, normalizeFtsRank, scoreMemory } from "../../src/core/memory/scoring.ts";
import { simpleHash } from "../../src/core/memory/memory-service.ts";
import type { Memory } from "../../src/core/model/memory.ts";

const AT = "2026-03-01T00:00:00.000Z";

function memoryOf(overrides: Partial<Memory>): Memory {
  return {
    id: "m",
    scope: "user",
    type: "fact",
    content: "c",
    contentHash: "h",
    importance: 0.5,
    confidence: 0.5,
    userId: "u1",
    characterId: "c1",
    conversationId: "cv1",
    sourceMessageId: null,
    tags: [],
    reinforcement: 1,
    accessCount: 0,
    lastAccessedAt: null,
    embedding: null,
    supersededBy: null,
    status: "active",
    occurredAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

test("extractor parses fenced JSON and rejects malformed entries", () => {
  const raw = `好的，这是结果：
\`\`\`json
[
  {"scope":"user","type":"preference","content":"用户喜欢手冲咖啡","importance":0.7,"confidence":0.9,"tags":["咖啡"]},
  {"scope":"nope","type":"fact","content":"坏作用域"},
  {"scope":"user","type":"fact","content":""},
  {"scope":"event","type":"event","content":"用户在 3 月 14 日过生日","tags":["生日"]}
]
\`\`\``;
  const result = parseCandidates(raw, AT);
  assert.equal(result.parseFailed, false);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.rejected, 2);
  assert.equal(result.candidates[0]?.content, "用户喜欢手冲咖啡");
  assert.equal(result.candidates[1]?.importance, heuristicImportance("用户在 3 月 14 日过生日", "event"));
});

test("extractor tolerates garbage output", () => {
  assert.equal(parseCandidates("抱歉我做不到", AT).parseFailed, true);
  assert.equal(extractJsonArray("[]")?.length, 0);
});

test("prefilter skips chitchat without calling the model", () => {
  assert.equal(looksWorthExtracting("嗯嗯", 6), false);
  assert.equal(looksWorthExtracting("晚安", 6), false);
  assert.equal(looksWorthExtracting("你好", 6), false, "短于 minChars 的内容不值得抽取");
  assert.equal(looksWorthExtracting("你好", 2), true, "降低阈值后短句可以通过长度闸门");
  assert.equal(looksWorthExtracting("我下周三要去看牙医", 6), true);
});

test("extraction gate honours switches, everyN and prefilter", () => {
  const stack = createMemoryStack(["[]"]);
  try {
    assert.equal(stack.service.gate({ conversationId: "cv", userText: "我下周三要去看牙医", userMessageCount: 2, lastUserMessageAt: null }).run, true);
    assert.equal(stack.service.gate({ conversationId: "cv", userText: "我下周三要去看牙医", userMessageCount: 3, lastUserMessageAt: null }).reason, "everyN:2");
    assert.equal(stack.service.gate({ conversationId: "cv", userText: "嗯嗯", userMessageCount: 2, lastUserMessageAt: null }).reason, "prefilter");
    stack.settings.put("memory.extraction.enabled", false, AT);
    assert.equal(stack.service.gate({ conversationId: "cv", userText: "我下周三要去看牙医", userMessageCount: 2, lastUserMessageAt: null }).reason, "disabled");
  } finally {
    stack.close();
  }
});

test("extraction stores memories, links them to their source, and records usage", async () => {
  const stack = createMemoryStack([
    '[{"scope":"user","type":"preference","content":"用户喜欢手冲咖啡","importance":0.8,"confidence":0.9,"tags":["咖啡"]},' +
      '{"scope":"event","type":"promise","content":"用户答应周末一起去书店","importance":0.95,"confidence":0.8,"tags":[]}]',
  ]);
  try {
    const stored = await stack.service.extract({
      userId: "u1",
      characterId: "c1",
      conversationId: "cv1",
      userMessageId: "msg1",
      assistantMessageId: "msg2",
      userText: "我很喜欢手冲咖啡，周末一起去书店吧",
      assistantText: "好呀，说定了",
      characterName: "Aria",
      userName: "你",
    });
    assert.equal(stored.length, 2);
    assert.equal(stack.memories.list({ limit: 10 }).length, 2);

    const links = stack.memories.listLinks(stored[0]!.id);
    assert.ok(links.some((l) => l.targetType === "message" && l.targetId === "msg1"), "必须能追溯到来源消息");
    assert.ok(links.some((l) => l.targetType === "character" && l.targetId === "c1"));

    const usage = stack.usage.listRecent(10);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.taskType, "memory_extraction");
    assert.equal(usage[0]?.inputTokens, 100);
    assert.ok(Math.abs((usage[0]?.estimatedCost ?? 0) - 0.00014) < 1e-9, "成本按 provider 能力估算");
  } finally {
    stack.close();
  }
});

test("repeated facts merge (reinforcement) instead of duplicating", async () => {
  const payload = '[{"scope":"user","type":"preference","content":"用户喜欢手冲咖啡","importance":0.6,"confidence":0.6,"tags":[]}]';
  const stack = createMemoryStack([payload, payload]);
  try {
    const input = {
      userId: "u1",
      characterId: "c1",
      conversationId: "cv1",
      userMessageId: "msg1",
      assistantMessageId: null,
      userText: "今天又喝手冲咖啡了",
      assistantText: "嗯",
      characterName: "Aria",
      userName: "你",
    };
    const first = await stack.service.extract(input);
    const second = await stack.service.extract({ ...input, userMessageId: "msg3" });
    assert.equal(stack.memories.list({ limit: 10 }).length, 1, "同内容必须合并");
    assert.equal(first[0]?.id, second[0]?.id);
    assert.ok((second[0]?.reinforcement ?? 0) > 1);
    assert.equal(second[0]?.sourceMessageId, "msg3", "来源消息更新为最近一次提及");
  } finally {
    stack.close();
  }
});

test("unparseable extraction output is a no-op, not a crash", async () => {
  const stack = createMemoryStack(["对不起，我不会返回 JSON"]);
  try {
    const stored = await stack.service.extract({
      userId: "u1",
      characterId: "c1",
      conversationId: "cv1",
      userMessageId: "msg1",
      assistantMessageId: null,
      userText: "记住我喜欢深烘豆",
      assistantText: "好",
      characterName: "Aria",
      userName: "你",
    });
    assert.deepEqual(stored, []);
    assert.equal(stack.memories.list({ limit: 5 }).length, 0);
  } finally {
    stack.close();
  }
});

test("retrieval finds relevant memories and always includes protected ones", async () => {
  const stack = createMemoryStack([
    JSON.stringify([
      { scope: "user", type: "preference", content: "用户喜欢手冲咖啡", importance: 0.7, confidence: 0.9, tags: ["咖啡"] },
      { scope: "user", type: "identity", content: "用户的生日是 3 月 14 日", importance: 0.95, confidence: 0.9, tags: ["生日"] },
      { scope: "world", type: "fact", content: "这个世界使用蒸汽技术", importance: 0.4, confidence: 0.5, tags: [] },
    ]),
  ]);
  try {
    await stack.service.extract({
      userId: "u1",
      characterId: "c1",
      conversationId: "cv1",
      userMessageId: "msg1",
      assistantMessageId: null,
      userText: "我喜欢手冲咖啡，生日是 3 月 14 日",
      assistantText: "记住了",
      characterName: "Aria",
      userName: "你",
    });

    const hits = await stack.service.retrieve({ text: "咖啡", userId: "u1", characterId: "c1", limit: 5, scopes: ["user", "world"] });
    const ids = hits.map((h) => h.memory.id);
    assert.ok(hits.length >= 2);
    assert.equal(hits[0]?.memory.content, "用户喜欢手冲咖啡", "关键词命中应排在最前");
    assert.ok(
      hits.some((h) => h.memory.type === "identity"),
      "identity 属于保护类记忆，必须始终进入候选",
    );
    assert.ok(ids.length === new Set(ids).size, "不允许重复");

    const after = stack.memories.getById(hits[0]!.memory.id)!;
    assert.equal(after.accessCount, 1, "被检索命中要记录访问");
    assert.ok(after.lastAccessedAt !== null);
  } finally {
    stack.close();
  }
});

test("scoring rewards importance and freshness; protected types never decay", () => {
  const nowMs = Date.parse(AT) + 30 * 86_400_000;
  const fresh = scoreMemory({ memory: memoryOf({ importance: 0.9, occurredAt: AT }), ftsRank: 1, nowMs });
  const stale = scoreMemory({ memory: memoryOf({ importance: 0.2, occurredAt: "2025-01-01T00:00:00.000Z" }), ftsRank: 1, nowMs });
  assert.ok(fresh.score > stale.score);
  const identity = scoreMemory({ memory: memoryOf({ type: "identity", occurredAt: "2020-01-01T00:00:00.000Z" }), ftsRank: 1, nowMs });
  assert.equal(identity.components.recency, 1, "identity 不随时间衰减");

  // 关键词名次必须能真正影响排序（小语料下 bm25 数值会被抹平，所以按名次折算）
  const best = scoreMemory({ memory: memoryOf({ importance: 0.5 }), ftsRank: normalizeFtsRank(0, 5), nowMs });
  const worst = scoreMemory({ memory: memoryOf({ importance: 0.5 }), ftsRank: normalizeFtsRank(4, 5), nowMs });
  assert.ok(best.components.fts > worst.components.fts);
  assert.equal(best.components.fts, 1);
  assert.equal(worst.components.fts, 0);
  assert.ok(best.score > worst.score);
});

test("decay archives low-value old memories but keeps promises", () => {
  const realNow = Date.now();
  const longAgo = new Date(realNow - 400 * 86_400_000).toISOString();
  const stack = createMemoryStack(["[]"], () => realNow);
  try {
    stack.memories.insert(
      memoryOf({ id: "old-chat", content: "用户某天说天气不错", importance: 0.2, occurredAt: longAgo, contentHash: simpleHash("用户某天说天气不错") }),
    );
    stack.memories.insert(
      memoryOf({ id: "promise", type: "promise", content: "用户答应周末去书店", importance: 0.4, occurredAt: longAgo, contentHash: simpleHash("用户答应周末去书店") }),
    );
    const result = stack.service.decay();
    assert.equal(result.archived, 1);
    assert.equal(stack.memories.getById("old-chat")?.status, "archived");
    assert.equal(stack.memories.getById("promise")?.status, "active", "承诺类记忆永不自动遗忘");
  } finally {
    stack.close();
  }
});

test("delete removes the memory and its links", async () => {
  const stack = createMemoryStack([
    '[{"scope":"user","type":"fact","content":"用户养了一只叫豆豆的猫","importance":0.7,"confidence":0.8,"tags":["猫"]}]',
  ]);
  try {
    const stored = await stack.service.extract({
      userId: "u1",
      characterId: "c1",
      conversationId: "cv1",
      userMessageId: "msg1",
      assistantMessageId: null,
      userText: "我养了一只叫豆豆的猫",
      assistantText: "豆豆真可爱",
      characterName: "Aria",
      userName: "你",
    });
    const id = stored[0]!.id;
    stack.service.delete(id);
    assert.equal(stack.memories.getById(id), null);
    assert.deepEqual(stack.memories.listLinks(id), []);
  } finally {
    stack.close();
  }
});

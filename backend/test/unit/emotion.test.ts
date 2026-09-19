import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../helpers/db.ts";
import { seedFixtures } from "../helpers/memory-stack.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createEmotionRepository } from "../../src/storage/repositories/emotions.ts";
import { createCharacterRepository } from "../../src/storage/repositories/characters.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createCharacterStateService } from "../../src/core/services/character-state-service.ts";
import {
  createEmotionService,
  detectDeterministicEmotion,
  parseEmotionAnalysis,
} from "../../src/core/services/emotion-service.ts";
import { createLogger } from "../../src/app/logger.ts";
import type { ChatRequest, ChatResponse, LLMProvider, ChatDelta } from "../../src/core/ports/llm-provider.ts";
import { createTaskLLM } from "../../src/providers/task-llm.ts";
import { createModelUsageRepository } from "../../src/storage/repositories/model-usage.ts";
import type { LLMProviderRegistry } from "../../src/providers/llm/registry.ts";
import type { TaskType } from "../../src/core/model/task.ts";

const logger = createLogger({ level: "error", sink: () => {} });

function stack(modelReplies: string[] = []) {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const characters = createCharacterRepository(db);
  const clock = createFakeClock();
  const characterState = createCharacterStateService({ characters, clock, logger });
  const settings = createSettingsRepository(db);
  const requests: ChatRequest[] = [];
  let index = 0;
  const provider: LLMProvider = {
    id: "fake",
    kind: "fake",
    async listModels() {
      return [];
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      const text = modelReplies[Math.min(index, modelReplies.length - 1)] ?? "{}";
      index += 1;
      return { text, model: request.model, usage: { promptTokens: 10, completionTokens: 5 }, finishReason: "stop" };
    },
    async *stream(): AsyncIterable<ChatDelta> {
      yield { text: "", done: true };
    },
  };
  const registry: LLMProviderRegistry = {
    get: () => provider,
    list: () => [provider],
    modelInfo: () => null,
    refreshModelInfo: async () => [],
  };
  const taskLLM = createTaskLLM({
    router: {
      resolve: (task: TaskType) => ({ taskType: task, providerId: "fake", model: "fake-model" }),
      resolveOrNull: (task: TaskType) => ({ taskType: task, providerId: "fake", model: "fake-model" }),
      listRoutes: () => [],
    },
    providers: registry,
    usage: createModelUsageRepository(db),
    logger,
    now: () => clock.now().getTime(),
  });
  const emotion = createEmotionService({
    emotions: createEmotionRepository(db),
    characterState,
    taskLLM,
    settings,
    events: { publish: () => {} },
    logger,
    clock,
  });
  return { db, emotion, characterState, settings, clock, requests, close: () => db.close() };
}

test("deterministic signals classify emotion without any model call", () => {
  assert.equal(detectDeterministicEmotion("今天好开心啊")?.primary, "happy");
  assert.equal(detectDeterministicEmotion("谢谢你一直陪我")?.primary, "grateful");
  assert.equal(detectDeterministicEmotion("我好难过")?.primary, "sad");
  assert.equal(detectDeterministicEmotion("最近好累")?.primary, "tired");
  assert.equal(detectDeterministicEmotion("今天几号？"), null, "平淡消息不该产生情绪波动");
});

test("emotion changes are clamped, journalled with cause, and visible in runtime state", () => {
  const s = stack();
  try {
    const first = s.emotion.applyChange("c1", {
      primary: "happy",
      intensity: 5,
      valence: 9,
      arousal: -3,
      reason: "用户夸了角色",
      source: "deterministic",
    });
    assert.equal(first.state.intensity, 1, "强度硬限幅到 1");
    assert.equal(first.state.valence, 1);
    assert.equal(first.state.arousal, 0);
    assert.equal(first.entry.before?.primary, "neutral");
    assert.equal(first.entry.after.primary, "happy");
    assert.equal(first.entry.reason, "用户夸了角色");

    const history = s.emotion.history("c1", 10);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.after.primary, "happy");

    const state = s.characterState.get("c1");
    assert.equal(state.emotion.primary, "happy");
    assert.equal(state.mood, "愉快");
    assert.equal(state.emotionState?.primary, "happy");
  } finally {
    s.close();
  }
});

test("emotion state survives round-trips and stays within bounds", () => {
  const s = stack();
  try {
    s.emotion.applyChange("c1", { primary: "angry", intensity: 0.35, reason: "被冒犯", source: "deterministic" });
    // 关键回归：完整情绪状态必须真的持久化，而不是每次读都回落到基线
    const reloaded = s.emotion.get("c1");
    assert.equal(reloaded.primary, "angry");
    assert.ok(Math.abs(reloaded.intensity - 0.35) < 1e-6, "强度必须被记住");

    const extreme = s.emotion.applyChange("c1", { primary: "happy", intensity: 99, valence: -99, arousal: 99, reason: "极端值", source: "deterministic" });
    assert.equal(extreme.state.intensity, 1);
    assert.equal(extreme.state.valence, -1);
    assert.equal(extreme.state.arousal, 1);
  } finally {
    s.close();
  }
});

test("emotion decays toward baseline as time passes (FakeClock)", () => {
  const s = stack();
  try {
    s.emotion.applyChange("c1", { primary: "excited", intensity: 0.9, valence: 0.9, arousal: 0.9, reason: "很兴奋", source: "deterministic" });
    const peak = s.emotion.get("c1");
    assert.ok(peak.intensity > 0.8);

    s.clock.advance(4 * 60 * 60 * 1000); // 半衰期 1 小时 → 衰减到 1/16 左右
    const settled = s.emotion.get("c1");
    assert.ok(settled.intensity < peak.intensity * 0.2, "情绪必须随时间回落");
    assert.equal(settled.primary, "neutral", "强度足够低时回到中性");
  } finally {
    s.close();
  }
});

test("model-based analysis only runs when explicitly enabled and unparseable output is ignored", async () => {
  const s = stack(['{"primary":"lonely","intensity":0.6,"valence":-0.5,"arousal":0.3,"reason":"用户说一个人吃饭"}']);
  try {
    // 这句话不含任何确定性情绪关键词，因此只有开启模型分析才会有结果
    const text = "这周的安排有点乱，我还在想怎么调整";
    assert.equal(detectDeterministicEmotion(text), null);
    const disabled = await s.emotion.analyze("c1", { text });
    assert.equal(disabled.usedModel, false);
    assert.equal(disabled.change, null);
    assert.equal(s.requests.length, 0, "默认不调用模型");

    s.settings.put("emotion.analysis.enabled", true, s.clock.nowIso());
    s.settings.put("emotion.analysis.minChars", 5, s.clock.nowIso());
    const enabled = await s.emotion.analyze("c1", { text });
    assert.equal(enabled.usedModel, true);
    assert.equal(enabled.change?.primary, "lonely");
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]?.messages[0]?.content.includes("情绪分析器"), true);

    // 长度闸门：太短的消息不值得花钱分析
    s.settings.put("emotion.analysis.minChars", 1000, s.clock.nowIso());
    const gated = await s.emotion.analyze("c1", { text });
    assert.equal(gated.usedModel, false);
    assert.equal(s.requests.length, 1, "被闸门挡住时不应多调用一次模型");

    const parsed = parseEmotionAnalysis("抱歉，我做不到");
    assert.equal(parsed, null, "无法解析的输出必须被忽略，而不是当成 neutral");
  } finally {
    s.close();
  }
});
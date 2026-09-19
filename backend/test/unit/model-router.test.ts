import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TASK_TIER, createModelRouter } from "../../src/providers/model-router.ts";
import type { ModelConfigStore } from "../../src/core/ports/model-config.ts";
import type { ModelRoute, ProviderConfig } from "../../src/core/model/usage.ts";
import type { TaskType } from "../../src/core/model/task.ts";
import type { LLMProvider } from "../../src/core/ports/llm-provider.ts";
import { createLogger } from "../../src/app/logger.ts";

const logger = createLogger({ level: "error", sink: () => {} });

function providerConfig(id: string, model: string, enabled = true): ProviderConfig {
  return {
    id,
    kind: "openai-compatible",
    displayName: id,
    baseUrl: "http://localhost",
    defaultModel: model,
    credentialRef: null,
    requiresCredential: false,
    timeoutMs: 1000,
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function stubProvider(id: string): LLMProvider {
  return {
    id,
    kind: "stub",
    listModels: async () => [],
    chat: async () => ({ text: "", model: "m", usage: { promptTokens: null, completionTokens: null }, finishReason: "stop" }),
    stream: async function* () {},
  };
}

function store(configs: ProviderConfig[], routes: ModelRoute[] = []): ModelConfigStore {
  return {
    listProviders: () => configs,
    getProvider: (id) => configs.find((c) => c.id === id) ?? null,
    getRoute: (task: TaskType) => routes.find((r) => r.taskType === task) ?? null,
    listRoutes: () => routes,
  };
}

test("explicit routes win and map each task to its configured model", () => {
  const router = createModelRouter({
    config: store(
      [providerConfig("cheap-provider", "small-model"), providerConfig("strong-provider", "big-model")],
      [
        { taskType: "chat", providerId: "strong-provider", model: "big-model", updatedAt: "x" },
        { taskType: "memory_extraction", providerId: "cheap-provider", model: "small-model", updatedAt: "x" },
        { taskType: "summarization", providerId: "cheap-provider", model: "small-model", updatedAt: "x" },
      ],
    ),
    providers: new Map([
      ["cheap-provider", stubProvider("cheap-provider")],
      ["strong-provider", stubProvider("strong-provider")],
    ]),
    logger,
  });

  assert.deepEqual(router.resolve("chat"), { taskType: "chat", providerId: "strong-provider", model: "big-model" });
  assert.equal(router.resolve("memory_extraction").model, "small-model");
  assert.equal(router.resolve("summarization").model, "small-model");
});

test("without routes, tasks fall back to their default tier", () => {
  const router = createModelRouter({
    config: store([providerConfig("main", "standard-model")]),
    providers: new Map([["main", stubProvider("main")]]),
    logger,
  });
  assert.equal(router.resolve("chat").providerId, "main");
  assert.equal(DEFAULT_TASK_TIER.memory_extraction, "cheap");
  assert.equal(router.resolve("memory_extraction").model, "standard-model", "只有单一 provider 时回退到它");
});

test("routes pointing to disabled or unknown providers degrade safely", () => {
  const router = createModelRouter({
    config: store(
      [providerConfig("a", "model-a"), providerConfig("b", "model-b", false)],
      [{ taskType: "chat", providerId: "b", model: "model-b", updatedAt: "x" }],
    ),
    providers: new Map([
      ["a", stubProvider("a")],
      ["b", stubProvider("b")],
    ]),
    logger,
  });
  const binding = router.resolve("chat");
  assert.equal(binding.providerId, "a", "禁用的 provider 不能被路由到");
  // 关键回归：兜底选到别的 provider 时，**不能**把那条路由的模型名带过去
  // （真实事故：chat 曾路由到 echo/echo-1，echo 被删后把 "echo-1" 发给了真实 API）
  assert.equal(binding.model, "model-a", "模型必须来自被选中的 provider，而不是别的 provider 的陈旧路由");
});

test("a stale route cannot hijack the model of the provider that actually serves the task", () => {
  // provider "echo" 已经不存在（被删除），但路由还指着它：这是真实事故的现场
  const router = createModelRouter({
    config: store(
      [providerConfig("real", "deepseek-V4-flash")],
      [{ taskType: "chat", providerId: "echo", model: "echo-1", updatedAt: "x" }],
    ),
    providers: new Map([["real", stubProvider("real")]]),
    logger,
  });
  const binding = router.resolve("chat");
  assert.equal(binding.providerId, "real");
  assert.equal(binding.model, "deepseek-V4-flash", "用户配置的模型不能被悬空路由覆盖");
});

test("a route that points at the picked provider keeps its explicit model", () => {
  const router = createModelRouter({
    config: store(
      [providerConfig("real", "default-model")],
      [{ taskType: "chat", providerId: "real", model: "chosen-by-user", updatedAt: "x" }],
    ),
    providers: new Map([["real", stubProvider("real")]]),
    logger,
  });
  assert.equal(router.resolve("chat").model, "chosen-by-user");
});

test("a route without a providerId applies its model to whatever provider is picked", () => {
  const router = createModelRouter({
    config: store(
      [providerConfig("real", "default-model")],
      [{ taskType: "chat", providerId: null, model: "chosen-by-user", updatedAt: "x" }],
    ),
    providers: new Map([["real", stubProvider("real")]]),
    logger,
  });
  assert.deepEqual(router.resolve("chat"), { taskType: "chat", providerId: "real", model: "chosen-by-user" });
});

test("a real provider beats the built-in echo placeholder in the same tier", () => {
  const echo: ProviderConfig = { ...providerConfig("echo", "echo-1"), kind: "echo" };
  const router = createModelRouter({
    config: store([echo, providerConfig("real", "deepseek-V4-flash")]),
    providers: new Map([
      ["echo", stubProvider("echo")],
      ["real", stubProvider("real")],
    ]),
    logger,
  });
  const binding = router.resolve("chat");
  assert.equal(binding.providerId, "real", "用户配置好的 Provider 不应该被内置占位模型顶掉");
  assert.equal(binding.model, "deepseek-V4-flash");
});

test("tier preferences override the default pick", () => {
  const router = createModelRouter({
    config: store([providerConfig("x", "m-x"), providerConfig("y", "m-y")]),
    providers: new Map([
      ["x", stubProvider("x")],
      ["y", stubProvider("y")],
    ]),
    logger,
    tierPreferences: { cheap: ["y"], standard: ["x"] },
  });
  assert.equal(router.resolve("memory_extraction").providerId, "y");
  assert.equal(router.resolve("chat").providerId, "x");
});

test("一个能用的模型都没有：resolve 抛错（说人话），resolveOrNull 返回 null（给列表用，不把页面打崩）", () => {
  const router = createModelRouter({
    config: store([providerConfig("a", "m", false)]),
    providers: new Map([["a", stubProvider("a")]]),
    logger,
  });
  assert.throws(() => router.resolve("chat"), /还没有可用的模型/);
  assert.equal(router.resolveOrNull("chat"), null);
  // listRoutes 也不许因为"啥都没配"就炸
  assert.deepEqual(router.listRoutes(), []);
});

test("有可用 provider 时 resolveOrNull 与 resolve 给的是同一个绑定", () => {
  const router = createModelRouter({
    config: store([providerConfig("a", "m", true)]),
    providers: new Map([["a", stubProvider("a")]]),
    logger,
  });
  assert.deepEqual(router.resolveOrNull("chat"), router.resolve("chat"));
});

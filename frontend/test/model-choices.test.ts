import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialModelValue,
  isKnownChoice,
  modelAfterProviderChange,
  modelAfterRefresh,
  normalizeModelChoices,
  resolveModelMode,
  toRouteModel,
} from "../src/lib/model-choices.ts";

test("normalizeModelChoices：只认 id/model/name，绝不把显示名当 id", () => {
  // 项目自己的 /api/models 结构
  assert.deepEqual(normalizeModelChoices([{ id: "gpt-5-mini", displayName: "GPT-5 Mini" }]), [
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
  ]);
  // OpenAI 风格的 { data: [...] } 里的对象、Ollama 风格的 { name: ... }
  assert.deepEqual(normalizeModelChoices([{ name: "qwen3:8b" }]), [{ id: "qwen3:8b", name: "qwen3:8b" }]);
  assert.deepEqual(normalizeModelChoices(["plain-model"]), [{ id: "plain-model", name: "plain-model" }]);
  assert.deepEqual(normalizeModelChoices([{ displayName: "只有显示名" }]), [], "没有 id 的条目不能猜一个 id 出来");
  assert.deepEqual(normalizeModelChoices([{ id: "a" }, { id: "a" }, null, 42]), [{ id: "a", name: "a" }], "去重并忽略垃圾");
  assert.deepEqual(normalizeModelChoices(undefined), []);
});

test("initialModelValue：已配置的模型优先，其次是实际解析出来的模型", () => {
  assert.equal(initialModelValue({ configured: "model-B", resolved: "provider-default" }), "model-B");
  assert.equal(initialModelValue({ configured: null, resolved: "provider-default" }), "provider-default");
  assert.equal(initialModelValue({ configured: null, resolved: null }), "");
});

test("modelAfterRefresh：用户选过的模型不会被刷新冲掉，只有空值才自动选第一项", () => {
  const choices = [{ id: "A", name: "A" }, { id: "B", name: "B" }, { id: "C", name: "C" }];
  assert.equal(modelAfterRefresh(choices, "B"), "B", "刷新后必须保持 B");
  assert.equal(modelAfterRefresh(choices, "not-listed-model"), "not-listed-model", "手填的模型也不能被冲掉");
  assert.equal(modelAfterRefresh(choices, ""), "A", "没有值时才用第一项");
  assert.equal(modelAfterRefresh([], "B"), "B");
});

test("modelAfterProviderChange：换 Provider 不允许残留上一个 Provider 的模型", () => {
  const nextChoices = [{ id: "b-1", name: "b-1" }, { id: "b-2", name: "b-2" }];
  assert.equal(modelAfterProviderChange(nextChoices, "b-2"), "b-2", "新 Provider 的默认模型在候选里就用它");
  assert.equal(modelAfterProviderChange(nextChoices, "not-in-list"), "b-1", "否则用候选第一条");
  assert.equal(modelAfterProviderChange([], "p2-default"), "p2-default", "还没取到列表时用它的默认模型字符串");
  assert.notEqual(modelAfterProviderChange(nextChoices, "a-model-2"), "a-model-2");
});

test("resolveModelMode / isKnownChoice：有候选就必须用下拉（哪怕当前值不在候选里）", () => {
  const choices = [{ id: "A", name: "A" }];
  assert.equal(resolveModelMode(choices, "A"), "list");
  assert.equal(resolveModelMode(choices, ""), "list");
  // 关键回归：当前值（例如 Provider 的默认模型）没被 /v1/models 列出来时，
  // 也必须给出下拉，否则"取到列表也点不了"
  assert.equal(resolveModelMode(choices, "hand-typed"), "list");
  assert.equal(resolveModelMode([], "hand-typed"), "manual", "没有候选才退回输入框");
  assert.equal(isKnownChoice(choices, "A"), true);
  assert.equal(isKnownChoice(choices, "B"), false, "不在候选里的值要作为额外选项显示，而不是被丢掉");
});

test("toRouteModel：空值表示让 Provider 用默认模型（发 null）", () => {
  assert.equal(toRouteModel("  model-B  "), "model-B");
  assert.equal(toRouteModel("   "), null);
});

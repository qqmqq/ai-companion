import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_ID_EXPRESSION, PAGE_STATE_EXPRESSION, describePageState, extractDeviceId, parsePageState } from "../../src/integrations/ds-free/capture.ts";

test("设备指纹：从页面拿到的值要能原样收下，空值/占位值一律当没拿到", () => {
  assert.equal(extractDeviceId("0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
  assert.equal(extractDeviceId("  0123456789abcdef0123456789abcdef  "), "0123456789abcdef0123456789abcdef");
  assert.equal(extractDeviceId(null), null);
  assert.equal(extractDeviceId(undefined), null);
  assert.equal(extractDeviceId(""), null);
  assert.equal(extractDeviceId("null"), null);
  assert.equal(extractDeviceId("undefined"), null);
  assert.equal(extractDeviceId("too-short"), null);
  assert.equal(extractDeviceId({ smid: "x" }), null);
  assert.equal(extractDeviceId("x".repeat(600)), null);
});

test("页面状态：字段缺了也不能变成 undefined", () => {
  assert.deepEqual(parsePageState(null), null);
  assert.deepEqual(parsePageState("不是对象"), null);
  const parsed = parsePageState({ url: "https://chat.deepseek.com/sign_in", hasSmsdk: true, tokenKeys: ["userToken", 42, null] });
  assert.deepEqual(parsed, { url: "https://chat.deepseek.com/sign_in", hasSmsdk: true, tokenKeys: ["userToken"] });
  const empty = parsePageState({});
  assert.deepEqual(empty, { url: "", hasSmsdk: false, tokenKeys: [] });
  const text = describePageState(empty);
  assert.ok(text.length > 0 && !text.includes("undefined"));
  assert.equal(describePageState(null), "还没读到页面（浏览器可能还在启动）");
  assert.equal(describePageState({ url: "x", hasSmsdk: true, tokenKeys: [] }), "已读到页面，设备指纹 SDK 就绪");
});

test("页面表达式：先问风控 SDK，再退到本地存储；不能有换行导致的语法问题", () => {
  // 表达式在浏览器里跑，这里只做静态检查：必须是一段自执行函数、必须包含两个来源
  for (const expression of [DEVICE_ID_EXPRESSION, PAGE_STATE_EXPRESSION]) {
    assert.ok(expression.startsWith("(() => {"));
    assert.ok(expression.trimEnd().endsWith("})()"));
    assert.ok(expression.includes("localStorage"));
  }
  assert.ok(DEVICE_ID_EXPRESSION.includes("SMSdk.getDeviceId"));
  assert.ok(DEVICE_ID_EXPRESSION.includes("device|smid|fingerprint"));
});


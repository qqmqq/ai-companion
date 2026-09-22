import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GLOBAL_PROMPT_KEY,
  characterPromptKey,
  readCharacterPrompt,
  readGlobalPrompt,
  resolvePrompt,
} from "../../src/core/context/custom-prompt.ts";

/** 最小设置仓库替身：只需要 get/put/delete/all 四个方法 */
function fakeSettings(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    get<T>(key: string, fallback: T): T {
      return data.has(key) ? (data.get(key) as T) : fallback;
    },
    put(key: string, value: unknown): void {
      data.set(key, value);
    },
    delete(key: string): void {
      data.delete(key);
    },
    all(): Record<string, unknown> {
      return Object.fromEntries(data);
    },
  };
}

test("角色专属键与全局键不互相踩", () => {
  assert.equal(characterPromptKey("char-1"), "prompt.character.char-1");
  assert.notEqual(characterPromptKey("char-1"), GLOBAL_PROMPT_KEY);
});

test("角色没写自己的那份时，用全局默认", () => {
  const settings = fakeSettings({ [GLOBAL_PROMPT_KEY]: "  全局：说话短一点。  " });
  assert.equal(readGlobalPrompt(settings), "全局：说话短一点。", "读出来要去首尾空白");
  assert.equal(readCharacterPrompt(settings, "char-1"), "");
  assert.equal(resolvePrompt(settings, "char-1"), "全局：说话短一点。");
});

test("角色写了自己的那份，就压过全局默认（不再两份都发）", () => {
  const settings = fakeSettings({
    [GLOBAL_PROMPT_KEY]: "全局：叫我老板。",
    [characterPromptKey("char-1")]: "角色：叫我名字。",
  });
  assert.equal(resolvePrompt(settings, "char-1"), "角色：叫我名字。");
  // 别的角色不受影响，仍然用全局
  assert.equal(resolvePrompt(settings, "char-2"), "全局：叫我老板。");
});

test("角色那份只剩空白等于没写：退回全局默认，不会把空行塞进上下文", () => {
  const settings = fakeSettings({
    [GLOBAL_PROMPT_KEY]: "全局：说话短一点。",
    [characterPromptKey("char-1")]: "   \n  ",
  });
  assert.equal(readCharacterPrompt(settings, "char-1"), "");
  assert.equal(resolvePrompt(settings, "char-1"), "全局：说话短一点。");
});

test("没有角色（比如主动消息里的通用场景）就用全局默认", () => {
  assert.equal(resolvePrompt(fakeSettings({ [GLOBAL_PROMPT_KEY]: "全局。" }), null), "全局。");
  assert.equal(resolvePrompt(fakeSettings(), null), "", "两边都没有就是空串");
});

import type { SettingsRepository } from "../ports/repositories.ts";

/**
 * 对话提示词（界面上在「角色」页编辑）。
 *
 * 每个角色一份，存在设置表里，而不是写进角色定义 —— 角色定义是带版本的，
 * 会话冻结在创建时那一版（Phase 5 §20），写进去会出现「改完这一句没反应」；
 * 放这里改完下一句就生效。角色没写自己那份时，用全局默认（原来设置页里那份）。
 */
export const GLOBAL_PROMPT_KEY = "prompt.custom";

/** 一份提示词最多写这么多字（接口层以此拦截，界面里 maxLength 同值） */
export const MAX_PROMPT_CHARS = 4000;

/** 角色专属提示词在设置表里的键 */
export function characterPromptKey(characterId: string): string {
  return "prompt.character." + characterId;
}

/** 全局默认：所有角色通用（角色没写自己的那份时用它） */
export function readGlobalPrompt(settings: SettingsRepository): string {
  return settings.get<string>(GLOBAL_PROMPT_KEY, "").trim();
}

/** 某个角色自己写的那份；空串表示没写（会用全局默认） */
export function readCharacterPrompt(settings: SettingsRepository, characterId: string): string {
  return settings.get<string>(characterPromptKey(characterId), "").trim();
}

/** 这个角色最终生效的提示词：自己的优先，没写才退回全局默认 */
export function resolvePrompt(settings: SettingsRepository, characterId: string | null): string {
  if (characterId === null) return readGlobalPrompt(settings);
  const own = readCharacterPrompt(settings, characterId);
  return own.length > 0 ? own : readGlobalPrompt(settings);
}

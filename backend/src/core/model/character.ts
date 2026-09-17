import type { CharacterId, CharacterVersionId, UserId } from "./ids.ts";
import type { EmotionState } from "./emotion.ts";

/**
 * 角色定义：**本程序自己的模型**，与任何第三方角色卡格式无关。

 * 设计要点（CORE CLEANUP）：
 * 1. 只有真正会被用到、且会注入模型上下文的字段（name/description/personality/scenario/systemPrompt/firstMessage）；
 * 2. 旧数据里遗留的第三方字段（例如 characterBook / alternateGreetings / extensions 等）在**读取边界被忽略**，
 *    不报错、不迁移、不再生成，见 normalizeDefinition；
 * 3. 定义可版本化、可替换，修改它绝不触碰记忆/关系/运行时状态。
 */
export interface CharacterDefinition {
  name: string;
  /** 描述 / 身份：注入上下文时作为"角色设定" */
  description: string;
  personality: string;
  scenario: string;
  /** 角色自己的 system prompt（最靠前的一段指令） */
  systemPrompt: string;
  /** 开场白：新建会话时作为角色的第一条消息 */
  firstMessage: string;
}

export interface CharacterRecord {
  id: CharacterId;
  userId: UserId;
  name: string;
  slug: string;
  /** 头像：只存 MediaStorage 的引用，二进制永远不进库 */
  avatarMediaId: string | null;
  currentVersionId: CharacterVersionId;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterVersion {
  id: CharacterVersionId;
  characterId: CharacterId;
  /**
   * 历史遗留列（数据库 not null）：新版本一律写 "companion-v1"。
   * 旧行里可能是第三方卡格式的值，读取时原样带出，但没有任何运行时代码依赖它。
   */
  specVersion: string;
  definition: CharacterDefinition;
  /** 这一版是怎么来的：create / manual-edit / duplicate（只用于追溯） */
  importedFrom: string;
  createdAt: string;
}

export type AutonomyLevel = "passive" | "low" | "normal" | "high" | "autonomous";

/** 运行时状态与定义解耦：换卡不丢状态，状态不污染卡。 */
export interface CharacterRuntimeState {
  characterId: CharacterId;
  userId: UserId;
  /** 短期情绪（完整状态见 core/model/emotion.ts 的 EmotionState） */
  emotion: { primary: string; secondary: string | null; intensity: number; cause: string };
  /** 与情绪并列的心境标签（更稳定、更宽泛） */
  mood: string;
  /** 完整短期情绪状态（含 valence/arousal/半衰期）；emotion 字段是它的摘要，供上下文使用 */
  emotionState: EmotionState | null;
  /** 日程状态：morning/work/study/meal/rest/leisure/sleep 等，由日程/调度器维护 */
  scheduleState: string;
  activity: { id: string; label: string; startedAt: string; expectedEndAt: string | null };
  location: { sceneId: string; label: string };
  energy: number;
  plan: string[];
  lastInteractionAt: string | null;
  autonomyLevel: AutonomyLevel;
  updatedAt: string;
}

export function emptyDefinition(): CharacterDefinition {
  return { name: "", description: "", personality: "", scenario: "", systemPrompt: "", firstMessage: "" };
}

/**
 * 把"可能缺字段 / 带遗留字段的定义"补全成完整定义。
 *
 * 为什么必须在读取边界做：旧的角色版本 JSON 里存着历史字段（第三方卡格式、Phase 5 才加的键），
 * 少一个键就会在上下文引擎里炸掉。这里只取本模型认识的键，其余**安全忽略**。
 */
export function normalizeDefinition(input: unknown): CharacterDefinition {
  const base = emptyDefinition();
  if (input === null || typeof input !== "object") return base;
  const raw = input as Record<string, unknown>;
  const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
  return {
    name: stringOr(raw.name, base.name),
    description: stringOr(raw.description, base.description),
    personality: stringOr(raw.personality, base.personality),
    scenario: stringOr(raw.scenario, base.scenario),
    systemPrompt: stringOr(raw.systemPrompt, base.systemPrompt),
    firstMessage: stringOr(raw.firstMessage, base.firstMessage),
  };
}

export function defaultRuntimeState(characterId: CharacterId, userId: UserId, at: string): CharacterRuntimeState {
  return {
    characterId,
    userId,
    emotion: { primary: "neutral", secondary: null, intensity: 0.2, cause: "initial" },
    mood: "平静",
    scheduleState: "idle",
    emotionState: null,
    activity: { id: "idle", label: "待机", startedAt: at, expectedEndAt: null },
    location: { sceneId: "default", label: "房间" },
    energy: 0.8,
    plan: [],
    lastInteractionAt: null,
    autonomyLevel: "normal",
    updatedAt: at,
  };
}

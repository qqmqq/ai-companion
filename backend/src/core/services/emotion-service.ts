import type { EmotionChange, EmotionHistoryEntry, EmotionLabel, EmotionState } from "../model/emotion.ts";
import { neutralEmotion } from "../model/emotion.ts";
import type { EmotionRepository } from "../ports/repositories.phase3.ts";
import type { TaskLLM } from "../ports/task-llm.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import type { SettingsRepository } from "../ports/repositories.ts";
import type { CharacterId, ConversationId, MessageId, UserId } from "../model/ids.ts";
import type { CharacterStateService } from "./character-state-service.ts";
import { uuidv7 } from "../../util/ids.ts";
import { notFound } from "../model/errors.ts";

export const EMOTION_BASELINE = { valence: 0, arousal: 0.3, intensity: 0.2, primary: "neutral" as EmotionLabel };

/**
 * 情绪强度只做硬限幅（0..1），不设"单次变化上限"：
 * 情绪是对刺激的反应，一次强烈的刺激本就该产生强烈的情绪；
 * 需要防跳变的是**长期状态**（关系），那里有单次上限。
 */

/** 确定性情绪信号：不花钱、可测试，覆盖大多数日常对话。 */
const SIGNALS: Array<{ emotion: EmotionLabel; valence: number; arousal: number; intensity: number; pattern: RegExp }> = [
  { emotion: "grateful", valence: 0.7, arousal: 0.4, intensity: 0.55, pattern: /(谢谢|感谢|多亏|有你真好|辛苦了)/u },
  { emotion: "happy", valence: 0.75, arousal: 0.55, intensity: 0.6, pattern: /(开心|高兴|太好了|真好|喜欢|爱了|哈哈|嘻嘻|😊|🎉)/u },
  { emotion: "excited", valence: 0.8, arousal: 0.85, intensity: 0.75, pattern: /(超开心|激动|等不及|迫不及待|!{2,}|！{2,})/u },
  { emotion: "shy", valence: 0.4, arousal: 0.6, intensity: 0.5, pattern: /(害羞|不好意思|脸红|别夸我)/u },
  { emotion: "sad", valence: -0.7, arousal: 0.3, intensity: 0.65, pattern: /(难过|伤心|想哭|失落|委屈|心碎)/u },
  { emotion: "lonely", valence: -0.6, arousal: 0.25, intensity: 0.6, pattern: /(孤单|孤独|没人|一个人|想你了)/u },
  { emotion: "angry", valence: -0.7, arousal: 0.85, intensity: 0.7, pattern: /(生气|讨厌|烦死|气死|滚|过分|凭什么)/u },
  { emotion: "worried", valence: -0.4, arousal: 0.6, intensity: 0.55, pattern: /(担心|焦虑|害怕|紧张|不安|睡不着)/u },
  { emotion: "tired", valence: -0.3, arousal: 0.2, intensity: 0.5, pattern: /(累|疲惫|熬夜|困|没力气|加班)/u },
  { emotion: "surprise", valence: 0.3, arousal: 0.8, intensity: 0.6, pattern: /(没想到|居然|竟然|惊讶|天啊)/u },
  { emotion: "calm", valence: 0.2, arousal: 0.2, intensity: 0.3, pattern: /(平静|还好|随便|安静|慢慢来)/u },
];

export function detectDeterministicEmotion(text: string): EmotionChange | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  for (const signal of SIGNALS) {
    if (signal.pattern.test(trimmed)) {
      return {
        primary: signal.emotion,
        intensity: signal.intensity,
        valence: signal.valence,
        arousal: signal.arousal,
        reason: `对话中出现「${signal.emotion}」信号`,
        source: "deterministic",
        triggerKind: "message_signal",
      };
    }
  }
  // 问句与长文本本身不改变情绪，避免"每条消息都情绪波动"
  return null;
}

export const EMOTION_ANALYSIS_SYSTEM_PROMPT = [
  "你是一个情绪分析器。判断下面这条用户消息会让角色产生什么情绪。",
  '只输出 JSON：{"primary":"happy|sad|angry|worried|lonely|tired|excited|shy|calm|neutral","intensity":0..1,"valence":-1..1,"arousal":0..1,"reason":"一句话"}',
  "如果消息平淡无情绪，输出 neutral 且 intensity 不超过 0.2。",
].join("\n");

export function parseEmotionAnalysis(raw: string): EmotionChange | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const primary = typeof parsed.primary === "string" ? parsed.primary : "neutral";
    const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
      const numeric = typeof value === "number" ? value : fallback;
      return Math.min(max, Math.max(min, numeric));
    };
    return {
      primary,
      intensity: clamp(parsed.intensity, 0.4, 0, 1),
      valence: clamp(parsed.valence, 0, -1, 1),
      arousal: clamp(parsed.arousal, 0.4, 0, 1),
      reason: typeof parsed.reason === "string" ? parsed.reason : "模型情绪分析",
      source: "model",
      triggerKind: "message_signal",
    };
  } catch {
    return null;
  }
}

export interface EmotionServiceDeps {
  emotions: EmotionRepository;
  characterState: CharacterStateService;
  taskLLM: TaskLLM;
  settings: SettingsRepository;
  events: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}

export function createEmotionService(deps: EmotionServiceDeps) {
  /** 惰性衰减：情绪会随时间回落到基线，而不是永远停在峰值。 */
  function decay(state: EmotionState, nowMs: number): EmotionState {
    const elapsed = nowMs - Date.parse(state.startedAt);
    if (elapsed <= 0 || state.halfLifeMs <= 0) return state;
    const ratio = Math.pow(0.5, elapsed / state.halfLifeMs);
    if (ratio > 0.999) return state;
    const intensity = state.intensity * ratio;
    const next: EmotionState = {
      ...state,
      intensity,
      valence: state.valence * ratio,
      arousal: EMOTION_BASELINE.arousal + (state.arousal - EMOTION_BASELINE.arousal) * ratio,
      primary: intensity < 0.15 ? EMOTION_BASELINE.primary : state.primary,
      secondary: intensity < 0.15 ? null : state.secondary,
      reason: intensity < 0.15 ? "情绪随时间回落" : state.reason,
      source: "decay",
    };
    return next;
  }

  function persist(characterId: CharacterId, before: EmotionState | null, next: EmotionState, change: EmotionChange): EmotionHistoryEntry {
    const at = deps.clock.nowIso();
    const entry: EmotionHistoryEntry = {
      id: uuidv7(),
      characterId,
      userId: null,
      before,
      after: next,
      reason: change.reason,
      source: change.source,
      triggerKind: change.triggerKind ?? null,
      sourceMessageId: change.sourceMessageId ?? null,
      conversationId: change.conversationId ?? null,
      intensity: next.intensity,
      createdAt: at,
    };
    deps.emotions.append(entry);
    deps.characterState.setEmotionSnapshot(characterId, next, moodLabel(next));
    deps.events.publish({
      name: "emotion.changed",
      at,
      channel: null,
      payload: { characterId, primary: next.primary, intensity: next.intensity, reason: next.reason },
    });
    return entry;
  }

  function moodLabel(state: EmotionState): string {
    const map: Record<string, string> = {
      happy: "愉快",
      excited: "兴奋",
      grateful: "感激",
      calm: "平静",
      neutral: "平静",
      sad: "低落",
      lonely: "寂寞",
      angry: "不悦",
      worried: "担忧",
      tired: "疲惫",
      shy: "害羞",
      surprise: "惊讶",
      fear: "不安",
    };
    return map[state.primary] ?? state.primary;
  }

  return {
    /** 读取当前情绪（含惰性衰减）。 */
    get(characterId: CharacterId): EmotionState {
      const state = deps.characterState.get(characterId);
      const stored = state.emotionState;
      if (stored === null || stored === undefined) {
        return neutralEmotion(deps.clock.nowIso());
      }
      const decayed = decay(stored, deps.clock.now().getTime());
      if (decayed !== stored) {
        deps.characterState.setEmotionSnapshot(characterId, decayed, moodLabel(decayed));
      }
      return decayed;
    },

    /** 唯一的写入口：验证 + 限幅 + 历史记录。 */
    applyChange(
      characterId: CharacterId,
      change: EmotionChange,
      options: { userId?: UserId | null } = {},
    ): { state: EmotionState; entry: EmotionHistoryEntry } {
      const before = this.get(characterId);
      const at = deps.clock.nowIso();
      const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
      const clampSigned = (value: number): number => Math.min(1, Math.max(-1, value));

      const primary = change.primary ?? before.primary;
      const primaryChanged = primary !== before.primary;
      const intensity = clamp01(change.intensity ?? before.intensity);

      const next: EmotionState = {
        primary,
        secondary: change.secondary === undefined ? before.secondary : change.secondary,
        intensity,
        valence: clampSigned(change.valence ?? before.valence),
        arousal: clamp01(change.arousal ?? before.arousal),
        energy: clamp01(change.energy ?? before.energy),
        reason: change.reason,
        source: change.source,
        startedAt: primaryChanged ? at : before.startedAt,
        halfLifeMs: before.halfLifeMs,
      };

      const entry = persist(characterId, before, next, { ...change, userId: options.userId } as EmotionChange);
      return { state: next, entry };
    },

    /** 便宜优先：先用确定性规则，必要时才调用廉价模型。 */
    async analyze(
      characterId: CharacterId,
      input: { text: string; conversationId?: ConversationId | null; sourceMessageId?: MessageId | null; userId?: UserId | null },
    ): Promise<{ change: EmotionChange | null; usedModel: boolean }> {
      const deterministic = detectDeterministicEmotion(input.text);
      if (deterministic !== null) {
        return {
          change: {
            ...deterministic,
            ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
            ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
          },
          usedModel: false,
        };
      }

      const enabled = deps.settings.get<boolean>("emotion.analysis.enabled", false);
      const minChars = deps.settings.get<number>("emotion.analysis.minChars", 20);
      if (!enabled || input.text.trim().length < minChars) {
        return { change: null, usedModel: false };
      }

      const current = this.get(characterId);
      const response = await deps.taskLLM.chat(
        "emotion_analysis",
        {
          model: "default",
          messages: [
            { role: "system", content: EMOTION_ANALYSIS_SYSTEM_PROMPT },
            { role: "user", content: `角色当前情绪：${current.primary}(${current.intensity.toFixed(2)})\n用户消息：${input.text}` },
          ],
          temperature: 0,
        },
        {
          conversationId: input.conversationId ?? null,
          messageId: input.sourceMessageId ?? null,
        },
      );
      const change = parseEmotionAnalysis(response.text);
      if (change === null) {
        deps.logger.warn("emotion analysis returned unparseable output", { characterId });
        return { change: null, usedModel: true };
      }
      return {
        change: {
          ...change,
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
        },
        usedModel: true,
      };
    },

    history(characterId: CharacterId, limit = 50): EmotionHistoryEntry[] {
      return deps.emotions.list(characterId, limit);
    },

    latestHistory(characterId: CharacterId): EmotionHistoryEntry | null {
      return deps.emotions.latest(characterId);
    },

    /** 删掉一条情绪记录：只删记录，当前情绪状态不变（它有自己的生命周期）。 */
    deleteHistory(characterId: CharacterId, entryId: string): void {
      if (!deps.emotions.delete(characterId, entryId)) throw notFound("emotion history", entryId);
    },
  };
}

export type EmotionService = ReturnType<typeof createEmotionService>;
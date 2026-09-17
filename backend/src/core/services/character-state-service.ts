import type { CharacterRuntimeState, AutonomyLevel } from "../model/character.ts";
import type { EmotionState } from "../model/emotion.ts";
import type { CharacterRepository } from "../ports/repositories.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/logger.ts";
import type { CharacterId } from "../model/ids.ts";
import { DomainError, notFound } from "../model/errors.ts";
import { defaultRuntimeState } from "../model/character.ts";

export interface CharacterStateChange {
  activity?: { id: string; label: string; expectedEndAt?: string | null };
  location?: { sceneId: string; label: string };
  mood?: string;
  scheduleState?: string;
  energy?: number;
  plan?: string[];
  autonomyLevel?: AutonomyLevel;
  touchInteraction?: boolean;
}

const MAX_PLAN_ITEMS = 10;
const MAX_LABEL_LENGTH = 80;

/**
 * 角色运行时状态的唯一写入口。
 * ConversationService / EmotionService / Scheduler / ProactiveService 都不得直接改数据库。
 */
export function createCharacterStateService(deps: {
  characters: CharacterRepository;
  clock: Clock;
  logger: Logger;
}) {
  function requireState(characterId: CharacterId): CharacterRuntimeState {
    const record = deps.characters.getById(characterId);
    if (record === null) throw notFound("character", characterId);
    const state = deps.characters.getState(characterId);
    if (state !== null) return state;
    const created = defaultRuntimeState(characterId, record.userId, deps.clock.nowIso());
    deps.characters.upsertState(created);
    return created;
  }

  return {
    get: requireState,

    applyChange(characterId: CharacterId, change: CharacterStateChange): CharacterRuntimeState {
      const current = requireState(characterId);
      const at = deps.clock.nowIso();
      const next: CharacterRuntimeState = { ...current, updatedAt: at };

      if (change.activity !== undefined) {
        if (change.activity.label.length === 0 || change.activity.label.length > MAX_LABEL_LENGTH) {
          throw new DomainError("invalid_input", "activity.label 长度非法");
        }
        next.activity = {
          id: change.activity.id,
          label: change.activity.label,
          startedAt: at,
          expectedEndAt: change.activity.expectedEndAt ?? null,
        };
      }
      if (change.location !== undefined) {
        if (change.location.label.length === 0) throw new DomainError("invalid_input", "location.label 不能为空");
        next.location = { sceneId: change.location.sceneId, label: change.location.label };
      }
      if (change.mood !== undefined) {
        if (change.mood.length > MAX_LABEL_LENGTH) throw new DomainError("invalid_input", "mood 过长");
        next.mood = change.mood;
      }
      if (change.scheduleState !== undefined) next.scheduleState = change.scheduleState;
      if (change.energy !== undefined) {
        if (!Number.isFinite(change.energy)) throw new DomainError("invalid_input", "energy 必须是数字");
        next.energy = Math.min(1, Math.max(0, change.energy));
      }
      if (change.plan !== undefined) {
        if (change.plan.length > MAX_PLAN_ITEMS) {
          throw new DomainError("invalid_input", `plan 最多 ${MAX_PLAN_ITEMS} 项`);
        }
        next.plan = change.plan.map((item) => item.slice(0, 120));
      }
      if (change.autonomyLevel !== undefined) next.autonomyLevel = change.autonomyLevel;
      if (change.touchInteraction === true) next.lastInteractionAt = at;

      deps.characters.upsertState(next);
      deps.logger.debug("character state updated", { characterId, keys: Object.keys(change) });
      return next;
    },

    /**
     * 情绪快照必须整份写回：只写摘要会让完整状态（valence/arousal/半衰期）每次读都回落到基线，
     * 表现为"情绪永远记不住自己"。
     */
    setEmotionSnapshot(characterId: CharacterId, emotion: EmotionState, mood?: string): CharacterRuntimeState {
      const current = requireState(characterId);
      const next: CharacterRuntimeState = {
        ...current,
        emotionState: emotion,
        emotion: {
          primary: emotion.primary,
          secondary: emotion.secondary,
          intensity: emotion.intensity,
          cause: emotion.reason,
        },
        ...(mood === undefined ? {} : { mood }),
        updatedAt: deps.clock.nowIso(),
      };
      deps.characters.upsertState(next);
      return next;
    },

    touchInteraction(characterId: CharacterId): CharacterRuntimeState {
      return this.applyChange(characterId, { touchInteraction: true });
    },
  };
}

export type CharacterStateService = ReturnType<typeof createCharacterStateService>;
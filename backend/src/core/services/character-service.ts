import type { CharacterDefinition, CharacterRecord, CharacterRuntimeState, CharacterVersion, AutonomyLevel } from "../model/character.ts";
import { defaultRuntimeState } from "../model/character.ts";
import { DomainError, notFound } from "../model/errors.ts";
import type { CharacterId, UserId } from "../model/ids.ts";
import type { CharacterRepository } from "../ports/repositories.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/logger.ts";
import { uuidv7 } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";

export interface CharacterView {
  record: CharacterRecord;
  definition: CharacterDefinition;
  state: CharacterRuntimeState;
}

export interface CharacterServiceDeps {
  characters: CharacterRepository;
  events: DomainEventPublisher;
  logger: Logger;
  clock: Clock;
}

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 60) : `character-${Date.now()}`;
}

export function createCharacterService(deps: CharacterServiceDeps) {
  const { characters, events, logger } = deps;

  function uniqueSlug(userId: UserId, name: string): string {
    const base = slugify(name);
    let candidate = base;
    let n = 2;
    while (characters.findBySlug(userId, candidate) !== null) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }

  function view(record: CharacterRecord): CharacterView {
    const version = characters.getVersion(record.currentVersionId);
    if (version === null) {
      throw new DomainError("internal", `character ${record.id} has no current version`);
    }
    const state = characters.getState(record.id) ?? defaultRuntimeState(record.id, record.userId, deps.clock.nowIso());
    return { record, definition: version.definition, state };
  }

  return {
    list(userId: UserId): CharacterRecord[] {
      return characters.listByUser(userId);
    },

    get(id: CharacterId): CharacterView {
      const record = characters.getById(id);
      if (record === null) throw notFound("character", id);
      return view(record);
    },

  /** 复制一个角色（新版本，不影响原角色与会话） */
  duplicate(id: CharacterId, userId: UserId, nameSuffix = "（副本）"): CharacterView {
    const source = this.get(id);
    return this.create({
      userId,
      definition: {
        ...source.definition,
        name: (source.definition.name + nameSuffix).slice(0, 120),
      },
      importedFrom: "duplicate",
    });
  },

  create(input: {
      userId: UserId;
      definition: CharacterDefinition;
      importedFrom: string;
      avatarMediaId?: string | null;
    }): CharacterView {
      const at = deps.clock.nowIso();
      const characterId = uuidv7();
      const versionId = uuidv7();
      const record: CharacterRecord = {
        id: characterId,
        userId: input.userId,
        name: input.definition.name,
        slug: uniqueSlug(input.userId, input.definition.name),
        avatarMediaId: input.avatarMediaId ?? null,
        currentVersionId: versionId,
        createdAt: at,
        updatedAt: at,
      };
      characters.insertCharacter(record);
      const version: CharacterVersion = {
        id: versionId,
        characterId,
        // 历史列（not null）：新版本一律写自己的标记，不再产生第三方卡格式的值
        specVersion: "companion-v1",
        definition: input.definition,
        importedFrom: input.importedFrom,
        createdAt: at,
      };
      characters.insertVersion(version);
      characters.upsertState(defaultRuntimeState(characterId, input.userId, at));

      events.publish({
        name: "character.created",
        at,
        channel: null,
        payload: { characterId, name: record.name },
      });
      logger.info("character created", { characterId, name: record.name });
      return view(record);
    },

    /**
     * 换头像 = 改角色记录上的一个引用；不动定义、不产生新版本、不影响已有会话。
     * 二进制由调用方先写进 MediaStorage，这里只收 mediaId。
     */
    setAvatar(id: CharacterId, mediaId: string | null): CharacterView {
      const record = characters.getById(id);
      if (record === null) throw notFound("character", id);
      characters.updateAvatar(id, mediaId, deps.clock.nowIso());
      logger.info("character avatar updated", { characterId: id, hasAvatar: mediaId !== null });
      return this.get(id);
    },

    /**
     * 改卡 = 新版本。运行时状态与（未来的）记忆/关系不受影响。
     */
    updateDefinition(id: CharacterId, definition: CharacterDefinition): CharacterView {
      const record = characters.getById(id);
      if (record === null) throw notFound("character", id);
      const at = deps.clock.nowIso();
      const versionId = uuidv7();
      characters.insertVersion({
        id: versionId,
        characterId: id,
        specVersion: "companion-v1",
        definition,
        importedFrom: "manual-edit",
        createdAt: at,
      });
      characters.updateCurrentVersion(id, versionId, definition.name, at);
      logger.info("character definition updated", { characterId: id, versionId });
      return this.get(id);
    },

    listVersions(id: CharacterId): CharacterVersion[] {
      return characters.listVersions(id);
    },

    updateState(
      id: CharacterId,
      patch: Partial<Pick<CharacterRuntimeState, "energy" | "autonomyLevel" | "plan" | "location" | "activity">>,
    ): CharacterView {
      const current = this.get(id);
      const next: CharacterRuntimeState = {
        ...current.state,
        ...patch,
        updatedAt: deps.clock.nowIso(),
      };
      characters.upsertState(next);
      return { record: current.record, definition: current.definition, state: next };
    },

    setAutonomy(id: CharacterId, level: AutonomyLevel): CharacterView {
      return this.updateState(id, { autonomyLevel: level });
    },

    remove(id: CharacterId): void {
      const record = characters.getById(id);
      if (record === null) throw notFound("character", id);
      characters.delete(id);
      logger.info("character removed", { characterId: id });
    },
  };
}

export type CharacterService = ReturnType<typeof createCharacterService>;
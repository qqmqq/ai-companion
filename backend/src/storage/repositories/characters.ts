import type { Database } from "../db.ts";
import { parseJson } from "../db.ts";
import { normalizeDefinition } from "../../core/model/character.ts";
import type {
  CharacterDefinition,
  CharacterRecord,
  CharacterRuntimeState,
  CharacterVersion,
} from "../../core/model/character.ts";
import type { CharacterRepository } from "../../core/ports/repositories.ts";

function mapCharacter(row: Record<string, unknown>): CharacterRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    slug: String(row.slug),
    avatarMediaId: row.avatar_media_id === null ? null : String(row.avatar_media_id),
    currentVersionId: String(row.current_version_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapVersion(row: Record<string, unknown>): CharacterVersion {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    specVersion: String(row.spec_version) as CharacterVersion["specVersion"],
    // 读取边界补全：旧版本 JSON 可能缺少 Phase 5 才加入的字段（见 normalizeDefinition）
    definition: normalizeDefinition(parseJson<unknown>(String(row.definition_json), {})),
    importedFrom: String(row.imported_from),
    createdAt: String(row.created_at),
  };
}

export function createCharacterRepository(db: Database): CharacterRepository {
  const insertCharacterStmt = db.raw.prepare(
    `INSERT INTO characters (id, user_id, name, slug, avatar_media_id, current_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVersionStmt = db.raw.prepare(
    `INSERT INTO character_versions (id, character_id, spec_version, definition_json, imported_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectCharacter = db.raw.prepare(
    "SELECT id, user_id, name, slug, avatar_media_id, current_version_id, created_at, updated_at FROM characters WHERE id = ?",
  );
  const selectBySlug = db.raw.prepare(
    "SELECT id, user_id, name, slug, avatar_media_id, current_version_id, created_at, updated_at FROM characters WHERE user_id = ? AND slug = ?",
  );
  const listStmt = db.raw.prepare(
    "SELECT id, user_id, name, slug, avatar_media_id, current_version_id, created_at, updated_at FROM characters WHERE user_id = ? ORDER BY created_at",
  );
  const updateVersionStmt = db.raw.prepare(
    "UPDATE characters SET current_version_id = ?, name = ?, updated_at = ? WHERE id = ?",
  );
  const updateAvatarStmt = db.raw.prepare(
    "UPDATE characters SET avatar_media_id = ?, updated_at = ? WHERE id = ?",
  );
  const deleteStmt = db.raw.prepare("DELETE FROM characters WHERE id = ?");
  const selectVersion = db.raw.prepare(
    "SELECT id, character_id, spec_version, definition_json, imported_from, created_at FROM character_versions WHERE id = ?",
  );
  const listVersionsStmt = db.raw.prepare(
    "SELECT id, character_id, spec_version, definition_json, imported_from, created_at FROM character_versions WHERE character_id = ? ORDER BY created_at DESC",
  );
  const upsertStateStmt = db.raw.prepare(
    `INSERT INTO character_states (character_id, user_id, state_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
  );
  const selectState = db.raw.prepare(
    "SELECT character_id, user_id, state_json, updated_at FROM character_states WHERE character_id = ?",
  );

  return {
    insertCharacter: (record) => {
      insertCharacterStmt.run(
        record.id,
        record.userId,
        record.name,
        record.slug,
        record.avatarMediaId,
        record.currentVersionId,
        record.createdAt,
        record.updatedAt,
      );
    },
    insertVersion: (version) => {
      insertVersionStmt.run(
        version.id,
        version.characterId,
        version.specVersion,
        JSON.stringify(version.definition),
        version.importedFrom,
        version.createdAt,
      );
    },
    getById: (id) => {
      const row = selectCharacter.get(id) as Record<string, unknown> | undefined;
      return row ? mapCharacter(row) : null;
    },
    findBySlug: (userId, slug) => {
      const row = selectBySlug.get(userId, slug) as Record<string, unknown> | undefined;
      return row ? mapCharacter(row) : null;
    },
    listByUser: (userId) => (listStmt.all(userId) as Array<Record<string, unknown>>).map(mapCharacter),
    updateCurrentVersion: (id, versionId, name, at) => {
      updateVersionStmt.run(versionId, name, at, id);
    },
    updateAvatar: (id, mediaId, at) => {
      updateAvatarStmt.run(mediaId, at, id);
    },
    delete: (id) => {
      deleteStmt.run(id);
    },
    getVersion: (id) => {
      const row = selectVersion.get(id) as Record<string, unknown> | undefined;
      return row ? mapVersion(row) : null;
    },
    listVersions: (characterId) =>
      (listVersionsStmt.all(characterId) as Array<Record<string, unknown>>).map(mapVersion),
    upsertState: (state) => {
      upsertStateStmt.run(state.characterId, state.userId, JSON.stringify(state), state.updatedAt);
    },
    getState: (characterId) => {
      const row = selectState.get(characterId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const state = parseJson<CharacterRuntimeState | null>(String(row.state_json), null);
      return state;
    },
  };
}

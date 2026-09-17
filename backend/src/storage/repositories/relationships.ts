import type { Database } from "../db.ts";
import type { RelationshipRepository } from "../../core/ports/repositories.phase3.ts";
import type {
  Relationship,
  RelationshipChangeRecord,
  RelationshipDimension,
  RelationshipMilestone,
  RelationshipStage,
} from "../../core/model/relationship.ts";

const COLUMNS =
  "id, user_id, character_id, familiarity, trust, affection, intimacy, respect, dependence, stage, created_at, updated_at";

function map(row: Record<string, unknown>): Relationship {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: String(row.character_id),
    familiarity: Number(row.familiarity),
    trust: Number(row.trust),
    affection: Number(row.affection),
    intimacy: Number(row.intimacy),
    respect: Number(row.respect),
    dependence: Number(row.dependence),
    stage: String(row.stage) as RelationshipStage,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createRelationshipRepository(db: Database): RelationshipRepository {
  const insertStmt = db.raw.prepare(`INSERT INTO relationships (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getStmt = db.raw.prepare(`SELECT ${COLUMNS} FROM relationships WHERE user_id = ? AND character_id = ?`);
  const updateStmt = db.raw.prepare(
    `UPDATE relationships SET familiarity = ?, trust = ?, affection = ?, intimacy = ?, respect = ?, dependence = ?, stage = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteStmt = db.raw.prepare("DELETE FROM relationships WHERE user_id = ? AND character_id = ?");

  const changeInsert = db.raw.prepare(
    `INSERT INTO relationship_changes (id, relationship_id, dimension, before_value, after_value, delta, clamped, reason, source, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const changeList = db.raw.prepare(
    "SELECT id, relationship_id, dimension, before_value, after_value, delta, clamped, reason, source, source_message_id, created_at FROM relationship_changes WHERE relationship_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  );

  const changeDelete = db.raw.prepare("DELETE FROM relationship_changes WHERE relationship_id = ? AND id = ?");

  const milestoneInsert = db.raw.prepare(
    "INSERT OR IGNORE INTO relationship_milestones (id, relationship_id, key, label, at) VALUES (?, ?, ?, ?, ?)",
  );
  const milestoneList = db.raw.prepare(
    "SELECT id, relationship_id, key, label, at FROM relationship_milestones WHERE relationship_id = ? ORDER BY at",
  );
  const milestoneDelete = db.raw.prepare("DELETE FROM relationship_milestones WHERE relationship_id = ? AND id = ?");

  return {
    get: (userId, characterId) => {
      const row = getStmt.get(userId, characterId) as Record<string, unknown> | undefined;
      return row ? map(row) : null;
    },
    insert: (relationship) => {
      insertStmt.run(
        relationship.id,
        relationship.userId,
        relationship.characterId,
        relationship.familiarity,
        relationship.trust,
        relationship.affection,
        relationship.intimacy,
        relationship.respect,
        relationship.dependence,
        relationship.stage,
        relationship.createdAt,
        relationship.updatedAt,
      );
    },
    update: (relationship) => {
      updateStmt.run(
        relationship.familiarity,
        relationship.trust,
        relationship.affection,
        relationship.intimacy,
        relationship.respect,
        relationship.dependence,
        relationship.stage,
        relationship.updatedAt,
        relationship.id,
      );
    },
    delete: (userId, characterId) => {
      deleteStmt.run(userId, characterId);
    },
    insertChange: (record) => {
      changeInsert.run(
        record.id,
        record.relationshipId,
        record.dimension,
        record.beforeValue,
        record.afterValue,
        record.delta,
        record.clamped ? 1 : 0,
        record.reason,
        record.source,
        record.sourceMessageId,
        record.createdAt,
      );
    },
    listChanges: (relationshipId, limit) =>
      (changeList.all(relationshipId, limit) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        relationshipId: String(row.relationship_id),
        dimension: String(row.dimension) as RelationshipDimension,
        beforeValue: Number(row.before_value),
        afterValue: Number(row.after_value),
        delta: Number(row.delta),
        clamped: Number(row.clamped) === 1,
        reason: String(row.reason),
        source: String(row.source),
        sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
        createdAt: String(row.created_at),
      })),
    deleteChange: (relationshipId, changeId) => changeDelete.run(relationshipId, changeId).changes > 0,
    insertMilestone: (milestone) => {
      milestoneInsert.run(milestone.id, milestone.relationshipId, milestone.key, milestone.label, milestone.at);
    },
    deleteMilestone: (relationshipId, milestoneId) => milestoneDelete.run(relationshipId, milestoneId).changes > 0,
    listMilestones: (relationshipId) =>
      (milestoneList.all(relationshipId) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        relationshipId: String(row.relationship_id),
        key: String(row.key),
        label: String(row.label),
        at: String(row.at),
      })),
  };
}

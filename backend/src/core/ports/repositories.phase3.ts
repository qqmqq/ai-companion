import type {
  Relationship,
  RelationshipChangeRecord,
  RelationshipDimension,
  RelationshipMilestone,
} from "../model/relationship.ts";
import type { EmotionHistoryEntry } from "../model/emotion.ts";
import type { CompanionEvent, EventFilters } from "../model/event.ts";
import type { WorkTask } from "../model/work.ts";
import type { ScheduledJob } from "../model/schedule.ts";
import type { ProactiveDecision } from "../model/proactive.ts";
import type { CharacterId, UserId } from "../model/ids.ts";

export interface RelationshipRepository {
  get(userId: UserId, characterId: CharacterId): Relationship | null;
  insert(relationship: Relationship): void;
  update(relationship: Relationship): void;
  delete(userId: UserId, characterId: CharacterId): void;

  insertChange(record: RelationshipChangeRecord): void;
  listChanges(relationshipId: string, limit: number): RelationshipChangeRecord[];
  /** 删除一条关系变化记录；返回是否真的删掉了（用于区分 404） */
  deleteChange(relationshipId: string, changeId: string): boolean;
  insertMilestone(milestone: RelationshipMilestone): void;
  listMilestones(relationshipId: string): RelationshipMilestone[];
  /** 删除一个里程碑；返回是否真的删掉了 */
  deleteMilestone(relationshipId: string, milestoneId: string): boolean;
}

export interface EmotionRepository {
  append(entry: EmotionHistoryEntry): void;
  list(characterId: CharacterId, limit: number): EmotionHistoryEntry[];
  latest(characterId: CharacterId): EmotionHistoryEntry | null;
  /** 删除一条情绪记录；返回是否真的删掉了（用于区分 404） */
  delete(characterId: CharacterId, id: string): boolean;
}

export interface EventRepository {
  insert(event: CompanionEvent): void;
  get(id: string): CompanionEvent | null;
  list(filters: EventFilters): CompanionEvent[];
  update(event: CompanionEvent): void;
  delete(id: string): void;
  /** 到期需要处理的计划事件（未完结） */
  listPending(nowIso: string, limit: number): CompanionEvent[];
}

export interface WorkTaskRepository {
  insert(task: WorkTask): void;
  get(id: string): WorkTask | null;
  list(filters: { characterId?: CharacterId | null; status?: WorkTask["status"]; limit: number }): WorkTask[];
  update(task: WorkTask): void;
  delete(id: string): void;
  listDue(nowIso: string, limit: number): WorkTask[];
}

export interface ScheduledJobRepository {
  insert(job: ScheduledJob): void;
  get(id: string): ScheduledJob | null;
  list(filters?: { characterId?: CharacterId | null; enabledOnly?: boolean; limit?: number }): ScheduledJob[];
  update(job: ScheduledJob): void;
  delete(id: string): void;
  listDue(nowIso: string, limit: number): ScheduledJob[];
}

export interface ProactiveDecisionRepository {
  insert(decision: ProactiveDecision): void;
  list(filters: { characterId?: CharacterId | null; decision?: ProactiveDecision["decision"]; limit: number }): ProactiveDecision[];
  /** 用于每日限额与冷却判定 */
  countSince(characterId: CharacterId, sinceIso: string): number;
  lastSentAt(characterId: CharacterId): string | null;
}

export type { Relationship, RelationshipChangeRecord, RelationshipDimension, RelationshipMilestone, EmotionHistoryEntry, CompanionEvent, WorkTask, ScheduledJob, ProactiveDecision };

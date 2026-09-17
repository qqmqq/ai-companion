import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../helpers/db.ts";
import { seedFixtures } from "../helpers/memory-stack.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import { createRelationshipRepository } from "../../src/storage/repositories/relationships.ts";
import {
  MAX_DELTA_PER_CHANGE,
  computeStage,
  createRelationshipService,
} from "../../src/core/services/relationship-service.ts";
import { createLogger } from "../../src/app/logger.ts";

function stack() {
  const db = createTestDatabase();
  seedFixtures(db, { userId: "u1", characterId: "c1", conversationId: "cv1" });
  const repository = createRelationshipRepository(db);
  const clock = createFakeClock();
  const service = createRelationshipService({
    relationships: repository,
    events: { publish: () => {} },
    logger: createLogger({ level: "error", sink: () => {} }),
    clock,
  });
  return { db, repository, service, clock, close: () => db.close() };
}

test("relationship is created lazily with baseline values and persists", () => {
  const s = stack();
  try {
    const first = s.service.get("u1", "c1");
    assert.equal(first.stage, "stranger");
    assert.equal(first.familiarity, 0.05);
    assert.ok(first.trust > 0);

    const second = s.service.get("u1", "c1");
    assert.equal(second.id, first.id, "重复读取不能新建关系");
    assert.equal(s.repository.listChanges(first.id, 10).length, 0);
  } finally {
    s.close();
  }
});

test("a single change cannot jump values and is clamped to 0..1", () => {
  const s = stack();
  try {
    const outcome = s.service.applyChange("u1", "c1", [
      { dimension: "trust", delta: 100, reason: "模型试图一次拉满", source: "conversation" },
    ]);
    assert.ok(outcome.relationship.trust <= 0.1 + MAX_DELTA_PER_CHANGE + 1e-9, "单次变化必须被限幅");
    assert.deepEqual(outcome.clamped, ["trust"], "被限幅的维度要标出来");

    const downward = s.service.applyChange("u1", "c1", [
      { dimension: "trust", delta: -100, reason: "模型试图清零", source: "conversation" },
    ]);
    assert.ok(downward.relationship.trust >= 0, "数值不能低于 0");
  } finally {
    s.close();
  }
});

test("every change is journalled with before/after so the trend is explainable", () => {
  const s = stack();
  try {
    const relationship = s.service.get("u1", "c1");
    s.service.applyChange("u1", "c1", [
      { dimension: "affection", delta: 0.03, reason: "用户分享了喜事", source: "conversation", sourceMessageId: "m1" },
      { dimension: "familiarity", delta: 0.02, reason: "又一次交谈", source: "conversation" },
    ]);
    const changes = s.repository.listChanges(relationship.id, 10);
    assert.equal(changes.length, 2);
    const affection = changes.find((c) => c.dimension === "affection");
    assert.ok(affection !== undefined);
    assert.ok(Math.abs(affection.afterValue - affection.beforeValue - affection.delta) < 1e-9);
    assert.equal(affection.sourceMessageId, "m1");
    assert.equal(affection.reason, "用户分享了喜事");
  } finally {
    s.close();
  }
});

test("stage advances only when the weighted score crosses a threshold, and leaves a milestone", () => {
  const s = stack();
  try {
    const relationship = s.service.get("u1", "c1");
    for (let index = 0; index < 12; index += 1) {
      s.service.applyChange("u1", "c1", [
        { dimension: "familiarity", delta: 0.05, reason: "长期相处", source: "conversation" },
        { dimension: "trust", delta: 0.05, reason: "长期相处", source: "conversation" },
        { dimension: "affection", delta: 0.05, reason: "长期相处", source: "conversation" },
      ]);
    }
    const after = s.service.get("u1", "c1");
    assert.notEqual(after.stage, "stranger");
    const milestones = s.service.listMilestones(relationship.id);
    assert.ok(milestones.length >= 1, "阶段跃迁必须留下里程碑");
    assert.ok(milestones.some((m) => m.key.startsWith("stage:")));
  } finally {
    s.close();
  }
});

test("computeStage reflects trust collapse as strained", () => {
  assert.equal(
    computeStage({ familiarity: 0.5, trust: 0.05, affection: 0.4, intimacy: 0.2, respect: 0.3, dependence: 0.1 }),
    "strained",
  );
  assert.equal(computeStage({ familiarity: 0.05, trust: 0.1, affection: 0.05, intimacy: 0, respect: 0.1, dependence: 0 }), "stranger");
});

test("long inactivity decays relationship toward the baseline", () => {
  const s = stack();
  try {
    for (let index = 0; index < 6; index += 1) {
      s.service.applyChange("u1", "c1", [{ dimension: "affection", delta: 0.05, reason: "互动", source: "conversation" }]);
    }
    const before = s.service.get("u1", "c1");
    s.clock.advance(200 * 86_400_000);
    const after = s.service.applyDecay("u1", "c1", 30);
    assert.ok(after.affection < before.affection, "长期无互动应回落");
    assert.ok(after.affection >= 0);
  } finally {
    s.close();
  }
});

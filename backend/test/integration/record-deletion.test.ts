import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import type { Container } from "../../src/app/bootstrap.ts";

interface Ctx {
  baseUrl: string;
  container: Container;
  close: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const server = await createRunningServer();
  return { baseUrl: server.baseUrl, container: server.container, close: server.close };
}

async function api(ctx: Ctx, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(ctx: Ctx, path: string, init?: RequestInit): Promise<T> {
  const response = await api(ctx, path, init);
  assert.ok(response.ok, `${path} → ${response.status} ${await response.clone().text()}`);
  return (await response.json()) as T;
}

async function newCharacter(ctx: Ctx, name: string): Promise<string> {
  const character = await json<{ id: string }>(ctx, "/api/characters", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: "测试角色",
      personality: "安静",
      scenario: "书房",
      systemPrompt: "",
      firstMessage: "在的。",
    }),
  });
  return character.id;
}

function auditActions(ctx: Ctx): string[] {
  return ctx.container.repos.audit.list(200).map((entry) => entry.action);
}

test("关系变化记录可以删除：删完不再出现，当前数值不回滚，重复删返回 404", async () => {
  const ctx = await setup();
  try {
    const characterId = await newCharacter(ctx, "沈砚");

    await json(ctx, `/api/relationships/${characterId}/changes`, {
      method: "POST",
      body: JSON.stringify({ changes: [{ dimension: "trust", delta: 0.05, reason: "一起把事情做完了" }] }),
    });

    const before = await json<{
      relationship: { trust: number };
      changes: Array<{ id: string; reason: string }>;
      milestones: unknown[];
    }>(ctx, `/api/relationships/${characterId}`);
    assert.equal(before.changes.length, 1);
    const changeId = before.changes[0]!.id;
    const trustBefore = before.relationship.trust;

    const deleted = await api(ctx, `/api/relationships/${characterId}/changes/${changeId}`, { method: "DELETE" });
    assert.equal(deleted.status, 204, "删除成功应是 204");

    const after = await json<{ relationship: { trust: number }; changes: Array<{ id: string }> }>(
      ctx,
      `/api/relationships/${characterId}`,
    );
    assert.equal(after.changes.length, 0, "删掉的记录不该再出现在「最近的变化」里");
    assert.equal(after.relationship.trust, trustBefore, "删记录不能把当前信任度回滚");

    const again = await api(ctx, `/api/relationships/${characterId}/changes/${changeId}`, { method: "DELETE" });
    assert.equal(again.status, 404, "同一条记录删两次要 404");

    const missingCharacter = await api(ctx, "/api/relationships/not-a-character/changes/" + changeId, { method: "DELETE" });
    assert.equal(missingCharacter.status, 404, "角色不存在要 404");

    assert.ok(auditActions(ctx).includes("relationship.change_deleted"), "删除关系记录要留审计");
  } finally {
    await ctx.close();
  }
});

test("里程碑可以删除：删完不再出现，关系阶段不变", async () => {
  const ctx = await setup();
  try {
    const characterId = await newCharacter(ctx, "Kai");

    // 每次手工调整都受单次 +0.05 上限，多推几次让阶段从「还很陌生」升到「刚认识」，从而产生里程碑
    for (let round = 0; round < 4; round += 1) {
      await json(ctx, `/api/relationships/${characterId}/changes`, {
        method: "POST",
        body: JSON.stringify({
          changes: [
            { dimension: "trust", delta: 0.05, reason: "第" + String(round) + "次：更信任一点" },
            { dimension: "affection", delta: 0.05, reason: "第" + String(round) + "次：更喜欢一点" },
            { dimension: "familiarity", delta: 0.05, reason: "第" + String(round) + "次：更熟悉一点" },
          ],
        }),
      });
    }

    const before = await json<{ relationship: { stage: string }; milestones: Array<{ id: string; label: string }> }>(
      ctx,
      `/api/relationships/${characterId}`,
    );
    assert.ok(before.milestones.length > 0, "阶段变化应该产生里程碑");
    const milestoneId = before.milestones[0]!.id;
    const stageBefore = before.relationship.stage;

    const deleted = await api(ctx, `/api/relationships/${characterId}/milestones/${milestoneId}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const after = await json<{ relationship: { stage: string }; milestones: Array<{ id: string }> }>(
      ctx,
      `/api/relationships/${characterId}`,
    );
    assert.equal(after.milestones.filter((item) => item.id === milestoneId).length, 0, "里程碑应该被删掉");
    assert.equal(after.relationship.stage, stageBefore, "删里程碑不改变当前关系阶段");

    const again = await api(ctx, `/api/relationships/${characterId}/milestones/${milestoneId}`, { method: "DELETE" });
    assert.equal(again.status, 404);

    assert.ok(auditActions(ctx).includes("relationship.milestone_deleted"), "删除里程碑要留审计");
  } finally {
    await ctx.close();
  }
});

test("情绪记录可以删除：删完不再出现，角色当前情绪不变", async () => {
  const ctx = await setup();
  try {
    const characterId = await newCharacter(ctx, "Aria");

    const stimulated = await json<{ entry: { id: string } }>(ctx, `/api/emotions/${characterId}/stimulus`, {
      method: "POST",
      body: JSON.stringify({ primary: "happy", intensity: 0.6, reason: "被夸了一句" }),
    });
    const entryId = stimulated.entry.id;

    const before = await json<{ emotion: { primary: string }; history: Array<{ id: string }> }>(ctx, `/api/emotions/${characterId}`);
    assert.ok(before.history.some((item) => item.id === entryId), "刚写入的情绪记录应该在历史里");
    const primaryBefore = before.emotion.primary;

    const deleted = await api(ctx, `/api/emotions/${characterId}/history/${entryId}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const after = await json<{ emotion: { primary: string }; history: Array<{ id: string }> }>(ctx, `/api/emotions/${characterId}`);
    assert.equal(after.history.some((item) => item.id === entryId), false, "删掉的记录不该再出现");
    assert.equal(after.emotion.primary, primaryBefore, "删记录不影响角色现在的情绪");

    const again = await api(ctx, `/api/emotions/${characterId}/history/${entryId}`, { method: "DELETE" });
    assert.equal(again.status, 404);

    // 换个角色的 id 去删同一条记录：SQL 里带了 character_id，删不动
    const otherCharacterId = await newCharacter(ctx, "Aria");
    const wrongOwner = await api(ctx, `/api/emotions/${otherCharacterId}/history/${entryId}`, { method: "DELETE" });
    assert.equal(wrongOwner.status, 404, "不能借别的角色删掉别人的记录");

    assert.ok(auditActions(ctx).includes("emotion.history_deleted"), "删除情绪记录要留审计");
  } finally {
    await ctx.close();
  }
});

test("任务可以删除：删完不再出现，并且留下审计", async () => {
  const ctx = await setup();
  try {
    const characterId = await newCharacter(ctx, "林清");
    const executeAt = new Date(Date.now() + 3_600_000).toISOString();
    const task = await json<{ id: string }>(ctx, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ characterId, kind: "custom", executeAt, payload: { title: "给他带一杯咖啡" } }),
    });

    const listed = await json<{ items: Array<{ id: string }> }>(ctx, "/api/tasks");
    assert.ok(listed.items.some((item) => item.id === task.id), "新建的任务应该在列表里");

    const deleted = await api(ctx, `/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const after = await json<{ items: Array<{ id: string }> }>(ctx, "/api/tasks");
    assert.equal(after.items.some((item) => item.id === task.id), false, "删掉的任务不该再出现");
    assert.ok(auditActions(ctx).includes("task.deleted"), "删除任务要留审计");
  } finally {
    await ctx.close();
  }
});

test("事件删除仍然可用，并且留下审计", async () => {
  const ctx = await setup();
  try {
    const characterId = await newCharacter(ctx, "苏晚");
    const event = await json<{ id: string }>(ctx, "/api/events", {
      method: "POST",
      body: JSON.stringify({ characterId, type: "promise", title: "周末一起去书店", description: "", dueAt: null }),
    });

    const deleted = await api(ctx, `/api/events/${event.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const after = await json<{ items: Array<{ id: string }> }>(ctx, "/api/events");
    assert.equal(after.items.some((item) => item.id === event.id), false);
    assert.ok(auditActions(ctx).includes("event.deleted"), "删除事件要留审计");
  } finally {
    await ctx.close();
  }
});

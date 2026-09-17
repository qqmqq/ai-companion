import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestContainer } from "../helpers/container.ts";
import { createHttpServer } from "../../src/app/http-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";

async function withServer(run: (ctx: { app: ReturnType<typeof createHttpServer>; container: Container }) => Promise<void>): Promise<void> {
  const container = await createTestContainer();
  const app = createHttpServer(container);
  try {
    await run({ app, container });
  } finally {
    await app.close();
    await container.shutdown();
  }
}

async function createAria(app: ReturnType<typeof createHttpServer>): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/characters",
    payload: {
      name: "Aria",
      description: "温柔的咖啡师",
      personality: "耐心",
      scenario: "小镇咖啡馆",
      systemPrompt: "",
      firstMessage: "欢迎回来。",
    },
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string };
}

test("health reports database, channels and providers", async () => {
  await withServer(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: "/api/system/health" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      status: string;
      database: string;
      channels: Array<{ channel: string; state: string }>;
      providers: Array<{ id: string }>;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.database, "ok");
    assert.equal(body.channels[0]?.channel, "web");
    assert.deepEqual(
      body.providers.map((p) => p.id),
      ["echo"],
    );
  });
});

test("character create → list → detail carries definition and runtime state", async () => {
  await withServer(async ({ app }) => {
    const created = await createAria(app);
    const list = await app.inject({ method: "GET", url: "/api/characters" });
    const items = (list.json() as { items: Array<{ id: string; definition: { name: string; description: string; firstMessage: string }; state: { energy: number; autonomyLevel: string } }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, created.id);
    assert.equal(items[0]?.definition.name, "Aria");
    assert.equal(items[0]?.definition.description, "温柔的咖啡师");
    assert.equal(items[0]?.definition.firstMessage, "欢迎回来。");
    assert.equal(items[0]?.state.autonomyLevel, "normal");
  });
});

test("editing a character definition creates a new version and keeps runtime state", async () => {
  await withServer(async ({ app }) => {
    const created = await createAria(app);
    await app.inject({ method: "PATCH", url: `/api/characters/${created.id}/state`, payload: { energy: 0.33 } });
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/characters/${created.id}`,
      payload: { description: "改过的设定" },
    });
    assert.equal(patched.statusCode, 200);
    const body = patched.json() as { definition: { description: string }; state: { energy: number } };
    assert.equal(body.definition.description, "改过的设定");
    assert.equal(body.state.energy, 0.33, "改卡不得重置运行时状态");

    const versions = await app.inject({ method: "GET", url: `/api/characters/${created.id}/versions` });
    assert.equal((versions.json() as { items: unknown[] }).items.length, 2);
  });
});

test("web chat flows through the channel into Core and back", async () => {
  await withServer(async ({ app, container }) => {
    const character = await createAria(app);
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    });
    assert.equal(conversation.statusCode, 201);
    const conversationId = (conversation.json() as { id: string }).id;

    const posted = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { text: "今天有点累" },
    });
    assert.equal(posted.statusCode, 201);
    const items = (posted.json() as { items: Array<{ role: string; text: string }> }).items;
    // Phase 5：导入的角色卡带 first_mes，会话创建时会先落一条开场白
    assert.equal(items.length, 3, "开场白 + 用户消息 + 角色回复");
    assert.equal(items[0]?.role, "character", "第 0 条是角色卡开场白");
    assert.equal(items[1]?.role, "user");
    assert.equal(items[1]?.text, "今天有点累");
    assert.equal(items[2]?.role, "character");
    assert.match(items[2]?.text ?? "", /今天有点累/, "echo provider 应收到用户内容");

    const history = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/messages` });
    assert.equal((history.json() as { items: unknown[] }).items.length, 3);

    const conversations = await app.inject({ method: "GET", url: "/api/conversations" });
    assert.equal((conversations.json() as { items: unknown[] }).items.length, 1);

    // 角色消息进入的是 Core 的角色消息，而不是原样回显系统提示
    const characterMessages = container.services.conversations.messages(conversationId).filter((m) => m.role === "character");
    assert.equal(characterMessages.length, 2, "开场白 + 一次回复");
  });
});

test("message edit / regenerate / delete endpoints work", async () => {
  await withServer(async ({ app }) => {
    const character = await createAria(app);
    const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } });
    const conversationId = (created.json() as { id: string }).id;
    const posted = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { text: "第一条" },
    });
    const items = (posted.json() as { items: Array<{ id: string; role: string }> }).items;
    const characterMessage = items.find((m) => m.role === "character");
    assert.ok(characterMessage !== undefined);

    const edited = await app.inject({ method: "PATCH", url: `/api/messages/${characterMessage.id}`, payload: { text: "改好的回复" } });
    assert.equal((edited.json() as { text: string }).text, "改好的回复");

    const regenerated = await app.inject({ method: "POST", url: `/api/messages/${characterMessage.id}/regenerate` });
    assert.equal(regenerated.statusCode, 200);
    const branch = regenerated.json() as { id: string; branchOfId: string };
    assert.equal(branch.branchOfId, characterMessage.id, "重新生成应记录分支来源");

    const removed = await app.inject({ method: "DELETE", url: `/api/messages/${branch.id}` });
    assert.equal(removed.statusCode, 204);
  });
});

test("errors come back in a single structured shape", async () => {
  await withServer(async ({ app }) => {
    const missing = await app.inject({ method: "GET", url: "/api/characters/does-not-exist" });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { error: { code: string } }).error.code, "not_found");

    const invalid = await app.inject({ method: "POST", url: "/api/characters", payload: { name: "" } });
    assert.equal(invalid.statusCode, 400);
    const body = invalid.json() as { error: { code: string; details: { issues: unknown[] } } };
    assert.equal(body.error.code, "invalid_input");
    assert.ok(body.error.details.issues.length > 0);

    const unknownRoute = await app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(unknownRoute.statusCode, 404);
  });
});

test("channels endpoint exposes capabilities and health", async () => {
  await withServer(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: "/api/channels" });
    const items = (response.json() as { items: Array<{ kind: string; capabilities: { text: boolean }; health: { state: string } | null }> }).items;
    assert.equal(items[0]?.kind, "web");
    assert.equal(items[0]?.capabilities.text, true);
    assert.ok(items[0]?.health !== null);
  });
});
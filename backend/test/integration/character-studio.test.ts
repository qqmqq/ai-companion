import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.ts";
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

async function call(ctx: Ctx, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(ctx.baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(ctx: Ctx, path: string, method: string, body?: unknown): Promise<T> {
  const response = await call(ctx, path, method, body);
  assert.ok(response.ok, method + " " + path + " → " + response.status + " " + (await response.clone().text()));
  return (await response.json()) as T;
}

const V1 = {
  name: "沈砚",
  description: "旧书店的店主，认识用户很多年。",
  personality: "话不多，句子短，习惯用陈述句收尾",
  scenario: "南方小城的旧书店，雨季",
  systemPrompt: "保持克制的语气。",
  firstMessage: "来了。书在里屋。",
};
const V2 = { ...V1, personality: "冷淡，回应极短，很少主动开口" };
const V3 = { ...V2, scenario: "现代都市，深夜的连锁便利店" };

interface StudioResponse {
  definition: typeof V1;
  reply: string;
  changes: Array<{ field: string; label: string; before: string; after: string }>;
}

/** 把工坊这一档任务指到测试替身上；聊天那一档不需要，本轮不调用模型 */
async function routeStudioToMock(ctx: Ctx, baseUrl: string): Promise<void> {
  await json(ctx, "/api/providers", "POST", {
    id: "mock-studio",
    kind: "openai-compatible",
    displayName: "测试替身",
    baseUrl,
    defaultModel: "mock-chat",
    requiresCredential: false,
  });
  await json(ctx, "/api/model-routing", "PUT", { taskType: "character_draft", providerId: "mock-studio", model: "mock-chat" });
}

function sectionsText(preview: { sections: Array<{ text: string }> }): string {
  return preview.sections.map((section) => section.text).join(String.fromCharCode(10));
}

test("工坊全流程：设想 → 补全 → 对话修改 → 确认才落库成新版本；旧会话继续用旧版本", async () => {
  const mock = await startMockOpenAIServer({ studioReply: JSON.stringify({ definition: V1, reply: "我把性格写成了话少、句子短。" }) });
  const ctx = await setup();
  try {
    await routeStudioToMock(ctx, mock.baseUrl);

    // 1. 设想 → 完整设定（还没有任何角色被创建）
    const drafted = await json<StudioResponse>(ctx, "/api/characters/draft", "POST", { ideas: "一个开旧书店的人，说话很少" });
    assert.equal(drafted.definition.name, "沈砚");
    assert.equal(drafted.definition.firstMessage, "来了。书在里屋。");
    assert.match(drafted.reply, /话少/);
    const empty = await json<{ items: unknown[] }>(ctx, "/api/characters", "GET");
    assert.equal(empty.items.length, 0, "只是补全、还没确认，就不该创建角色");

    // 2. 用户看过后说「性格再冷一点」→ AI 给改完的完整设定 + 差异
    mock.studioReply = JSON.stringify({ definition: V2, reply: "我把性格改冷了，回应会更短。" });
    const revised = await json<StudioResponse>(ctx, "/api/characters/revise", "POST", { definition: V1, instruction: "性格再冷一点" });
    assert.equal(revised.definition.personality, V2.personality);
    assert.equal(revised.changes.length, 1);
    assert.equal(revised.changes[0]?.field, "personality");
    assert.match(revised.reply, /改冷/);
    const stillEmpty = await json<{ items: unknown[] }>(ctx, "/api/characters", "GET");
    assert.equal(stillEmpty.items.length, 0, "AI 提出修改结果不等于已经改库");

    // 3. 用户确认 → 落库成第一版
    const created = await json<{ id: string; definition: typeof V1; versionCount: number }>(ctx, "/api/characters", "POST", revised.definition);
    assert.equal(created.versionCount, 1);
    assert.equal(created.definition.personality, V2.personality);

    // 4. 建一个会话：它冻结在第一版上
    const conversationA = await json<{ id: string }>(ctx, "/api/conversations", "POST", { characterId: created.id });
    const previewABefore = await json<{ sections: Array<{ text: string }> }>(
      ctx,
      "/api/conversations/" + conversationA.id + "/context-preview",
      "POST",
      { text: "在吗" },
    );
    assert.ok(sectionsText(previewABefore).includes(V2.personality), "会话 A 现在用的是第一版性格");

    // 5. 再改一次并确认 → 产生第二版
    mock.studioReply = JSON.stringify({ definition: V3, reply: "背景换成了现代都市的深夜便利店。" });
    const revisedAgain = await json<StudioResponse>(ctx, "/api/characters/revise", "POST", {
      definition: V2,
      instruction: "把背景改成现代都市",
      history: [
        { role: "user", text: "性格再冷一点" },
        { role: "assistant", text: "我把性格改冷了，回应会更短。" },
      ],
    });
    assert.equal(revisedAgain.definition.scenario, V3.scenario);
    assert.equal(revisedAgain.changes.length, 1);
    assert.equal(revisedAgain.changes[0]?.field, "scenario");
    const patched = await json<{ versionCount: number; definition: typeof V1 }>(ctx, "/api/characters/" + created.id, "PATCH", revisedAgain.definition);
    assert.equal(patched.versionCount, 2, "确认修改 = 新版本");
    assert.equal(patched.definition.scenario, V3.scenario);

    const versions = await json<{ items: Array<{ origin: string }> }>(ctx, "/api/characters/" + created.id + "/versions", "GET");
    assert.equal(versions.items.length, 2);

    // 6. 关键：旧会话继续用旧版本，只有新会话用新版本
    const previewAAfter = await json<{ sections: Array<{ text: string }> }>(
      ctx,
      "/api/conversations/" + conversationA.id + "/context-preview",
      "POST",
      { text: "在吗" },
    );
    const textA = sectionsText(previewAAfter);
    assert.ok(textA.includes(V2.personality), "旧会话仍然看得见第一版的性格");
    assert.equal(textA.includes(V3.scenario), false, "旧会话不该突然变成现代都市背景");

    // 再点一次「开始聊天」拿到的还是同一个网页会话（每个角色一个），所以必须显式开新会话
    const sameAgain = await json<{ id: string }>(ctx, "/api/conversations", "POST", { characterId: created.id });
    assert.equal(sameAgain.id, conversationA.id, "默认还是回到原来那个会话，不会偷偷换版本");

    const conversationB = await json<{ id: string }>(ctx, "/api/conversations", "POST", { characterId: created.id, newSession: true });
    assert.notEqual(conversationB.id, conversationA.id, "newSession=true 才是真的新会话");
    const previewB = await json<{ sections: Array<{ text: string }> }>(
      ctx,
      "/api/conversations/" + conversationB.id + "/context-preview",
      "POST",
      { text: "在吗" },
    );
    assert.ok(sectionsText(previewB).includes(V3.scenario), "新会话用的是第二版");

    const previewAAgain = await json<{ sections: Array<{ text: string }> }>(
      ctx,
      "/api/conversations/" + conversationA.id + "/context-preview",
      "POST",
      { text: "在吗" },
    );
    assert.equal(sectionsText(previewAAgain).includes(V3.scenario), false, "开了新会话，旧会话仍然是旧版本");

    // 模型确实收到了「之前的对话」，多轮修改不是单轮失忆
    const prompt = mock.requests[mock.requests.length - 1]?.body as { messages?: Array<{ role: string; content: string }> };
    const userMessage = prompt.messages?.find((message) => message.role === "user")?.content ?? "";
    assert.match(userMessage, /之前的对话/);
    assert.match(userMessage, /把背景改成现代都市/);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test("工坊的失败与拒绝都是人话：空设想 400、模型乱答 502", async () => {
  const mock = await startMockOpenAIServer({ studioReply: "这个角色我觉得应该很酷。" });
  const ctx = await setup();
  try {
    await routeStudioToMock(ctx, mock.baseUrl);

    const emptyIdeas = await call(ctx, "/api/characters/draft", "POST", { ideas: "" });
    assert.equal(emptyIdeas.status, 400, "空设想不该打到模型");
    const emptyBody = (await emptyIdeas.json()) as { error: { message: string; details: { issues: Array<{ path: string; message: string }> } } };
    assert.match(emptyBody.error.message, /ideas 不能为空/, "报错必须说清是哪个字段、为什么");
    assert.equal(emptyBody.error.details.issues[0]?.path, "ideas");

    const tooLong = await call(ctx, "/api/characters/draft", "POST", { ideas: "想".repeat(2500) });
    assert.equal(tooLong.status, 400);
    const tooLongBody = (await tooLong.json()) as { error: { message: string } };
    assert.match(tooLongBody.error.message, /ideas 最多 2000 个字/, "太长要说清上限是多少");

    const garbage = await call(ctx, "/api/characters/draft", "POST", { ideas: "随便一个角色" });
    assert.equal(garbage.status, 502);
    const body = (await garbage.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "provider_error");
    assert.match(body.error.message, /再试一次/);

    const emptyInstruction = await call(ctx, "/api/characters/revise", "POST", { definition: V1, instruction: "" });
    assert.equal(emptyInstruction.status, 400);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

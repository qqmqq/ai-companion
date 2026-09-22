import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunningServer } from "../helpers/container.ts";

/**
 * 对话提示词改成「每个角色一份」之后的接口行为。
 * 关键点：空串 = 不留覆盖（退回全局默认），而不是存一条空记录。
 */
test("角色对话提示词：能读能写、去首尾空白、空串等于取消覆盖", async () => {
  const server = await createRunningServer();
  try {
    const created = await fetch(server.baseUrl + "/api/characters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "小满" }),
    });
    assert.equal(created.status, 201);
    const character = (await created.json()) as { id: string };

    // 刚建好的角色：自己没写，全局也没有
    const fresh = (await (await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt")).json()) as {
      prompt: string;
      fallback: string;
    };
    assert.equal(fresh.prompt, "");
    assert.equal(fresh.fallback, "");

    // 全局默认：角色没写自己那份时用它
    await fetch(server.baseUrl + "/api/context/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ custom: "全局：说话短一点。" }),
    });
    const withFallback = (await (await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt")).json()) as {
      prompt: string;
      fallback: string;
    };
    assert.equal(withFallback.prompt, "", "角色自己那份还是空的");
    assert.equal(withFallback.fallback, "全局：说话短一点。", "要把全局那份给出来，界面才说得清留空会发生什么");

    // 写角色自己那份：首尾空白去掉
    const saved = await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "  叫我名字。  " }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { prompt: "叫我名字。" });

    const again = (await (await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt")).json()) as {
      prompt: string;
      fallback: string;
    };
    assert.equal(again.prompt, "叫我名字。", "写完要读得回来");
    assert.equal(again.fallback, "全局：说话短一点。", "全局那份不受影响，别的角色还在用");

    // 空串 = 取消覆盖：读回来是空，全局默认照旧
    const cleared = await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.deepEqual(await cleared.json(), { prompt: "" });
    const afterClear = (await (await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt")).json()) as {
      prompt: string;
      fallback: string;
    };
    assert.equal(afterClear.prompt, "");
    assert.equal(afterClear.fallback, "全局：说话短一点。");

    // 超长在入口被拦，不会写进库里
    const tooLong = await fetch(server.baseUrl + "/api/characters/" + character.id + "/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(4001) }),
    });
    assert.equal(tooLong.status, 400);

    // 不存在的角色：404，别默默存一份孤儿提示词
    const missing = await fetch(server.baseUrl + "/api/characters/char-not-exist/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "随便写点" }),
    });
    assert.equal(missing.status, 404);
    const missingGet = await fetch(server.baseUrl + "/api/characters/char-not-exist/prompt");
    assert.equal(missingGet.status, 404);
  } finally {
    await server.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunningServer } from "../helpers/container.ts";

/** 对话提示词补充：能读能写、去掉首尾空白、超长在入口被拦。 */
test("对话提示词补充：能读能写，留空等于不用", async () => {
  const server = await createRunningServer();
  try {
    const empty = (await (await fetch(server.baseUrl + "/api/context/prompt")).json()) as { custom: string; appliesTo: string };
    assert.equal(empty.custom, "");
    assert.match(empty.appliesTo, /系统约束/, "要说清它落在哪一段");

    const saved = await fetch(server.baseUrl + "/api/context/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ custom: "  说话短一点。  " }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { custom: "说话短一点。" }, "首尾空白要去掉");

    const again = (await (await fetch(server.baseUrl + "/api/context/prompt")).json()) as { custom: string };
    assert.equal(again.custom, "说话短一点。", "写完要读得回来");

    const tooLong = await fetch(server.baseUrl + "/api/context/prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ custom: "x".repeat(4001) }),
    });
    assert.equal(tooLong.status, 400);
  } finally {
    await server.close();
  }
});

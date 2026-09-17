import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createTestContainer } from "../helpers/container.ts";
import { createHttpServer } from "../../src/app/http-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";

/**
 * 原生角色生命周期：定义就是 { name, description, personality, scenario, systemPrompt, firstMessage }，
 * 没有任何第三方角色卡格式。这里覆盖 CRUD、版本冻结、头像（PUT/GET/DELETE）与错误输入，
 * 以及最后一条：**旧数据仍然可读**（老行里的第三方字段在读取边界被忽略，不报错、不注入）。
 */

const DEFINITION = {
  name: "Aria",
  description: "温柔的咖啡师",
  personality: "耐心",
  scenario: "小镇咖啡馆",
  systemPrompt: "回答简短一点。",
  firstMessage: "欢迎回来。",
};

async function withServer(
  run: (ctx: { app: ReturnType<typeof createHttpServer>; container: Container }) => Promise<void>,
): Promise<void> {
  const container = await createTestContainer();
  const app = createHttpServer(container);
  try {
    await run({ app, container });
  } finally {
    await app.close();
    await container.shutdown();
  }
}

async function createCharacter(app: ReturnType<typeof createHttpServer>, payload: Record<string, unknown> = DEFINITION): Promise<{ id: string; definition: Record<string, unknown> }> {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string; definition: Record<string, unknown> };
}

async function conversationMessages(
  app: ReturnType<typeof createHttpServer>,
  conversationId: string,
): Promise<Array<{ role: string; text: string }>> {
  const response = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/messages` });
  assert.equal(response.statusCode, 200);
  return (response.json() as { items: Array<{ role: string; text: string }> }).items;
}

// --- 一张真正合法的最小 PNG（1x1 RGBA）------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 1x1 不透明红点：IHDR + IDAT（zlib）+ IEND */
function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const scanline = Buffer.from([0x00, 0xff, 0x00, 0x00, 0xff]); // filter 0 + RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- 生命周期 -------------------------------------------------------------------------

test("角色生命周期：创建 → 列表 → 详情 → 改卡新版本 → 旧会话冻结 → 复制 → 删除", async () => {
  await withServer(async ({ app, container }) => {
    const created = await createCharacter(app);
    assert.deepEqual(created.definition, DEFINITION, "创建返回的六个字段原样保留");

    const list = await app.inject({ method: "GET", url: "/api/characters" });
    const items = (list.json() as { items: Array<{ id: string; name: string; definition: { name: string; firstMessage: string } }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, created.id);
    assert.equal(items[0]?.name, "Aria");
    assert.equal(items[0]?.definition.firstMessage, "欢迎回来。");

    const detail = await app.inject({ method: "GET", url: `/api/characters/${created.id}` });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual((detail.json() as { definition: unknown }).definition, DEFINITION);

    const firstVersion = ((await app.inject({ method: "GET", url: `/api/characters/${created.id}/versions` })).json() as {
      items: Array<{ id: string; origin: string }>;
    }).items;
    assert.equal(firstVersion.length, 1);
    assert.equal(firstVersion[0]?.origin, "create");

    // 建一个会话：它冻结 v1，并把开场白写成第一条角色消息
    const oldConversation = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: created.id } });
    assert.equal(oldConversation.statusCode, 201);
    const oldBody = oldConversation.json() as { id: string; characterVersionId: string };
    assert.equal(oldBody.characterVersionId, firstVersion[0]?.id, "会话必须冻结创建时的版本");
    assert.equal((await conversationMessages(app, oldBody.id))[0]?.text, "欢迎回来。");

    // 改卡 = 新版本
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/characters/${created.id}`,
      payload: { name: "Aria（改名）", firstMessage: "我回来了。" },
    });
    assert.equal(patched.statusCode, 200);
    const patchedBody = patched.json() as { name: string; definition: Record<string, unknown> };
    assert.equal(patchedBody.name, "Aria（改名）");
    assert.deepEqual(patchedBody.definition, { ...DEFINITION, name: "Aria（改名）", firstMessage: "我回来了。" });

    const versions = ((await app.inject({ method: "GET", url: `/api/characters/${created.id}/versions` })).json() as {
      items: Array<{ id: string; origin: string }>;
    }).items;
    assert.equal(versions.length, 2, "改卡必须留下新版本");
    assert.deepEqual(versions.map((version) => version.origin).sort(), ["create", "manual-edit"]);
    const newVersionId = versions.find((version) => version.origin === "manual-edit")!.id;
    assert.notEqual(newVersionId, firstVersion[0]?.id);

    // 旧会话仍然停在旧版本，新会话用新版本
    const frozen = await app.inject({ method: "GET", url: `/api/conversations/${oldBody.id}` });
    assert.equal((frozen.json() as { characterVersionId: string }).characterVersionId, firstVersion[0]?.id);
    assert.equal((await conversationMessages(app, oldBody.id))[0]?.text, "欢迎回来。", "旧会话的开场白不因改卡而变化");

    // web 渠道的会话引用是 `web:<characterId>`（同一个角色只会有一条），所以第二条用另一个引用
    const fresh = container.services.conversations.ensureConversation({
      userId: container.user.id,
      characterId: created.id,
      channel: "web",
      accountId: container.webAccountId,
      conversationRef: "web:after-edit",
    });
    assert.equal(fresh.characterVersionId, newVersionId, "新会话必须绑定新版本");
    assert.equal((await conversationMessages(app, fresh.id))[0]?.text, "我回来了。");

    // 复制：新角色、带副本后缀、不影响原角色
    const duplicated = await app.inject({ method: "POST", url: `/api/characters/${created.id}/duplicate` });
    assert.equal(duplicated.statusCode, 201);
    const copy = duplicated.json() as { id: string; definition: { name: string; firstMessage: string } };
    assert.notEqual(copy.id, created.id);
    assert.equal(copy.definition.name, "Aria（改名）（副本）");
    assert.equal(copy.definition.firstMessage, "我回来了。");
    assert.equal(((await app.inject({ method: "GET", url: "/api/characters" })).json() as { items: unknown[] }).items.length, 2);

    // 删除 → 204，再取 404
    const removed = await app.inject({ method: "DELETE", url: `/api/characters/${created.id}` });
    assert.equal(removed.statusCode, 204);
    const gone = await app.inject({ method: "GET", url: `/api/characters/${created.id}` });
    assert.equal(gone.statusCode, 404);
    assert.equal((gone.json() as { error: { code: string } }).error.code, "not_found");
  });
});

// --- 头像 -----------------------------------------------------------------------------

test("头像：PUT 上传 PNG → GET 原样返回 → DELETE 清掉", async () => {
  await withServer(async ({ app }) => {
    const character = await createCharacter(app);
    const png = tinyPng();

    const put = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/avatar`,
      payload: { base64: png.toString("base64"), filename: "avatar.png" },
    });
    assert.equal(put.statusCode, 200);
    const mediaId = (put.json() as { avatarMediaId: string | null }).avatarMediaId;
    assert.equal(typeof mediaId, "string", "只保存 MediaStorage 的引用");

    const before = await app.inject({ method: "GET", url: `/api/characters/${character.id}/avatar` });
    assert.equal(before.statusCode, 200);
    assert.equal(before.headers["content-type"], "image/png");
    assert.equal(Buffer.compare(before.rawPayload, png), 0, "取回的字节必须与上传的一模一样");

    const cleared = await app.inject({ method: "DELETE", url: `/api/characters/${character.id}/avatar` });
    assert.equal(cleared.statusCode, 200);
    assert.equal((cleared.json() as { avatarMediaId: string | null }).avatarMediaId, null);
    assert.equal((await app.inject({ method: "GET", url: `/api/characters/${character.id}/avatar` })).statusCode, 404);
  });
});

test("错误输入：空名字、非图片字节、空头像都被拒绝", async () => {
  await withServer(async ({ app }) => {
    const emptyName = await app.inject({ method: "POST", url: "/api/characters", payload: { name: "" } });
    assert.equal(emptyName.statusCode, 400);
    assert.equal((emptyName.json() as { error: { code: string } }).error.code, "invalid_input");

    const character = await createCharacter(app);
    const notAnImage = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/avatar`,
      payload: { base64: Buffer.from("这不是图片，只是普通文本").toString("base64"), filename: "fake.png" },
    });
    assert.equal(notAnImage.statusCode, 400, "悬空的扩展名不算图片");
    assert.equal((notAnImage.json() as { error: { code: string } }).error.code, "invalid_input");

    const emptyAvatar = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/avatar`,
      payload: { base64: "", filename: "empty.png" },
    });
    assert.equal(emptyAvatar.statusCode, 400);

    // 失败的上传不得改动角色：仍然没有头像
    const detail = await app.inject({ method: "GET", url: `/api/characters/${character.id}` });
    assert.equal((detail.json() as { avatarMediaId: string | null }).avatarMediaId, null);
  });
});

// --- 旧数据兼容 ------------------------------------------------------------------------

test("旧数据仍然可读：数据库里那行第三方格式的定义照常返回原生的六个字段", async () => {
  await withServer(async ({ app, container }) => {
    const character = await createCharacter(app);

    /** 老行：既有原生字段，也有已经删掉的第三方字段 */
    const legacyDefinition = {
      name: "Aria",
      description: "温柔",
      personality: "安静",
      scenario: "书房",
      firstMessage: "你好。",
      characterBook: { entries: [{ keys: ["便利店"], content: "Aria 喜欢手冲咖啡。" }] },
      alternateGreetings: ["第二次见面，你来了。"],
      tags: ["陪伴", "测试"],
      creator: "tester",
      specVersion: "tavern-v2",
      extensions: { custom: true },
      messageExamples: "<START>{{char}}: 欢迎。",
      postHistoryInstructions: "回复要短。",
      creatorNotes: "测试用角色卡",
    };
    container.db.raw
      .prepare("INSERT INTO character_versions (id, character_id, spec_version, definition_json, imported_from, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-v1", character.id, "tavern-v2", JSON.stringify(legacyDefinition), "import", new Date().toISOString());
    container.db.raw.prepare("UPDATE characters SET current_version_id = ? WHERE id = ?").run("legacy-v1", character.id);

    const detail = await app.inject({ method: "GET", url: `/api/characters/${character.id}` });
    assert.equal(detail.statusCode, 200, "读到旧格式不得报错");
    const definition = (detail.json() as { definition: Record<string, unknown> }).definition;
    assert.deepEqual(Object.keys(definition).sort(), ["description", "firstMessage", "name", "personality", "scenario", "systemPrompt"]);
    assert.equal(definition.name, "Aria");
    assert.equal(definition.description, "温柔");
    assert.equal(definition.personality, "安静");
    assert.equal(definition.scenario, "书房");
    assert.equal(definition.firstMessage, "你好。");
    assert.equal(definition.systemPrompt, "", "缺字段按默认值补全");
    for (const legacy of [
      "characterBook",
      "alternateGreetings",
      "tags",
      "creator",
      "specVersion",
      "extensions",
      "messageExamples",
      "postHistoryInstructions",
      "creatorNotes",
    ]) {
      assert.equal(legacy in definition, false, `${legacy} 不该出现在返回的定义里`);
    }

    // 列表与版本接口同样不崩
    assert.equal((await app.inject({ method: "GET", url: "/api/characters" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/characters/${character.id}/versions` })).statusCode, 200);

    // 端到端：用这行旧数据建会话，开场白仍然来自原生 firstMessage
    const conversation = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } });
    assert.equal(conversation.statusCode, 201);
    const conversationId = (conversation.json() as { id: string }).id;
    const messages = await conversationMessages(app, conversationId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "character");
    assert.equal(messages[0]?.text, "你好。");
  });
});

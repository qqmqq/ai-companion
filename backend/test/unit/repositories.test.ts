import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../helpers/db.ts";
import { createUserRepository } from "../../src/storage/repositories/users.ts";
import { createCharacterRepository } from "../../src/storage/repositories/characters.ts";
import { createConversationRepository } from "../../src/storage/repositories/conversations.ts";
import { createMessageRepository } from "../../src/storage/repositories/messages.ts";
import { createChannelRepository } from "../../src/storage/repositories/channels.ts";
import { createSettingsRepository } from "../../src/storage/repositories/settings.ts";
import { createAuditRepository } from "../../src/storage/repositories/audit.ts";
import { defaultRuntimeState, emptyDefinition } from "../../src/core/model/character.ts";
import { partsToText } from "../../src/core/model/message.ts";

test("user repository is idempotent for the local user", () => {
  const db = createTestDatabase();
  const users = createUserRepository(db);
  const first = users.ensureLocalUser();
  const second = users.ensureLocalUser();
  assert.equal(first.id, second.id);
  assert.equal(users.getById(first.id)?.displayName, first.displayName);
  db.close();
});

test("character + version + state round-trip", () => {
  const db = createTestDatabase();
  const users = createUserRepository(db);
  const characters = createCharacterRepository(db);
  const user = users.ensureLocalUser();
  const now = new Date().toISOString();

  const record = {
    id: "char-1",
    userId: user.id,
    name: "Aria",
    slug: "aria",
    avatarMediaId: null,
    currentVersionId: "ver-1",
    createdAt: now,
    updatedAt: now,
  };
  characters.insertCharacter(record);
  characters.insertVersion({
    id: "ver-1",
    characterId: "char-1",
    specVersion: "tavern-v2",
    definition: { ...emptyDefinition(), name: "Aria", description: "温柔" },
    importedFrom: "test",
    createdAt: now,
  });

  assert.equal(characters.getById("char-1")?.name, "Aria");
  assert.equal(characters.findBySlug(user.id, "aria")?.id, "char-1");
  assert.equal(characters.listVersions("char-1").length, 1);
  assert.equal(characters.getVersion("ver-1")?.definition.description, "温柔");

  characters.upsertState(defaultRuntimeState("char-1", user.id, now));
  characters.upsertState({ ...defaultRuntimeState("char-1", user.id, now), energy: 0.42 });
  assert.equal(characters.getState("char-1")?.energy, 0.42, "state upsert must replace, not duplicate");

  characters.updateCurrentVersion("char-1", "ver-2", "Aria II", now);
  assert.equal(characters.getById("char-1")?.currentVersionId, "ver-2");
  db.close();
});

test("conversation identity is unique per channel+ref+character and messages order by time", () => {
  const db = createTestDatabase();
  const users = createUserRepository(db);
  const characters = createCharacterRepository(db);
  const conversations = createConversationRepository(db);
  const messages = createMessageRepository(db);
  const user = users.ensureLocalUser();
  const now = new Date().toISOString();

  characters.insertCharacter({
    id: "char-1",
    userId: user.id,
    name: "Aria",
    slug: "aria",
    avatarMediaId: null,
    currentVersionId: "ver-1",
    createdAt: now,
    updatedAt: now,
  });

  conversations.insert({
    id: "conv-1",
    userId: user.id,
    characterId: "char-1",
    channel: "web",
    accountId: null,
    conversationId: "web:local",
    title: "Web",
    parentConversationId: null,
    status: "active",
    createdAt: now,
    lastMessageAt: null,
  });

  assert.equal(conversations.findByIdentity("web", "web:local", "char-1")?.id, "conv-1");
  assert.throws(
    () =>
      conversations.insert({
        id: "conv-dup",
        userId: user.id,
        characterId: "char-1",
        channel: "web",
        accountId: null,
        conversationId: "web:local",
        title: "dup",
        parentConversationId: null,
        status: "active",
        createdAt: now,
        lastMessageAt: null,
      }),
    /UNIQUE/i,
  );

  const parts = [{ kind: "text", text: "早上好" }] as const;
  messages.insert({
    id: "m1",
    conversationId: "conv-1",
    role: "user",
    parts: [...parts],
    textRender: partsToText([...parts]),
    replyToId: null,
    providerMessageId: null,
    tokenCount: null,
    status: "completed",
    errorText: null,
    source: "conversation",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    branchOfId: null,
  });
  messages.insert({
    id: "m2",
    conversationId: "conv-1",
    role: "character",
    parts: [{ kind: "text", text: "早呀" }],
    textRender: "早呀",
    replyToId: "m1",
    providerMessageId: null,
    tokenCount: 3,
    status: "completed",
    errorText: null,
    source: "conversation",
    createdAt: "2026-01-01T00:00:01.000Z",
    editedAt: null,
    branchOfId: null,
  });

  const list = messages.listByConversation("conv-1");
  assert.deepEqual(
    list.map((m) => m.id),
    ["m1", "m2"],
  );
  assert.equal(list[0]?.textRender, "早上好");
  assert.equal(messages.countByConversation("conv-1"), 2);
  assert.equal(messages.listByConversation("conv-1", { before: "2026-01-01T00:00:01.000Z" }).length, 1);

  messages.updateEdited("m2", [{ kind: "text", text: "早呀！" }], "早呀！", "2026-01-01T00:00:02.000Z");
  assert.equal(messages.getById("m2")?.textRender, "早呀！");
  assert.equal(messages.getById("m2")?.editedAt, "2026-01-01T00:00:02.000Z");
  db.close();
});

test("channel accounts, settings and audit behave", () => {
  const db = createTestDatabase();
  const channels = createChannelRepository(db);
  const settings = createSettingsRepository(db);
  const audit = createAuditRepository(db);

  channels.ensureChannel("web", true);
  assert.deepEqual(channels.listEnabled(), ["web"]);

  channels.upsertAccount({
    id: "acc-1",
    channel: "web",
    externalAccountId: "local",
    displayName: "本地 Web",
    status: "active",
    createdAt: new Date().toISOString(),
    boundUserId: null,
  });
  assert.equal(channels.listAccounts("web").length, 1);
  channels.upsertAccount({
    id: "acc-2",
    channel: "web",
    externalAccountId: "local",
    displayName: "本地 Web v2",
    status: "paused",
    createdAt: new Date().toISOString(),
    boundUserId: null,
  });
  const accounts = channels.listAccounts();
  assert.equal(accounts.length, 1, "same external id must upsert, not duplicate");
  assert.equal(accounts[0]?.displayName, "本地 Web v2");
  assert.equal(accounts[0]?.status, "paused");

  settings.put("ui.theme", { dark: true }, new Date().toISOString());
  assert.deepEqual(settings.get("ui.theme", null), { dark: true });
  assert.equal(settings.get("missing", "fallback"), "fallback");

  audit.append({ actor: "system", action: "character.created", targetType: "character", targetId: "char-1", detail: {} });
  assert.equal(audit.list(10).length, 1);
  db.close();
});
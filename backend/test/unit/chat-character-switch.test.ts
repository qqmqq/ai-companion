import { test } from "node:test";
import assert from "node:assert/strict";
import { activeCharacterKey, parseSwitchCommand } from "../../src/core/services/chat-character-switch.ts";

test("换角色的口令认得出来，普通聊天不会被误判", () => {
  const asSwitch = (text: string): string | null => {
    const command = parseSwitchCommand(text);
    return command.kind === "switch" ? command.name : null;
  };
  assert.equal(asSwitch("切换角色 Kai"), "Kai");
  assert.equal(asSwitch("切换到Kai"), "Kai");
  assert.equal(asSwitch("换成Aria"), "Aria");
  assert.equal(asSwitch("换Aria"), "Aria");
  assert.equal(asSwitch("更换角色：Kai"), "Kai");
  assert.equal(asSwitch("改成Kai"), "Kai");
  assert.equal(asSwitch("我要跟Kai聊天"), "Kai");
  assert.equal(asSwitch("和Kai聊"), "Kai");
  assert.equal(asSwitch("与Kai说话"), "Kai");
  assert.equal(asSwitch("/切换角色 Kai"), "Kai");
  assert.equal(asSwitch("切换角色「Kai」"), "Kai");
  assert.equal(asSwitch("换成 Kai 吧"), "Kai", "语气词不算名字");
  assert.equal(asSwitch("切换到 Aria呀"), "Aria");
  assert.equal(asSwitch("换个角色 Kai"), "Kai");
  assert.equal(asSwitch("切换角色 Kai。"), "Kai");

  // 普通聊天不能被当成命令
  for (const text of ["今天好累", "Kai是谁", "提醒我带伞", "我想换个工作", "换成什么样都行吗", "这个怎么改成别的颜色", "换成谁都行吗"]) {
    assert.equal(parseSwitchCommand(text).kind, "none", text + " 不该被当成切换口令");
  }
});

test("只说「切换角色」= 要角色列表；「角色列表」也算", () => {
  for (const text of ["切换角色", "换角色", "角色列表", "有哪些角色", "都有哪些角色", "角色", "切换角色？"]) {
    assert.equal(parseSwitchCommand(text).kind, "list", text + " 应该是列列表");
  }
  assert.equal(parseSwitchCommand("").kind, "none");
  assert.equal(parseSwitchCommand("   ").kind, "none");
});

test("每个聊天各存各的当前角色：键里带渠道 + 账号 + 会话引用，且不含平台字样", () => {
  const a = activeCharacterKey({ channel: "web", accountId: "acct-1", conversationRef: "ref-1" });
  const b = activeCharacterKey({ channel: "web", accountId: "acct-1", conversationRef: "ref-2" });
  const c = activeCharacterKey({ channel: "other", accountId: "acct-1", conversationRef: "ref-1" });
  assert.notEqual(a, b, "不同联系人不能共用一条记录");
  assert.notEqual(a, c, "不同渠道不能共用一条记录");
  assert.match(a, /^chatActiveCharacter\./);
  for (const token of ["weixin", "telegram", "discord", "whatsapp"]) {
    assert.equal(a.toLowerCase().includes(token), false, "Core 里不能出现具体平台字样");
  }
});

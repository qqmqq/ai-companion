import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLossless, quoteUint64Fields, toIdString } from "../../src/channels/weixin/protocol/lossless-json.ts";
import { buildBaseInfo, buildPostHeaders, buildWechatUin } from "../../src/channels/weixin/protocol/headers.ts";
import { clientVersionCode, sanitizeBotAgent } from "../../src/channels/weixin/protocol/identity.ts";
import { computeBackoffMs } from "../../src/channels/weixin/protocol/backoff.ts";

const MAX_UINT64 = "9223372036854775807";

test("uint64 message ids survive JSON parsing as exact strings", () => {
  const raw = `{"ret":0,"msgs":[{"message_id":${MAX_UINT64},"item_list":[{"type":1,"msg_id":${MAX_UINT64},"ref_msg":{"svr_id":${MAX_UINT64}}}]}]}`;
  const parsed = parseLossless<{ msgs: Array<{ message_id: string; item_list: Array<{ msg_id: string; ref_msg: { svr_id: string } }> }> }>(raw);
  assert.equal(parsed.msgs[0]!.message_id, MAX_UINT64);
  assert.equal(parsed.msgs[0]!.item_list[0]!.msg_id, MAX_UINT64);
  assert.equal(parsed.msgs[0]!.item_list[0]!.ref_msg.svr_id, MAX_UINT64);
  assert.equal(typeof parsed.msgs[0]!.message_id, "string");
  // 对照：朴素 JSON.parse 会丢精度（这正是必须做无损解析的原因）
  const naive = JSON.parse(raw) as { msgs: Array<{ message_id: number }> };
  assert.notEqual(String(naive.msgs[0]!.message_id), MAX_UINT64);
});

test("uint64 quoting does not touch strings or unrelated numbers", () => {
  const raw = '{"text":"message_id: 123","count":42,"message_id":9007199254740993}';
  const parsed = parseLossless<{ text: string; count: number; message_id: string }>(raw);
  assert.equal(parsed.text, "message_id: 123");
  assert.equal(parsed.count, 42);
  assert.equal(parsed.message_id, "9007199254740993");
  assert.equal(quoteUint64Fields('{"a":"x\\"message_id":1}'), '{"a":"x\\"message_id":1}');
});

test("toIdString normalizes without going through Number", () => {
  assert.equal(toIdString("9223372036854775807"), "9223372036854775807");
  assert.equal(toIdString(123), "123");
  assert.equal(toIdString(10n), "10");
  assert.equal(toIdString(null), null);
  assert.equal(toIdString(""), null);
});

test("request headers follow the protocol shape without leaking the token elsewhere", () => {
  const headers = buildPostHeaders({ token: "tok-123", botAgent: "MyBot/1.0", randomUint32: () => 12345 });
  assert.equal(headers.Authorization, "Bearer tok-123");
  assert.equal(headers.AuthorizationType, "ilink_bot_token");
  assert.equal(headers["iLink-App-Id"], "bot");
  assert.equal(headers["X-WECHAT-UIN"], Buffer.from("12345", "utf8").toString("base64"));
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(buildWechatUin(() => 0), Buffer.from("0", "utf8").toString("base64"));

  const anonymous = buildPostHeaders({ token: null, randomUint32: () => 7 });
  assert.equal(anonymous.Authorization, undefined, "没有凭证时不能发送 Authorization 头");
});

test("base info carries channel version and a sanitized agent", () => {
  const base = buildBaseInfo("MyBot/1.2.0 (region=cn)");
  assert.equal(base.bot_agent, "MyBot/1.2.0 (region=cn)");
  assert.match(base.channel_version, /^\d+\.\d+/);
  assert.equal(sanitizeBotAgent("bad agent!!"), "AI-Companion");
  assert.equal(sanitizeBotAgent(undefined), "AI-Companion");
});

test("client version encodes as 0x00MMNNPP", () => {
  assert.equal(clientVersionCode("2.4.9"), String(0x020409));
  assert.equal(clientVersionCode("1.0.0"), String(0x010000));
});

test("backoff grows exponentially, stays bounded and jitters", () => {
  assert.equal(computeBackoffMs(0, { baseMs: 1000, jitterRatio: 0, random: () => 0.5 }), 1000);
  assert.equal(computeBackoffMs(3, { baseMs: 1000, jitterRatio: 0, random: () => 0.5 }), 8000);
  assert.equal(computeBackoffMs(10, { baseMs: 1000, maxMs: 30_000, jitterRatio: 0, random: () => 0.5 }), 30_000);
  const low = computeBackoffMs(2, { baseMs: 1000, jitterRatio: 0.2, random: () => 0 });
  const high = computeBackoffMs(2, { baseMs: 1000, jitterRatio: 0.2, random: () => 1 });
  assert.equal(low, 3200);
  assert.equal(high, 4800);
  assert.ok(low < high, "抖动必须产生差异，避免同步重试风暴");
});

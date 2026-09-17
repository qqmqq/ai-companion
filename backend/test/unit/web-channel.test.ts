import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebChannel } from "../../src/channels/web/channel.ts";
import { createSseHub } from "../../src/channels/web/sse-hub.ts";
import { createEventBus } from "../../src/app/events.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createChannelManager } from "../../src/channels/manager.ts";
import type { InternalMessage } from "../../src/core/model/message.ts";

const logger = createLogger({ level: "error", sink: () => {} });

test("web channel advertises capabilities and forwards inbound to its handler", async () => {
  const events = createEventBus();
  const channel = createWebChannel({ accountId: "web:test", events, logger });
  const received: InternalMessage[] = [];
  channel.onInbound(async (message) => {
    received.push(message);
  });

  await channel.start();
  assert.equal((await channel.health()).state, "healthy");
  assert.equal(channel.capabilities.text, true);
  assert.equal(channel.capabilities.media.image, false, "Phase 1 不宣称未实现的媒体能力");
  assert.equal((await channel.listAccounts())[0]?.channel, "web");

  await channel.deliverInbound({
    id: "m1",
    channel: "web",
    accountId: "web:test",
    conversationId: "web:c1",
    sender: { id: "u1", name: "U", isSelf: true },
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    type: "text",
    parts: [{ kind: "text", text: "hi" }],
    replyTo: null,
    metadata: {},
    externalRef: { providerMessageId: "p1" },
  });
  assert.equal(received.length, 1);
  await channel.stop();
  assert.equal((await channel.health()).state, "stopped");
});

test("channel send publishes a domain event that reaches the SSE hub", async () => {
  const events = createEventBus();
  const hub = createSseHub();
  // 与 bootstrap 一致的接线：领域事件 → Web 出站传输（单一投递路径）
  events.subscribe({ onEvent: (event) => hub.broadcast(event) });
  const channel = createWebChannel({ accountId: "web:test", events, logger });
  const chunks: string[] = [];
  hub.addClient({ write: (chunk) => chunks.push(chunk), close: () => {} });

  const receipt = await channel.send({
    channel: "web",
    accountId: "web:test",
    conversationId: "web:c1",
    parts: [{ kind: "text", text: "回复内容" }],
    replyToProviderMessageId: null,
    streaming: { mode: "none", runId: null },
    idempotencyKey: "idem-1",
  });
  assert.equal(receipt.idempotencyKey, "idem-1");
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!, /event: message\.delta/);
  assert.match(chunks[0]!, /回复内容/);
});

test("sse hub drops failing clients without breaking others", () => {
  const hub = createSseHub();
  const good: string[] = [];
  hub.addClient({
    write: () => {
      throw new Error("client gone");
    },
    close: () => {},
  });
  hub.addClient({ write: (chunk) => good.push(chunk), close: () => {} });
  hub.broadcast({ name: "message.new", at: new Date().toISOString(), channel: "web", payload: {} });
  assert.equal(good.length, 1);
  assert.equal(hub.clientCount(), 1, "失败的客户端应被移除");
});

test("channel manager registers adapters and routes by kind", async () => {
  const manager = createChannelManager({ logger });
  const channel = createWebChannel({ accountId: "web:test", events: createEventBus(), logger });
  manager.register(channel);
  assert.equal(manager.get("web")?.kind, "web");
  assert.equal(manager.get("weixin"), undefined, "未注册的渠道返回 undefined，而不是抛错");
  const health = await manager.healthAll();
  assert.equal(health[0]?.channel, "web");
  manager.setInboundHandler(async () => {});
  await manager.startAll();
  await manager.stopAll();
});
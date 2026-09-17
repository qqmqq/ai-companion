/**
 * Phase 3 冒烟：真实进程 + 真实 HTTP + 真实 SQLite。
 *
 * 验证链路：聊天 → 情绪 → 关系 → 运行时状态 → 事件 → 任务 → 调度 → 主动消息策略 → 主动消息落库/快照/用量/审计。
 * 使用本地 OpenAI 兼容 mock 服务，无需真实 API Key。
 *
 * 用法：node scripts/phase3-smoke.ts [dataDir]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOpenAIServer } from "../test/helpers/mock-openai-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import { createHttpServer } from "../src/app/http-server.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p3-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

// 冒烟脚本自己驱动 tick，不启动真实定时器（但仍会写入默认调度任务）
const config = loadConfig({
  COMPANION_DATA_DIR: dataDir,
  COMPANION_LOG_LEVEL: "warn",
  COMPANION_SCHEDULER_ENABLED: "false",
});
const container = await createContainer({ config });
await startChannels(container);
const app = createHttpServer(container);
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") throw new Error("no address");
const base = `http://127.0.0.1:${address.port}`;

const mock = await startMockOpenAIServer({
  chatReply: "（mock 模型）我一直在，慢慢说。",
  extractionReply: JSON.stringify([
    { scope: "user", type: "preference", content: "用户喜欢深烘咖啡豆", importance: 0.85, confidence: 0.9, tags: ["咖啡"] },
  ]),
});

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${text.slice(0, 200)}`);
  return (text.length === 0 ? null : JSON.parse(text)) as T;
};

try {
  log(`DATA DIR: ${dataDir}`);
  await json("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke",
      kind: "openai-compatible",
      displayName: "本地 mock 模型",
      baseUrl: mock.baseUrl,
      defaultModel: "mock-chat",
      requiresCredential: false,
    }),
  });
  for (const taskType of ["chat", "memory_extraction", "summarization", "proactive"]) {
    await json("/api/model-routing", { method: "PUT", body: JSON.stringify({ taskType, providerId: "smoke", model: "mock-chat" }) });
  }

  // 角色：原生定义内联构建（角色卡导入接口已删除）
  const character = await json<{ id: string; name: string }>("/api/characters", {
    method: "POST",
    body: JSON.stringify({
      name: "Aria",
      description: "一个会记住你的角色",
      personality: "温柔、好奇",
      scenario: "小镇的咖啡馆",
      systemPrompt: "保持简洁，不要长篇大论。",
      firstMessage: "欢迎回来，今天想喝点什么？",
    }),
  });
  const conversation = await json<{ id: string }>("/api/conversations", { method: "POST", body: JSON.stringify({ characterId: character.id }) });
  log(`CHARACTER: ${character.name} / CONVERSATION: ${conversation.id}`);

  // 1) 聊天 → 情绪 / 关系 / 运行时状态
  await json(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "今天好开心，谢谢你一直陪我" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const emotion = await json<{ emotion: { primary: string; intensity: number }; mood: string; lastInteractionAt: string | null; energy: number }>(
    `/api/emotions/${character.id}`,
  );
  log(`EMOTION: ${emotion.emotion.primary}(${emotion.emotion.intensity.toFixed(2)}) mood=${emotion.mood} lastInteraction=${emotion.lastInteractionAt?.slice(0, 19) ?? "—"}`);

  const relationship = await json<{ relationship: { stage: string; trust: number; familiarity: number }; changes: Array<{ dimension: string; delta: number; reason: string; source: string }> }>(
    `/api/relationships/${character.id}`,
  );
  log(`RELATIONSHIP: stage=${relationship.relationship.stage} trust=${relationship.relationship.trust.toFixed(3)} 变化=${relationship.changes.length} 条`);
  log(`  最近变化: ${relationship.changes.slice(0, 3).map((c) => `${c.dimension}${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(3)}(${c.reason})`).join(" | ")}`);

  // 2) 事件 → 派生任务
  const dueAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  const event = await json<{ id: string; title: string; status: string }>("/api/events", {
    method: "POST",
    body: JSON.stringify({ characterId: character.id, type: "promise", title: "周末一起去书店", importance: 0.9, dueAt }),
  });
  const eventDetail = await json<{ tasks: Array<{ id: string; kind: string; executeAt: string }> }>(`/api/events/${event.id}`);
  log(`EVENT: ${event.title}(${event.status}) → 派生任务 ${eventDetail.tasks.length} 个（${eventDetail.tasks[0]?.kind ?? "-"}）`);

  // 3) 调度器状态 + 手动 tick
  const status = await json<{ jobs: number; nextJobs: Array<{ kind: string; nextRunAt: string }>; runner: { running: boolean } }>("/api/scheduler/status");
  log(`SCHEDULER: jobs=${status.jobs} 最近即将执行=${status.nextJobs.slice(0, 2).map((j) => `${j.kind}@${j.nextRunAt.slice(11, 16)}`).join(",")}`);

  // 4) 关闭静音时段后预览 + 真实发送
  await json("/api/proactive/settings", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, autonomy: "normal", quietHours: { enabled: false, start: "23:00", end: "08:00" }, dailyLimit: 3, cooldownMs: 0 }),
  });

  const preview = await json<{ decision: { decision: string }; text: string | null }>("/api/proactive/preview", {
    method: "POST",
    body: JSON.stringify({ characterId: character.id, triggerKind: "manual", reason: "想问问今天过得怎么样" }),
  });
  log(`PREVIEW(dry-run): decision=${preview.decision.decision} text="${(preview.text ?? "").slice(0, 30)}…"`);

  const sent = await json<{ decision: { decision: string; blockedReason: string | null; messageId: string | null }; text: string | null }>(
    "/api/proactive/trigger",
    { method: "POST", body: JSON.stringify({ characterId: character.id, triggerKind: "manual", reason: "手动问候" }) },
  );
  log(`PROACTIVE: decision=${sent.decision.decision} blocked=${sent.decision.blockedReason ?? "—"} text="${(sent.text ?? "").slice(0, 24)}…"`);

  const messages = await json<{ items: Array<{ role: string; source: string; status: string }> }>(`/api/conversations/${conversation.id}/messages`);
  log(`MESSAGES: ${messages.items.map((m) => `${m.role}/${m.source}/${m.status}`).join(", ")}`);

  const snapshots = await json<{ items: Array<{ source: string; taskType: string; triggerReason: string | null; sections: Array<{ kind: string }> }> }>(
    `/api/conversations/${conversation.id}/snapshots`,
  );
  const proactiveSnapshot = snapshots.items.find((snapshot) => snapshot.source === "proactive");
  log(`SNAPSHOT(proactive): task=${proactiveSnapshot?.taskType} reason="${proactiveSnapshot?.triggerReason}" 含主动意图段=${proactiveSnapshot?.sections.some((s) => s.kind === "proactive_intent") ?? false}`);

  const usage = await json<{ summary: Array<{ taskType: string; calls: number }> }>("/api/usage?days=1");
  log(`USAGE: ${usage.summary.map((s) => `${s.taskType}=${s.calls}`).join(" ")}`);

  // 5) 静音时段：策略拦住且不产生新的模型调用
  await json("/api/proactive/settings", {
    method: "PUT",
    body: JSON.stringify({ quietHours: { enabled: true, start: "00:00", end: "23:59" } }),
  });
  const callsBefore = (await json<{ summary: Array<{ taskType: string; calls: number }> }>("/api/usage?days=1")).summary
    .filter((entry) => entry.taskType === "proactive")
    .reduce((sum, entry) => sum + entry.calls, 0);
  const blocked = await json<{ decision: { decision: string; blockedReason: string | null } }>("/api/proactive/trigger", {
    method: "POST",
    body: JSON.stringify({ characterId: character.id, triggerKind: "manual" }),
  });
  const callsAfter = (await json<{ summary: Array<{ taskType: string; calls: number }> }>("/api/usage?days=1")).summary
    .filter((entry) => entry.taskType === "proactive")
    .reduce((sum, entry) => sum + entry.calls, 0);
  log(`QUIET HOURS: decision=${blocked.decision.decision} blocked=${blocked.decision.blockedReason} 模型调用 ${callsBefore} → ${callsAfter}（应不变）`);

  // 6) 自主等级 passive
  await json("/api/proactive/settings", { method: "PUT", body: JSON.stringify({ autonomy: "passive" }) });
  const eligibility = await json<{ eligibility: Array<{ decision: { blockedReason: string | null } }> }>("/api/proactive/settings");
  log(`AUTONOMY(passive): blocked=${eligibility.eligibility[0]?.decision.blockedReason}`);

  // 7) 决策审计
  const decisions = await json<{ items: Array<{ decision: string; blockedReason: string | null; triggerKind: string; triggerReason: string }> }>(
    "/api/proactive/decisions?limit=10",
  );
  log(`DECISIONS: ${decisions.items.map((d) => `${d.decision}:${d.blockedReason ?? "-"}`).join(" | ")}`);

  // 8) 手动 tick（真实调度循环语义）
  const tick = await json<{ scheduler: { due: number; ran: number; skipped: number }; tasks: { due: number } }>("/api/scheduler/tick", { method: "POST" });
  log(`TICK: due=${tick.scheduler.due} ran=${tick.scheduler.ran} skipped=${tick.scheduler.skipped} tasksDue=${tick.tasks.due}`);

  log("PHASE 3 SMOKE OK");
} finally {
  await mock.close();
  await app.close();
  await container.shutdown();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestContainer } from "../helpers/container.ts";
import { createHttpServer } from "../../src/app/http-server.ts";
import type { Container } from "../../src/app/bootstrap.ts";
import type { InternalMessage } from "../../src/core/model/message.ts";

type App = ReturnType<typeof createHttpServer>;

interface Counters {
  intentCalls: number;
  extractionCalls: number;
  chatCalls: number;
  lastChatSystem: string;
  /** 每次聊天类调用收到的 system 提示（排查"模型到底看到了什么"） */
  chatSystems: string[];
}

interface Ctx {
  app: App;
  container: Container;
  state: Counters;
  /** 切换"模型对意图解析的回答"（先排程、再取消这类流程要用） */
  setIntent: (json: string) => void;
  /** 切换普通聊天回复（用来构造"模型自己承诺了定时"的场景） */
  setChatReply: (text: string) => void;
  /** 让意图解析按顺序返回多次回复（构造"第一次输出不可用、重问一次才对"的场景） */
  setIntentSequence: (items: string[]) => void;
  /** 让非意图/非抽取的模型调用直接失败（构造"措辞生成失败"的场景） */
  setChatFailure: (failing: boolean) => void;
  /** 让聊天类调用按顺序返回（构造"第一次给空、重问一次才有话"的场景） */
  setChatReplySequence: (items: string[]) => void;
}

/** 假模型：只有意图解析那一步返回受控 JSON，其它请求返回普通回复 */
function installFakeModel(intentJson: () => string, chatReply: () => string, state: Counters, chatFails: () => boolean = () => false) {
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    // 上下文里 system 片段可能不止一段（主动意图段排在最近对话之后），全部收进来才算"模型看到了什么"
    const system = (body.messages ?? [])
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join(String.fromCharCode(10));
    const json = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (system.includes("助手动作解析器")) {
      state.intentCalls += 1;
      return json(intentJson());
    }
    if (system.includes("记忆抽取器")) {
      state.extractionCalls += 1;
      return json("[]");
    }
    state.chatCalls += 1;
    state.lastChatSystem = system;
    state.chatSystems.push(system);
    if (chatFails()) {
      return new Response(JSON.stringify({ error: { message: "mock chat failure" } }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return json(chatReply());
  }) as typeof fetch;
  return fetchImpl;
}

const SCHEDULE_JSON = '{"intent":"schedule_message","when":{"kind":"delay","seconds":60},"message":"这条消息是测试","channel":null}';

async function withStack(intentJson: string, run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const state: Counters = { intentCalls: 0, extractionCalls: 0, chatCalls: 0, lastChatSystem: "", chatSystems: [] };
  let currentIntent = intentJson;
  let currentChatReply = "（角色）好的，我记住了。";
  let intentQueue: string[] = [];
  const nextIntent = (): string => {
    if (intentQueue.length > 1) return intentQueue.shift() as string;
    return intentQueue.length === 1 ? (intentQueue[0] as string) : currentIntent;
  };
  let chatFailing = false;
  let chatReplyQueue: string[] = [];
  const nextChatReply = (): string => {
    if (chatReplyQueue.length > 1) return chatReplyQueue.shift() as string;
    return chatReplyQueue.length === 1 ? (chatReplyQueue[0] as string) : currentChatReply;
  };
  const container = await createTestContainer({ fetchImpl: installFakeModel(nextIntent, nextChatReply, state, () => chatFailing) });
  const app = createHttpServer(container);
  try {
    // 测试容器默认只有内置 echo：必须显式配置 provider 并路由，模型才会返回受控 JSON
    const provider = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { id: "mock", kind: "openai-compatible", displayName: "Mock", baseUrl: "http://mock.local", defaultModel: "mock-chat", requiresCredential: false },
    });
    assert.ok(provider.statusCode === 200 || provider.statusCode === 201);
    for (const taskType of ["chat", "proactive", "memory_extraction", "summarization"]) {
      await app.inject({ method: "PUT", url: "/api/model-routing", payload: { taskType, providerId: "mock", model: "mock-chat" } });
    }
    await run({
      app,
      container,
      state,
      setIntent: (json: string) => { currentIntent = json; },
      setChatReply: (text: string) => { currentChatReply = text; },
      setIntentSequence: (items: string[]) => { intentQueue = [...items]; },
      setChatFailure: (failing: boolean) => { chatFailing = failing; },
      setChatReplySequence: (items: string[]) => { chatReplyQueue = [...items]; },
    });
  } finally {
    await app.close();
    await container.shutdown();
  }
}

async function createCharacter(app: App): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/characters",
    payload: { name: "Aria", description: "咖啡师", personality: "安静", scenario: "店里", systemPrompt: "", firstMessage: "在的。" },
  });
  assert.equal(response.statusCode, 201);
  return (response.json() as { id: string }).id;
}

async function createWebConversation(app: App, characterId: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId } });
  assert.equal(response.statusCode, 201);
  return (response.json() as { id: string }).id;
}

interface MessageItem { role: string; text: string; source?: string }

async function sendWeb(app: App, conversationId: string, text: string): Promise<MessageItem[]> {
  const response = await app.inject({ method: "POST", url: "/api/conversations/" + conversationId + "/messages", payload: { text } });
  assert.ok(response.statusCode === 200 || response.statusCode === 201, "发送失败: " + String(response.statusCode));
  return (response.json() as { items: MessageItem[] }).items;
}

interface JobItem {
  id: string;
  /** 这条调度任务挂在哪个角色名下（"记得住是谁的事"就靠它） */
  characterId: string | null;
  kind: string;
  runAt: string | null;
  cronExpr: string | null;
  enabled: boolean;
  payload: Record<string, unknown>;
}

async function listJobs(app: App): Promise<JobItem[]> {
  const response = await app.inject({ method: "GET", url: "/api/scheduler/jobs" });
  return (response.json() as { items: JobItem[] }).items;
}

async function scheduledJobs(app: App): Promise<JobItem[]> {
  return (await listJobs(app)).filter((job) => job.kind === "scheduled_message");
}

test("Test A：网页聊天说「1分钟后给我发消息」→ 建 job + 回复确认", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);

    const items = await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    const reply = items.filter((item) => item.role === "character").at(-1);
    assert.ok(reply !== undefined);
    assert.match(state.lastChatSystem, /\[系统动作结果\]/, "动作事实必须注入生成上下文");
    assert.match(state.lastChatSystem, /你是「/, "同一份上下文里必须带着角色身份（角色化回复的前提）");
    assert.match(state.lastChatSystem, /定时消息/, "注入的是定时消息事实");
    assert.match(state.lastChatSystem, /这条消息是测试/, "注入时间与内容事实");
    assert.equal((reply.text ?? "").includes("我会发你："), false, "不能再有固定模板回执");
    assert.equal(state.intentCalls, 1, "只做一次意图解析");

    const jobs = await scheduledJobs(app);
    assert.equal(jobs.length, 1, "应当创建一条定时消息 job");
    assert.equal(jobs[0]?.payload.message, "这条消息是测试");
    assert.equal(jobs[0]?.payload.channel, "web", "网页会话默认发到网页");
    assert.equal(jobs[0]?.payload.conversationId, conversationId);
    assert.equal(jobs[0]?.enabled, true);
    const delta = Date.parse(String(jobs[0]?.runAt)) - Date.now();
    assert.ok(delta > 50_000 && delta < 70_000, "触发时间应约在 1 分钟后，实际 " + String(delta) + "ms");
    assert.equal(state.extractionCalls, 0, "定时请求本身不做记忆抽取");
  });
});

/**
 * 真实事故回归：用户说「一分钟之后给我发消息」（"分钟之后"，不是"分钟后"）。
 * 以前前置过滤只写了「分钟后」，这句话根本没进模型 → 但模型照样回"一分钟后我发你" → 假确认。
 */
test("回归：说「一分钟之后给我发消息」也必须真的建 job（前置过滤不能漏说法）", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    const items = await sendWeb(app, conversationId, "一分钟之后给我发消息");
    assert.equal(state.intentCalls, 1, "这句话必须进入意图解析（不能因为措辞不同被前置过滤挡掉）");

    const jobs = await scheduledJobs(app);
    assert.equal(jobs.length, 1, "必须创建 scheduled_job");
    assert.equal(jobs[0]?.payload.message, "这条消息是测试");
    assert.equal(jobs[0]?.enabled, true);
    const reply = items.filter((item) => item.role === "character").at(-1);
    assert.match(reply?.text ?? "", /好的/, "任务建成后才给回执");
  });
});

test("Test 6：创建失败时必须说实话，不能假确认", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    // 模拟 Schedule 服务失败（scheduler 报错）
    const scheduler = container.services.scheduler as unknown as { createJob: unknown };
    const original = scheduler.createJob;
    scheduler.createJob = () => { throw new Error("scheduler unavailable"); };
    try {
      await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    } finally {
      scheduler.createJob = original;
    }
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.match(last?.textRender ?? "", /没有设置成功|没有成功/, "失败时必须明确说没建成");
    assert.equal((last?.textRender ?? "").includes("我会发你："), false, "绝不能输出成功回执");
    assert.equal((await scheduledJobs(app)).length, 0, "失败时当然没有 job");
  });
});

test("防假确认：模型自己承诺了定时、但没建成 → 追加诚实更正", async () => {
  await withStack('{"intent":"none"}', async ({ app, container, setChatReply }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    setChatReply("一分钟后我发你。" + String.fromCharCode(10) + String.fromCharCode(10) + "（那就先这样，杯子给你留着。）");

    await sendWeb(app, conversationId, "一分钟之后给我发消息");
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.equal((await scheduledJobs(app)).length, 0, "这一轮确实没有 job");
    assert.match(last?.textRender ?? "", /没有真正建立/, "不能让未设置的承诺留在对话里");
  });
});

test("并发：两次相同的定时请求 = 两个独立 job（不做错误的去重）", async () => {
  await withStack(SCHEDULE_JSON, async ({ app }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    const jobs = await scheduledJobs(app);
    assert.equal(jobs.length, 2, "两个明确请求必须产生两条 job");
    assert.notEqual(jobs[0]?.id, jobs[1]?.id);
  });
});

test("Test B：到点提醒由角色用自己的语气说出来（不是照抄记录原文）", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    const job = (await scheduledJobs(app))[0];
    assert.ok(job !== undefined);

    const run = await app.inject({ method: "POST", url: "/api/scheduler/jobs/" + job.id + "/run", payload: {} });
    assert.equal(run.statusCode, 200);

    const delivered = container.repos.messages.listByConversation(conversationId).filter((message) => message.source === "proactive");
    assert.equal(delivered.length, 1, "定时消息必须落库到会话里");
    assert.equal(delivered[0]?.role, "character");
    console.log("DEBUG hasReminderSection=" + String(state.lastChatSystem.includes("到点要提醒对方的事")) + " hasRaw=" + String(state.lastChatSystem.includes("这条消息是测试")));
    // 这一步的模型调用就是"以角色口吻把这件事说出来"，用的上下文里必须写明要提醒的事
    assert.match(state.lastChatSystem, /你答应过要提醒对方这件事/, "要注入到点提醒的意图段");
    assert.match(state.lastChatSystem, /这条消息是测试/, "记录原文要进上下文，角色才知道提醒什么");
    assert.equal(delivered[0]?.textRender, "（角色）好的，我记住了。", "发出去的是角色自己说的话");
    assert.notEqual(delivered[0]?.textRender, job.payload.message, "不是把记录原文照抄一遍");
  });
});

test("Test C：定时消息进入上下文并被标为主动消息（模型答得出「你刚才发了什么」）", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    const job = (await scheduledJobs(app))[0];
    await app.inject({ method: "POST", url: "/api/scheduler/jobs/" + String(job?.id) + "/run", payload: {} });

    const preview = await app.inject({
      method: "POST",
      url: "/api/conversations/" + conversationId + "/context-preview",
      payload: { text: "你刚才给我发了什么？" },
    });
    assert.equal(preview.statusCode, 200);
    const body = preview.json() as { sections: Array<{ kind: string; text: string; title: string }> };
    const recent = body.sections.filter((section) => section.kind === "recent_conversation");
    const marked = recent.filter((section) => section.text.includes("（主动消息）"));
    assert.equal(marked.length, 1, "上下文里必须有一条被标为主动消息的定时消息");
    assert.match(marked[0]?.text ?? "", /（角色）好的，我记住了。/, "记住的是角色当时说的那句话本身");
    assert.match(marked[0]?.title ?? "", /主动消息/);
    void container;
  });
});

test("Test E：说「取消刚才的提醒」→ 待发 job 被取消", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, setIntent, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    assert.equal((await scheduledJobs(app)).filter((job) => job.enabled).length, 1);

    setIntent('{"intent":"cancel","target":"schedule"}');
    await sendWeb(app, conversationId, "取消刚才的提醒");
    // 路由只回最后几条，这里直接看会话里的最终落库内容
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.match(state.lastChatSystem, /取消/, "取消事实要注入上下文");
    assert.equal(last?.role, "character");
    assert.equal((await scheduledJobs(app)).filter((job) => job.enabled).length, 0, "job 必须被取消");
  });
});

test("Test F：网页会话与微信会话各发各的，不串频道", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, setIntent }) => {
    const characterId = await createCharacter(app);
    const webConversationId = await createWebConversation(app, characterId);
    await sendWeb(app, webConversationId, "1分钟后给我发消息，网页测试");

    setIntent('{"intent":"schedule_message","when":{"kind":"delay","seconds":60},"message":"这条消息是微信测试","channel":null}');
    const weixinConversation = container.services.conversations.ensureConversation({
      userId: container.user.id,
      characterId,
      channel: "weixin",
      accountId: "acct@im.bot",
      conversationRef: "wx-user-1",
    });
    const inbound: InternalMessage = {
      id: "pm-in-1",
      channel: "weixin",
      accountId: "acct@im.bot",
      conversationId: "wx-user-1",
      sender: { id: "wx-user-1", name: null, isSelf: false },
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      type: "text",
      parts: [{ kind: "text", text: "1分钟后给我发消息，这条消息是微信测试" }],
      replyTo: null,
      metadata: {},
      externalRef: { providerMessageId: "pm-in-1" },
    };
    await container.pipeline.handleInbound(inbound);

    const jobs = await scheduledJobs(app);
    assert.equal(jobs.length, 2, "两个渠道各有一条定时消息");
    assert.deepEqual(jobs.map((job) => job.payload.channel).sort(), ["web", "weixin"], "渠道必须跟随各自会话");
    const weixinJob = jobs.find((job) => job.payload.channel === "weixin");
    assert.equal(weixinJob?.payload.conversationId, weixinConversation.id, "微信 job 必须绑定微信会话");
    assert.equal(weixinJob?.payload.message, "这条消息是微信测试");

    await app.inject({ method: "POST", url: "/api/scheduler/jobs/" + String(weixinJob?.id) + "/run", payload: {} });
    // 到点提醒是"角色按记录的意思自己说一句"，所以按"哪条会话收到了主动消息"判断串没串频道
    const webMessages = container.repos.messages.listByConversation(webConversationId);
    assert.equal(webMessages.filter((message) => message.source === "proactive").length, 0, "没跑的那条不能串到网页会话");
    const weixinMessages = container.repos.messages.listByConversation(weixinConversation.id);
    assert.equal(weixinMessages.filter((message) => message.source === "proactive").length, 1, "微信会话收到一条到点提醒");
    assert.equal(weixinMessages.at(-1)?.role, "character");
  });
});


/** ---- 到点提醒的措辞：模型抽风时提醒绝不能丢 ---- */

test("措辞生成失败 → 退回记录原文，提醒照样送到", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, setChatFailure }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    const job = (await scheduledJobs(app))[0];
    assert.ok(job !== undefined);

    setChatFailure(true);
    const run = await app.inject({ method: "POST", url: "/api/scheduler/jobs/" + job.id + "/run", payload: {} });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().outcome, "ran", "生成失败不能把提醒本身也算失败");

    const delivered = container.repos.messages.listByConversation(conversationId).filter((message) => message.source === "proactive");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.textRender, "这条消息是测试", "拿不到措辞就发原文，绝不能让提醒消失");
  });
});

test("措辞生成成空 → 同样退回记录原文", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, setChatReply }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "1分钟后给我发消息，这条消息是测试");
    const job = (await scheduledJobs(app))[0];
    assert.ok(job !== undefined);

    setChatReply("");
    await app.inject({ method: "POST", url: "/api/scheduler/jobs/" + job.id + "/run", payload: {} });
    const delivered = container.repos.messages.listByConversation(conversationId).filter((message) => message.source === "proactive");
    assert.equal(delivered[0]?.textRender, "这条消息是测试", "空文案等于没有文案");
  });
});

test("时间说不清时不猜：只问清楚，不建 job", async () => {
  await withStack('{"intent":"needs_clarification"}', async ({ app, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    const items = await sendWeb(app, conversationId, "过一会儿提醒我带伞");
    const reply = items.filter((item) => item.role === "character").at(-1);
    assert.match(state.lastChatSystem, /需要澄清/, "时间不明必须把澄清要求注入上下文");
    assert.equal((await scheduledJobs(app)).length, 0, "时间不明时不能创建 job");
  });
});

test("普通聊天完全不受影响：模型说 none 时不建 job、不加回执、照常抽取记忆", async () => {
  await withStack('{"intent":"none"}', async ({ app, container, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "今天天气不错，你觉得呢");
    await sendWeb(app, conversationId, "我下午想去楼下走走");
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.equal(last?.textRender, "（角色）好的，我记住了。", "普通聊天回复原样落库（没有被加任何回执）");
    assert.equal((await scheduledJobs(app)).length, 0);
    for (let index = 0; index < 40 && state.extractionCalls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(state.extractionCalls >= 1, "普通聊天照常做记忆抽取");
  });
});

/** ---- 事件 / 任务 / 查询（自然语言 → 后台对象） ---- */

interface EventItem { id: string; title: string; type: string; status: string; dueAt: string | null }
interface TaskItem { id: string; kind: string; status: string; executeAt: string; payload: { title?: string } }

async function listEvents(app: App): Promise<EventItem[]> {
  return ((await app.inject({ method: "GET", url: "/api/events" })).json() as { items: EventItem[] }).items;
}

async function listTasks(app: App): Promise<TaskItem[]> {
  return ((await app.inject({ method: "GET", url: "/api/tasks" })).json() as { items: TaskItem[] }).items;
}

test("Test 2：说「明天下午3点有客户会议」→ 真的建出 event（不是 scheduled_job）", async () => {
  await withStack('{"intent":"create_event","title":"客户会议","when":{"kind":"clock","day":"tomorrow","hour":15,"minute":0}}', async ({ app, container, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "明天下午3点有客户会议");

    const events = await listEvents(app);
    assert.equal(events.length, 1, "必须创建事件");
    assert.equal(events[0]?.title, "客户会议");
    assert.equal(events[0]?.type, "future_plan");
    assert.equal(events[0]?.status, "planned");
    const due = new Date(String(events[0]?.dueAt));
    const tomorrow = new Date(Date.now() + 86_400_000);
    assert.equal(due.getHours(), 15, "时间应当是明天 15:00");
    assert.equal(due.getDate(), tomorrow.getDate());
    assert.equal((await scheduledJobs(app)).length, 0, "事件不能塞进 scheduled_jobs");

    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.match(state.lastChatSystem, /动作=事件/, "事件事实要注入上下文");
    assert.match(state.lastChatSystem, /客户会议/);
  });
});

test("Test 3：说「今天把论文完成」→ 真的建出 work_task（不是 event）", async () => {
  await withStack('{"intent":"create_task","title":"完成论文","when":{"kind":"clock","day":"today","hour":18,"minute":0}}', async ({ app, container, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "今天把论文完成");

    const tasks = await listTasks(app);
    assert.equal(tasks.length, 1, "必须创建任务");
    assert.equal(tasks[0]?.kind, "custom");
    assert.equal(tasks[0]?.status, "pending");
    assert.equal(tasks[0]?.payload.title, "完成论文");
    assert.equal(new Date(String(tasks[0]?.executeAt)).getHours(), 18);
    assert.equal((await listEvents(app)).length, 0, "任务不能当成事件");
    assert.equal((await scheduledJobs(app)).length, 0, "任务不能当成定时消息");

    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.match(state.lastChatSystem, /动作=任务/, "任务事实要注入上下文");
    assert.match(state.lastChatSystem, /完成论文/);
  });
});

test("Test 5：问「我明天有什么安排？」→ 用已有对象回答（不靠模型回忆）", async () => {
  await withStack('{"intent":"query","range":"tomorrow","target":"any"}', async ({ app, container, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    // 先造一条明天的安排与一条明天的任务
    container.services.events.create({
      userId: container.user.id,
      characterId,
      type: "future_plan",
      title: "客户会议",
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      source: "user_manual",
    });
    await sendWeb(app, conversationId, "我明天有什么安排？");

    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    // 事件会按既有规则派生一条提醒任务，所以这里至少要有我们造的那条安排
    assert.match(state.lastChatSystem, /动作=查询/, "查询结果要注入上下文");
    assert.match(state.lastChatSystem, /客户会议/);
  });
});

test("Test 4：说「取消刚才的提醒」→ 任务/提醒按 target 真的被取消", async () => {
  await withStack('{"intent":"cancel","target":"task"}', async ({ app, container, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    container.services.tasks.create({
      userId: container.user.id,
      characterId,
      kind: "custom",
      executeAt: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { title: "完成论文", source: "user_request" },
    });
    await sendWeb(app, conversationId, "取消刚才的任务");

    const tasks = await listTasks(app);
    assert.equal(tasks[0]?.status, "cancelled", "后台必须真的取消");
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.match(state.lastChatSystem, /取消/, "取消事实要注入上下文");
  });
});

test("Test 6：「我今天真的很累，明天还要上班」不能被误判成事件/任务", async () => {
  await withStack('{"intent":"none"}', async ({ app, container }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "我今天真的很累，明天还要上班");

    assert.equal((await listEvents(app)).length, 0, "不能凭空造事件");
    assert.equal((await listTasks(app)).length, 0, "不能凭空造任务");
    assert.equal((await scheduledJobs(app)).length, 0, "不能凭空造定时消息");
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.equal(last?.textRender, "（角色）好的，我记住了。", "普通回复原样保留，不加任何回执");
  });
});

/** ---- 真实事故回归：意图解析被截断 / 空输出，以及钟点承诺的假确认 ---- */

test("意图输出被截断或为空时重问一次：问出来就照常建 job（真实事故回归）", async () => {
  const truncated = '{"intent":"schedule_message","when":{"kind":"clock","day":"today","hour":12,"minute":';
  const good =
    '{"intent":"schedule_message","when":{"kind":"clock","day":"today","hour":12,"minute":0},"message":"提醒我去行政楼交材料","channel":null}';
  await withStack("", async ({ app, state, setIntentSequence }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);

    // 场景一：第一次是半截 JSON（真实事故就是它）
    setIntentSequence([truncated, good]);
    await sendWeb(app, conversationId, "今天大概中午12点吧，提醒我去行政楼交材料");
    assert.equal(state.intentCalls, 2, "半截 JSON 只重问一次");
    let jobs = await scheduledJobs(app);
    assert.equal(jobs.length, 1, "重问之后必须真的把提醒建出来，而不是静默当成闲聊");
    assert.equal(jobs[0]?.payload.message, "提醒我去行政楼交材料");

    // 场景二：第一次干脆是空字符串
    setIntentSequence(["", good]);
    await sendWeb(app, conversationId, "明天中午12点提醒我去开会");
    assert.equal(state.intentCalls, 4, "空输出同样只重问一次");
    jobs = await scheduledJobs(app);
    assert.equal(jobs.length, 2, "第二次请求也要真的建出来");
  });
});

test("两次都问不出结构：把话问回给用户，绝不静默当成普通聊天", async () => {
  await withStack("", async ({ app, state, setIntentSequence }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    setIntentSequence(["", ""]);

    await sendWeb(app, conversationId, "今天大概中午12点吧，提醒我去找我朋友");
    assert.equal((await scheduledJobs(app)).length, 0, "确实没建 job");
    assert.equal(state.intentCalls, 2, "空输出要重问一次");
    assert.match(state.lastChatSystem, /需要澄清/, "要注入澄清要求，而不是让角色自己编一句承诺");
  });
});

test("模型明确回答 none 时不重问：解析成功就只有一次调用", async () => {
  await withStack('{"intent":"none"}', async ({ app, state }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    await sendWeb(app, conversationId, "今天有点想去看看书");
    assert.equal(state.intentCalls, 1, "解析成功就不该重问");
    assert.equal((await scheduledJobs(app)).length, 0);
  });
});

test("假确认回归：角色用钟点承诺了提醒、后台却没建 → 追加诚实更正", async () => {
  await withStack('{"intent":"none"}', async ({ app, container, setChatReply }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);
    setChatReply(
      "……好。" +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        "好的，今天 12:00 我会提醒你：「去行政楼交材料」。",
    );

    await sendWeb(app, conversationId, "今天大概中午12点吧，提醒我去行政楼交材料");
    const last = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.equal((await scheduledJobs(app)).length, 0, "这一轮确实没有 job");
    assert.match(last?.textRender ?? "", /没有真正建立/, "钟点说法的承诺同样不能被留下（旧代码只认相对时间）");
  });
});

test("不误伤：用户要求了提醒、角色只是反问几点 / 只是普通应声 → 不加更正", async () => {
  await withStack('{"intent":"none"}', async ({ app, container, setChatReply }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);

    setChatReply("……几点？" + String.fromCharCode(10) + String.fromCharCode(10) + "（明天你在家还是要上班，我都不知道。）");
    await sendWeb(app, conversationId, "明天提醒我去开会");
    const asked = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.equal((asked?.textRender ?? "").includes("没有真正建立"), false, "反问不算承诺，不该被更正");
    assert.match(asked?.textRender ?? "", /几点/, "反问原样保留");

    setChatReply("（角色）好的，我记住了。");
    await sendWeb(app, conversationId, "明天提醒我去开会");
    const acked = container.repos.messages.listByConversation(conversationId).at(-1);
    assert.equal(acked?.textRender, "（角色）好的，我记住了。", "普通应声不能被当成假确认（否则正常聊天里会冒更正）");
  });
});

test("换角色之后建的提醒归新角色：任务/提醒都认得清是谁的事", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, setIntent }) => {
    const first = await createCharacter(app);
    const second = container.services.characters.create({
      userId: container.user.id,
      importedFrom: "create",
      definition: { name: "Kai", description: "冷淡", personality: "话少", scenario: "书房", systemPrompt: "", firstMessage: "……说吧。" },
    }).record.id;

    // 微信侧先跟第一个角色聊，再换到Kai
    const inbound = (text: string, id: string): InternalMessage => ({
      id,
      channel: "weixin",
      accountId: "acct@im.bot",
      conversationId: "wx-task-1",
      sender: { id: "wx-task-1", name: null, isSelf: false },
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      type: "text",
      parts: [{ kind: "text", text }],
      replyTo: null,
      metadata: {},
      externalRef: { providerMessageId: id },
    });

    await container.pipeline.handleInbound(inbound("你好", "t-1"));
    const beforeSwitch = (await scheduledJobs(app)).length;
    await container.pipeline.handleInbound(inbound("切换角色 Kai", "t-2"));

    // 换完之后说的提醒，必须记在Kai名下（不是第一个角色）
    setIntent('{"intent":"schedule_message","when":{"kind":"delay","seconds":60},"message":"这条是Kai的提醒","channel":null}');
    await container.pipeline.handleInbound(inbound("1分钟后给我发消息，这条是Kai的提醒", "t-3"));
    const jobs = await scheduledJobs(app);
    assert.equal(jobs.length, beforeSwitch + 1, "应该新建了一条提醒");
    const created = jobs.at(-1);
    assert.equal(created?.characterId, second, "提醒要归到当前在聊的角色名下");
    assert.equal(created?.payload.message, "这条是Kai的提醒");
    assert.notEqual(created?.characterId, first, "不能还挂在第一个角色上");
  });
});

test("措辞第一次返回空 → 重问一次，用角色的话发出去（真实事故：发出去的是「提醒我带伞」）", async () => {
  await withStack(SCHEDULE_JSON, async ({ app, container, setChatReplySequence }) => {
    const characterId = await createCharacter(app);
    const conversationId = await createWebConversation(app, characterId);

    // 第 1 次是"创建提醒时角色的回复"，第 2 次是措辞生成（返回空），第 3 次才是重问的结果
    setChatReplySequence(["（角色）记下了。", "", "……水我放桌上了，别又忘了喝。"]);
    await sendWeb(app, conversationId, "1分钟后给我发消息，提醒我带伞");
    const job = (await scheduledJobs(app))[0];
    assert.ok(job !== undefined);

    await app.inject({ method: "POST", url: "/api/scheduler/jobs/" + job.id + "/run", payload: {} });
    const delivered = container.repos.messages.listByConversation(conversationId).filter((message) => message.source === "proactive");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.textRender, "……水我放桌上了，别又忘了喝。", "重问出来的话要真的发出去");
    assert.notEqual(delivered[0]?.textRender, "提醒我带伞", "不能退回记录原文");
  });
});

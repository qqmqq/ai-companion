# 定时消息接入报告（Chat → Scheduler）

日期：2026-09-16 ｜ 范围：只做「让普通聊天能识别并执行定时/延迟发消息」。未进入 Phase 6，未新增其它功能，未重写 Scheduler / Proactive。

最终结论：

- **CHAT_SCHEDULE_INTENT = VERIFIED**（真实 DeepSeek 解析 + mock 断言）
- **WEB_SCHEDULED_MESSAGE = VERIFIED**（真实网页链路：建 job → 到点 → 落库 → 送达）
- **WEIXIN_SCHEDULED_MESSAGE = VERIFIED（投递侧真机已验证）**；微信侧"用户说一句就能建"这一环由 mock 全链路覆盖，真机需在微信里发一句才能标全绿（见 §12/§13）
- **SCHEDULED_MESSAGE_CONTEXT = VERIFIED**（真实对话：AI 答得出"你刚才给我发了什么"）

---

## 1. 根因（为什么两条链路彼此不知道）

chat 链路：`message → ContextEngine → ModelRouter → LLM → assistant → outbound`
调度链路：`scheduled_jobs → scheduler(tick) → JobHandler → proactive/message → outbound`

两条链路**从来没有交点**，具体是四个事实：

1. **chat 没有任何通往 scheduler 的入口**：模型没有工具/函数调用，提示词里也从没提过"你可以定时"；聊天服务拿不到 `Scheduler`，`scheduled_jobs` 只能由启动种子、事件派生任务、`POST /api/scheduler/jobs` 三条路写入——用户说话这条路上一个都没有。
2. **Scheduler 只会执行已经存在的 job**：`tick` 只挑 `next_run_at <= now` 的 job 交给 handler，它自己不产生 job；唯一会"生成内容"的 handler（`proactive_message`）只会问"现在该不该主动说话"，无法表达"到点把这段原文发出去"。
3. **两条链路的"消息"语义不同**：主动消息写库时 `source = "proactive"`，普通回复是 `conversation`；ContextEngine 只有 `source === "proactive"` 时才加 `proactive_intent` 分区，普通聊天看不到"刚刚发过一条定时消息"（历史消息虽在同一会话里，但没有任何标记）。
4. **入站消息归属角色还有一个隐含前提**：`resolveCharacterId` 依赖 `defaultCharacterId`，而代码里没有任何地方写过这个设置（上一轮已加"第一个角色"兜底）。

结论：不是 bug 而是**能力缺口**——缺"意图识别 + 建 job + 到点按原文发送 + 让上下文看见"这四段。

---

## 2. Chat → Schedule 的新链路

```
用户消息（网页 / 微信，共用同一条 messaging-pipeline）
  ↓ 便宜的前置过滤（命中「提醒/分钟后/点/叫我…」才继续）
  ↓ ScheduleIntentDetector.detect()：ModelRouter → 模型 → 结构化 JSON 意图
     {action: schedule_message|cancel|list|needs_clarification|none, when, message, channel}
  ↓ 时间解析（schedule-time.ts，纯函数）→ runAt / cronExpr + timezone
  ↓ ScheduledMessageService.schedule()   ← 唯一能创建 job 的地方
  ↓ Scheduler.createJob() → scheduled_jobs（triggerType = once / cron_like）
  ↓ 同一条回复里追加确定性回执：「好的，19:08 我会发你：「这条消息是测试」。」
  ↓（这一轮不做记忆抽取）

到点：scheduler tick → JobHandler(scheduled_message) → 按原文写库(source=proactive) → ProactiveOutbound → 渠道适配器 → 网页 / 微信
```

关键约束都满足：模型只产出意图，**从不接触数据库**；也没有任何"模型 → HTTP → 微信"的路径（出站仍然只走渠道适配器）。

---

## 3. 用到的现有 service（没有另起一套）

| 现有组件 | 用途 |
| --- | --- |
| `ModelRouter` / `TaskLLM` | 意图识别走已存在的 `taskType = "proactive"` 档位，provider/model 由路由决定，用量照常记账 |
| `Scheduler` | `createJob` / `setEnabled` / `getJob` / `listJobs` / `runNow`；`once` 执行后自动禁用 |
| `scheduled_jobs` 表 | 全部状态都在这里：没有第二张表、没有第二套 timer |
| `SchedulerRunner` | 仍然是应用层每 60 秒 tick 一次 |
| `MessageWriter` | 到点写库（`begin/finalize`），天然带 `source` |
| `ProactiveOutbound` | 到点出站（网页 / 微信同一个端口） |
| 角色 / 会话仓储 | 校验会话存在、解析归属角色 |

新增只有三个 Core 文件（都不依赖任何基础设施）：`schedule-time.ts`（纯时间计算）、`schedule-intent.ts`（意图识别）、`scheduled-message-service.ts`（应用服务）。

---

## 4. scheduled_job 如何创建

```ts
// core/services/scheduled-message-service.ts
deps.scheduler.createJob({
  userId, characterId,
  kind: "scheduled_message",                 // 新 kind，handler 在组合根注册
  triggerType: cronExpr === null ? "once" : "cron_like",
  runAt,                                     // 一次性：ISO 时间
  cronExpr,                                  // "每天 8 点" → "08:00"（复用已有 cron_like）
  nextRunAt: runAt ?? nowIso,
  misfirePolicy: "run_once",                 // 关机错过 → 回来补发一次，而不是静默丢掉
  payload: { message, channel, conversationId, conversationRef, accountId, timezone, requestedAt, requestedChannel },
});
```

payload 里存的就是"到点要发的原文"，**不存任何模型改写**。job 初始 `enabled=true` / `status=idle`（= 待发）。

## 5. Web 如何发送

到点由 `scheduled_message` handler 执行：`MessageWriter.begin({conversationId, source:"proactive"})` → `finalize(原文, completed)` → `ProactiveOutbound.send({target:{channel:"web", accountId, conversationRef}})` → 网页渠道把消息推给页面（与既有主动消息同一条路）。

## 6. Weixin 如何发送

同一段 handler，`target.channel` 就是该会话的渠道（微信会话 → `conversationRef` 是对方的 im.wechat id），走 `WeixinChannel` 既有发送链路（context_token / 幂等键 / 重试都在渠道内部）。
**Core 里没有任何平台字样**（架构守卫 ARCH-1/ARCH-4 仍是 8/8）：渠道只是数据，不是代码分支。

## 7. source 如何记录

复用既有字段 `messages.source`（**没有新增列**）：

| 消息 | source |
| --- | --- |
| 普通聊天回复 | `conversation` |
| 到点的定时消息 / 主动消息 | **`proactive`**（由 MessageWriter 写入） |

## 8. ContextEngine 如何识别 proactive message

`recentConversationSections()` 按 source 标注：

```ts
title: message.source === "proactive" ? "角色（主动消息）" : "角色",
text:  message.source === "proactive" ? "（主动消息）" + message.textRender : message.textRender,
```

于是"主动消息"这个事实会随最近对话进入模型上下文；应用级系统提示里也补了一句"你可以定时/延迟发消息……只要自然确认即可"，避免模型继续声称"我发不了定时消息"。

---

## 9. 时间 / timezone 处理

- 相对时间（"1 分钟后"）→ `now + seconds`，与时区无关；
- 绝对时间（"晚上 8 点" / "明天 9 点"）按**本机挂钟时间**解释；已经过去的"今天 X 点"顺延到明天；
- 时区名写进 job payload（真机实测 `<本机时区>`）：**没有硬编码 UTC**；
- "每天 8 点" → `cron_like` + `cronExpr = "08:00"`，复用已有每日触发实现；
- 时间解析不出来 → **不建 job**，只回复"你想让我什么时候提醒你？"（绝不猜）。

## 10. 取消与查询

- "取消刚才的提醒" → `cancelLatest()` → `Scheduler.setEnabled(job, false)`（保留记录，不物理删除）→ 回执"原定 X 的提醒已经取消了"；
- "我刚才设置的提醒呢？" → `listPending()` → 回执列出每条的本地时间与内容；
- 没有实现复杂任务管理器（按任务书要求最小）。

---

## 11. 测试结果

### mock 全链路 `backend/test/integration/scheduled-message.test.ts`（新增 7 条，全部 PASS）

| 用例 | 断言 |
| --- | --- |
| Test A | 网页说"1分钟后给我发消息，这条消息是测试" → 回执含"好的"与原文；只建 1 条 job；`channel=web`；`runAt` 落在 60 秒内；这一轮不做记忆抽取 |
| Test B | 到点执行 → 会话里出现 `source=proactive` 的消息，文本**与原文逐字一致**（没有被模型改写） |
| Test C | 上下文里出现被标记"（主动消息）"的定时消息，原文完整保留 |
| Test E | "取消刚才的提醒" → job `enabled=false`，回执含"取消" |
| Test F | 网页 + 微信各一条 job，`channel` 分别为 web/weixin；执行微信 job 不会把消息写进网页会话 |
| 澄清 | 模型返回 needs_clarification 时：不建 job + 反问具体时间 |
| 普通聊天 | 模型返回 none 时：不加回执、不建 job；记忆抽取照常（每 2 条用户消息一次的门控未改） |

### 真机验证（本机，真实 DeepSeek，不是 mock）

**REAL WEB（完整链路）**

```
11:07:28  schedule.intent   action=schedule_message whenKind=delay        ← 真实模型解析成功
11:07:28  schedule.create   job:bud93kunt3 runAt=11:08:28 tz=<本机时区> channel=web
11:08:4x  schedule.deliver  delivered=true                                ← scheduler tick 触发
会话里出现：「这条消息是测试」（source=proactive）
```

**SCHEDULED_MESSAGE_CONTEXT（真实对话）**：用户问"你刚才给我发了什么？"，AI 回答：

> 就一句：「这条消息是测试」。刚才我说没法定时，是我说错了。

**REAL WEIXIN（投递侧）**：对真实微信会话下了一条 `scheduled_message`（内容"示例提醒"，70 秒后触发）：

```
11:14:11  schedule.deliver  delivered=true  conversationId=01a0a901-…（channel=weixin）
微信会话里出现：「示例提醒」 → 已通过 WeixinChannel 发到手机
```

### 回归

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | backend **368 / 368**、frontend **16 / 16**，0 fail |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm guard` | **8 / 8** |
| `smoke:phase4`（微信登录 / 收消息 / 回复 / 主动消息送达微信） | **PHASE 4 SMOKE OK**（未受影响） |

过程中被抓到并修掉的两个问题（都不是产品缺陷，但值得记录）：

1. **架构守卫 ARCH-1/ARCH-4 抓到我**：意图识别里写了平台字样，被判定"Core 不得认识具体平台"。改成"渠道只是不透明字符串"，由应用层通用解析 → 守卫回到 8/8。
2. 新测试的头几次失败都在**测试自身**：测试容器默认只有内置 echo（必须显式配 provider 与路由）；网页发消息接口只回最近 4 条消息（断言要看会话落库，而不是接口返回）。

---

## 12. REAL WEB 是否通过

**通过**：真实模型解析 → 建 job → 到点由 scheduler 发出 → 消息落库并被 AI 在后续对话中正确引用（§11 三段真机记录）。

## 13. REAL WEIXIN 是否通过

**投递侧通过（真机）**：定时消息确实经既有微信链路发到了绑定账号（`delivered=true`，会话里能看到原文）。

**还差最后一小步才全绿**：在微信里对机器人说"1分钟后给我发消息，这是微信测试"，让**微信入站 → 意图识别 → 建 job → 手机收到**整条真机链路跑通。该路径目前由 mock 全链路测试覆盖（Test F 就是微信会话 + 真实 pipeline），且与网页完全共用同一段代码。要补这一条，你在微信里发一句话即可，我可以立刻核对日志。

---

## 14. 修改文件

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/services/schedule-time.ts` | 新增：纯时间解析（delay / clock / daily）、本机时区、本地时间格式化 |
| `backend/src/core/services/schedule-intent.ts` | 新增：LLM 结构化意图识别（便宜前置过滤 + 严格校验 + 失败退化为 none） |
| `backend/src/core/services/scheduled-message-service.ts` | 新增：schedule / listPending / cancelLatest / cancel（唯一建 job 的入口） |
| `backend/src/core/services/messaging-pipeline.ts` | 新增 `planScheduledAction` + `appendConfirmation`；两条入站路径（普通 / 流式）都接上；定时轮次跳过记忆抽取；新增依赖 `scheduleIntent` / `scheduledMessages` / `messages` / `clock` |
| `backend/src/core/context/context-engine.ts` | 最近对话里把 `source=proactive` 标成"（主动消息）"；系统提示补充"你可以定时发消息" |
| `backend/src/app/bootstrap.ts` | 创建并注入意图识别 / 定时消息服务；提前创建 scheduler；注册 `scheduled_message` handler（按原文写库 + 出站，支持用户点名渠道时的通用重定向） |
| `backend/src/api/routes/scheduler.ts` | job kind 白名单加入 `scheduled_message` |
| `backend/test/integration/scheduled-message.test.ts` | 新增 7 条集成测试 |

未改动：Scheduler 语义、Proactive 策略、Memory 抽取规则、Relationship / Emotion、媒体 / ASR / TTS、微信渠道收发链路、ModelRouter。

---

## 15. 已知限制

1. **多一次模型调用**：意图识别在命中前置关键词后才会调用（`taskType=proactive`，走便宜档）。
2. **跨渠道**：在网页说"发微信给我"时，只有当你已经有一个该渠道的会话才会切换投递目标，否则发回原会话并记日志；不会自动建会话。
3. **时区**按运行机器的本机时区解释并记录在 job 上；多人 / 服务器部署需要真正的"每用户时区"设置（当前设计没有）。
4. **幂等**：`once` job 执行后会被调度器禁用，出站带 `scheduled:<jobId>` 幂等键；但网页渠道本身不做去重，极端情况（手动 run 与 tick 同时）可能重复发一次。
5. **"每天 X 点"不受主动消息策略约束**（用户显式要求），因此不占每日上限、不看静音时段。
6. 定时消息不进长期记忆（该轮抽取被跳过），但作为角色消息留在会话历史里，下一轮对话能看到。



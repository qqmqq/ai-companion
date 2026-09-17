# 自然语言 → 事件 / 任务 / 定时消息 报告

日期：2026-09-16 ｜ 范围：只做「自然语言 → 结构化意图 → 应用服务 → 后台持久化」。未进入 Phase 6，未做 Browser/Agent/Live2D/Voice Clone，未重构 Scheduler/Proactive/Memory/Relationship/Emotion，未新建 Tool/Agent 框架。

结论：

- **EVENT_RECOGNITION = VERIFIED**（真机：明天下午3点有客户会议 → `events` 落库）
- **TASK_RECOGNITION = VERIFIED**（真机：今天把论文完成 → `work_tasks` 落库，title=完成论文）
- **SCHEDULE_RECOGNITION = VERIFIED**（真机：一分钟后提醒我带伞 → `scheduled_jobs` 落库并在 60 秒后送达）
- **BACKGROUND_PERSISTENCE = VERIFIED**（三类对象分别落到三张表，数据库逐条核对过）
- **REAL_WEB = VERIFIED**（真实网页链路全程跑通）
- **REAL_WEIXIN = VERIFIED**（真机：在微信里发「…提醒我带伞」→ 系统建 job(channel=weixin) → 到点真的发到手机；见 §15）
- **NO_FALSE_CONFIRMATION = VERIFIED**（失败/未建对象时绝不给成功回执）

---

## 1. 根因

上一轮只接通了**定时消息**这一种意图，事件与任务根本没有链路：

| 层 | 修复前 | 修复后 |
| --- | --- | --- |
| 意图识别 | 只有 schedule 一种动作（`schedule-intent.ts`） | 一个通用解析器 `action-intent.ts`：schedule_message / create_event / create_task / cancel / query / needs_clarification / none |
| 应用服务 | 只有 `ScheduledMessageService` | 新增 `AssistantActionService`：事件走 EventService、任务走 TaskService、定时消息走 ScheduledMessageService |
| 持久化 | 只会写 `scheduled_jobs` | `events` / `work_tasks` / `scheduled_jobs` 各归各表 |

也就是说：**"Chat → structured intent → application service" 这一层只覆盖了 1/3**。模型能理解"明天开会"，但没有任何代码路径把它变成 `events` 行。

另外还抓到两个具体缺陷（都在本轮修掉）：
1. 前置过滤漏词：「今天把论文完成」里的"完成"没在关键词表里 → 这句话根本不进模型（和上一轮"分钟之后"是同一类问题）；
2. 事件/任务缺具体钟点被当成"时间说不清" → 反问用户；实际上应当用默认时间（今天 23:00）并在回执里写明。

## 2. 当前聊天链路（修复后）

```
用户消息（网页 / 微信同一条 pipeline）
  ↓ 便宜前置过滤（提醒/安排/会议/完成/待办/查询… 才继续）
  ↓ ActionIntentDetector：ModelRouter(taskType=proactive) → 模型 → 受约束 JSON
  ↓ 应用层严格校验（时间范围、标题、范围词）
  ↓ AssistantActionService
      create_event     → EventService.create()  → events
      create_task      → TaskService.create()   → work_tasks
      schedule_message → ScheduledMessageService.schedule() → Scheduler.createJob() → scheduled_jobs
      cancel / query   → 读/改上面三类对象
  ↓ 只有成功才把**系统回执**追加到回复末尾；失败给"没有成功创建"的话术
  ↓（动作轮次不做记忆抽取）
```

模型全程不接触数据库、不接触渠道；出站仍然只走渠道适配器。

## 3. 新增的 intent/action 层

- `core/services/action-intent.ts`：意图 + 实体（when / title / message / target / range / channel）；拿不准返回 needs_clarification；任何解析失败退化成 none（不会把聊天搞坏）。
- `core/services/assistant-action-service.ts`：唯一写入入口，三类对象分别落到三张表，失败返回 `ok:false` + 诚实话术。
- 日志（§二十四）：`intent.detected`、`event.created`、`task.created`、`schedule.create`、`action.cancel`，字段只有 id / 时间 / 渠道，**不含任何凭据**。

## 4. Event 创建流程（将要发生的事）

`create_event` → `EventService.create({ type: "future_plan", title, dueAt: 解析后的时间, source: "conversation", metadata: { conversationId, createdFrom: "chat_action", timezone } })`。
写入 `events`；状态 `planned`；**不写 scheduled_jobs**。既有的事件效果（提前 12 小时派生提醒任务）保持不变，所以事件还会自动带来一条 `event_reminder` 性质的工作项。

## 5. Task 创建流程（要去做的事）

`create_task` → `TaskService.create({ kind: "custom", executeAt: 解析后的时间（缺钟点则今天 23:00）, payload: { title, dueAt, conversationId, source: "user_request", timezone }, priority: 4 })`。
写入 `work_tasks`（沿用既有 schema，**没有新增列**；标题放在 `payload.title`，前端「事件与任务」页现在显示这个标题）。

## 6. Schedule 创建流程（未来由系统主动发消息）

`schedule_message` → `ScheduledMessageService.schedule()` → `Scheduler.createJob()` → `scheduled_jobs`（`once` / `cron_like`）。渠道跟随会话（网页→web，微信→weixin）。到点由既有 `scheduled_message` handler 按**原文**写库（`source = proactive`）并经 `ProactiveOutbound` 发送。

## 7. Cancel 流程

`cancel` + `target`（schedule / event / task / any）→ 取消**最近的一条**：提醒走 `Scheduler.setEnabled(false)`（保留记录）、任务走 `TaskService.cancel()`、安排走 `EventService.cancel()`。没有找到就如实说"没有找到可以取消的提醒或安排"。

## 8. Query 流程

`query` + `range`（today / tomorrow / all）→ 读 `events`（planned/active 且 dueAt 在范围内）、`work_tasks`（pending）、`scheduled_jobs`（待发），由应用层拼成中文清单追加到回复里（模型不查库）。

## 9. 时间 / 时区处理

- 相对时间（"一分钟后"/"半小时后"）→ now + 秒数；
- 绝对时间（"明天下午3点"/"今天晚上8点"）按**本机时区**换算；已过去的"今天 X 点"顺延到明天；
- "下周一"这类 → `day=weekday` + `weekday(1..7)`，**没给钟点时默认 09:00**；事件/任务没给钟点时默认**今天 23:00**，并在回执里写明具体时间，用户可纠正；
- 时区名（真机 `<本机时区>`）写进对象元数据；没有硬编码 UTC；
- 时间说不清（"晚点提醒我"）→ 只反问，绝不猜。

## 10. 与 Memory 的边界

事件 / 任务 / 提醒**不进 Memory**：这三类是"要发生/要做/要发"的结构化对象；动作轮次被显式跳过记忆抽取（`extraction = "off"`），只有真正的长期个人事实才会走既有记忆管线。

## 11. 与 Relationship / Emotion 的边界

本轮没有触碰关系与情绪逻辑：创建事件/任务/提醒只写各自的对象表；回复本身仍按既有规则触发原有的反应阶段（那是既有行为，没有新增任何情绪系统）。

---

## 12. 修改文件

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/services/action-intent.ts` | **新增**：通用动作意图解析（事件/任务/定时/取消/查询 + 澄清），含放宽的前置过滤与严格校验 |
| `backend/src/core/services/assistant-action-service.ts` | **新增**：唯一写入入口，分派到 EventService / TaskService / ScheduledMessageService，失败给诚实话术 |
| `backend/src/core/services/schedule-time.ts` | 支持 `day=weekday`（下周一）；日期缺钟点时默认 09:00 |
| `backend/src/core/services/messaging-pipeline.ts` | 计划器改为 `planActions()`，按意图分派；动作轮次跳过记忆抽取；保留防假确认兜底 |
| `backend/src/core/services/schedule-intent.ts` | **删除**（被 action-intent.ts 取代） |
| `backend/src/core/context/context-engine.ts` | 系统提示：提醒/待办/日程/取消/查询都由系统负责，模型不要自己承诺、也不要声称做不到 |
| `backend/src/app/bootstrap.ts` | 构造并注入 action intent + action service；`taskService` 提前创建（动作服务依赖它） |
| `frontend/src/lib/types.ts`、`frontend/src/pages/timeline.tsx` | 任务列表显示 `payload.title`（自然语言建的待办在界面上看得见） |
| `backend/test/integration/scheduled-message.test.ts` | 扩到 **16 条**：新增事件、任务、查询、取消任务、情绪闲聊不误判等用例 |

未改动：Scheduler 语义、Proactive 策略、Memory 抽取规则、Relationship/Emotion、媒体/ASR/TTS、微信收发链路、ModelRouter。

---

## 13. 测试结果

### 集成测试（`scheduled-message.test.ts`，16 / 16 全绿）

| 用例 | 断言 |
| --- | --- |
| Test 2 事件 | 「明天下午3点有客户会议」→ `events` 恰好 1 条、title/类型/状态正确、dueAt = 明天 15:00、且**没有**写入 scheduled_jobs |
| Test 3 任务 | 「今天把论文完成」→ `work_tasks` 1 条、kind=custom、status=pending、payload.title=完成论文、executeAt 小时数正确、events/jobs 都为空 |
| Test 4 取消 | 取消任务 → `status = cancelled` + 回执 |
| Test 5 查询 | 问"明天有什么安排" → 用真实数据回答（含既有事件派生的提醒任务） |
| Test 6 不误判 | 「我今天真的很累，明天还要上班」→ 三类对象都不产生 + 回复原样不带回执 |
| 定时消息 | 建 job / 到点按原文发送（source=proactive）/ 上下文标记「（主动消息）」/ 网页微信不串频道 / 并发两次=两条 job |
| 失败安全 | 让 scheduler 抛错 → 回复"没有创建成功"，绝无成功回执 |
| 防假确认 | 模型自己承诺"一分钟后我发你"但没建成 → 追加诚实更正 |
| 澄清 | 时间说不清 → 只反问，不建任何对象 |

### 回归

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | backend / frontend 全绿（最终值见 §17） |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm guard` | 8 / 8 |
| 12 个 smoke | 全部 PASS（串行重跑） |

---

## 14. REAL WEB 测试（真实运行，非 mock）

在网页聊天里逐条发送，随后**直接查数据库**：

| 输入 | 意图（日志） | 数据库结果 |
| --- | --- | --- |
| 一分钟后提醒我带伞 | `schedule_message` delay | `job:kc4vbet3h` runAt=+60s channel=web msg=提醒我带伞 → **14:58:20 真的送达**（会话里出现 `source=proactive` 的「提醒我带伞」） |
| 明天下午3点有客户会议 | `create_event` clock | `events`：客户会议 / future_plan / planned / due=2026-09-17T07:00:00Z（= 北京时间明天 15:00） |
| 今天把论文完成 | `create_task` | `work_tasks`：kind=custom / payload.title=完成论文 / executeAt=15:00Z（= 北京今天 23:00）/ pending |
| 我明天有什么安排？ | `query` tomorrow | 回复列出：1) 安排：客户会议（明天 15:00） 2) 任务：…（真实数据，不是模型回忆） |
| 5分钟后提醒我提交周报 → 取消刚才的提醒 | `schedule_message` → `cancel` | `job:xywwhjg86w` 建后立刻 `enabled=false`，回执"原定 23:06 的提醒已经取消了" |
| 我今天真的很累，明天还要上班 | `none` | 三类对象**都没有**新增，回复就是普通聊天 |

## 15. REAL WEIXIN 测试

**投递侧（真机）**：微信会话上通过同一条链路下发的定时消息确实经 `WeixinChannel` 发到了绑定的手机微信（本日三次：11:14「示例提醒」、14:31「一分钟之后给你发消息（微信自动消息测试）」、本次 `job:entwmecfbi`「提醒我带伞（示例）」），均 `delivered=true`，会话里能看到 `source=proactive` 的原文。

**意图侧（真机已验证）**：你在手机微信里发出的那句定时要求走完了整条链路 ——

```
16:19:12  inbound message received        channel=weixin  ref=<对方 id>@im.wechat
16:19:14  intent.detected                 intent=schedule_message whenKind=delay
16:19:14  schedule.create                 job:b7sagqc74u  channel=weixin  runAt=16:21:14  tz=<本机时区>
16:19:15  inbound reply generated (70 字) + delivered to channel
16:22:08  schedule.deliver                delivered=true   ← 真的发到了手机微信
```

同一天更早还有一条同样来自微信的定时消息（`job:nhyys63nrf`，16:18:58 建 → 16:19:27 `delivered=true`）。
也就是说：**微信里说一句话 → 后台建对象 → 到点手机收到**，这条真机链路是通的。

---

## 15.1 一条必须记录的环境事件：后端进程崩溃过一次

在 16:19:27 左右（刚完成一次微信入站 + 一条定时消息投递之后），后端进程以 **exit status 3221226505（0xC0000409 = STATUS_STACK_BUFFER_OVERRUN / fail-fast）** 退出：没有 JS 异常栈，也没有 Application Error 事件日志，属于 V8/原生层的硬中止。同一天 Vite 开发服务器也出现过同一个退出码。

影响面：**数据没有损坏**，任务没有丢 —— 崩溃时那条刚由微信创建的定时消息（`job:b7sagqc74u`）仍在库里且 `enabled=1`；重启后调度器按 `misfirePolicy: run_once` 在 16:22:08 补发成功（`delivered=true`）。也就是说崩溃恢复路径本身是有效的。

本次没有修复它（不在本任务范围，且没有 dump 无法定位到具体模块）；新进程内存约 90 MB / 正常运行。**建议继续观察**：如果再次出现，需要抓 dump 或用 `node --report-on-fatalerror` 才能定位。

## 16. 已知限制

1. 意图识别多一次便宜档模型调用（只有命中前置关键词才调用）；模型偶尔会在自然语言里多说一句（例如"我这边没收到取消的结果"），但**系统回执**始终是权威结果，已通过提示词让模型不要否认系统能力。
2. 事件/任务缺具体钟点时用默认时间：当天 23:00（如果当天 23:00 已过则用明天 09:00，避免"一建出来就过期"）；"下周一"这类为 09:00。回执里会写明具体时间，用户可纠正。
3. `work_tasks` 是既有对象（原本承载系统要执行的工作项），用户待办以 `kind=custom` + `payload.title` 承载；它更像"到点提醒的待办"，不是完整 todo 应用（没有子任务/优先级 UI）。
4. 取消只处理"最近一条"，没有实现完整任务管理器（按任务书要求最小）。
5. 时区按运行机器本机时区解释并记录；多用户/服务器部署需要每用户时区设置。

---

## 17. 最终回归数值（本轮收尾时实测）

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | backend **377 / 377**、frontend **16 / 16**，0 fail |
| `pnpm typecheck` | exit 0（backend + frontend） |
| `pnpm build` | exit 0 |
| `pnpm guard` | **8 / 8** |
| 12 个 smoke（串行） | `smoke` / `phase3` / `phase4` / `45b` / `45c1` / `45c2` / `45c3` / `45d1` / `45d2` / `45d3` / `45d4` / `45e` **全部 PASS** |

如实记录环境型偶发（不是本次改动引起）：机器上同时跑着真实后端、Vite、以及十多个历史 node 进程时，出现过三次互不相同的失败 —— `weixin-channel.test.ts` 的去重用例、以及 `tts-provider` / `asr-provider` 的时序断言。
逐一单独重跑都通过（15/15、13/13），清理掉残留测试进程后整套重跑 **377 / 377** 通过。这些用例都依赖 mock HTTP 服务与端口/时序，属于既有的资源争用型偶发；本次没有触碰微信收发、媒体、ASR/TTS 任何代码。



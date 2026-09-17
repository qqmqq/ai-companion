# Chat → Schedule 执行链路修复报告

日期：2026-09-16 ｜ 范围：只修「AI 说会定时发送，但后台没有任务」。未进入 Phase 6，未新增 Agent/Browser/Live2D，未改 Scheduler/Proactive 结构，未动微信收发与 Memory/Relationship/Emotion/Media/ASR/TTS。

结论：

- **CHAT_TO_SCHEDULE_ACTION = VERIFIED**
- **SCHEDULED_JOB_CREATION = VERIFIED**（数据库里真的出现了 job）
- **WEB_AUTO_MESSAGE = VERIFIED**（到点自动发到网页，DB 有据）
- **WEIXIN_AUTO_MESSAGE = VERIFIED**（到点自动发到微信，DB 有据）
- **NO_FALSE_CONFIRMATION = VERIFIED**（失败时说实话；模型自己承诺也会被更正）

---

## 1. 根因

用户原话是：**「一分钟之后给我发消息」**。两个缺陷叠加，正好让这条消息"看起来被理解、实际什么都没发生"：

### 缺陷 1（真凶）：便宜的前置过滤器漏了这种说法

上一轮我加了一个"命中关键词才调用模型"的前置过滤，正则里只有 `分钟后`：

```ts
/(提醒|定时|闹钟|叫我|叫醒|分钟后|小时后|秒后|点钟|点半|...)/i
```

实测（跑过一遍对照）：

```
NO-MATCH  一分钟之后给我发消息      ← 用户这句话根本没进模型
MATCH     1分钟后给我发消息，这条消息是测试
NO-MATCH  一分钟以后给我发消息
```

所以 `detect()` 直接返回 `none`，**一个 job 都不会建**。

### 缺陷 2：提示词让模型可以"空口承诺"

上一轮我在系统提示里写了"你可以定时/延迟发消息……只要自然确认即可"。于是模型在没有真实动作的情况下照样回答"一分钟后我发你"——**文字承诺 + 后台零任务**，正是你看到的现象。

这两条必须一起修：过滤器漏 → 不建任务；提示词放权 → 假确认。

---

## 2. 为什么 AI 只回复文字

因为"生成回复"和"创建任务"是两件独立的事，而当时只有前者被触发：

| 环节 | 修复前 | 修复后 |
| --- | --- | --- |
| 判断是不是定时请求 | 命中关键词才进模型；「分钟之后」漏网 → 判为普通聊天 | 过滤器放宽（分钟/小时/秒 + 之后|以后|之内、待会/晚点/稍后/一会儿、点钟/点半/整…），判断交给模型 |
| 产生结构化动作 | 无（只是自然语言） | 模型输出受约束 JSON 意图，应用层解析 |
| 创建 job | 不会被调用 | `ScheduledMessageService.schedule()` → `Scheduler.createJob()` |
| 回复里的"我发你" | 模型自己编的承诺 | 只有 job **创建成功**后才由系统追加回执；模型不再自己承诺 |

---

## 3. 哪个链路没有接通

**没接通的是"意图过滤 → 意图解析"这一跳**，后面几跳上一轮已经接好并验证过。
证据：同一句话换个说法（「1分钟后…」）就能建 job；而「一分钟之后…」在修复前的检测计数里 `intentCalls = 0` —— 模型**根本没被问过**，所以谈不上"模型理解但没执行"，是**我们没让它进入这条链路**。

（另外，模型那句承诺是纯自然语言，任何"文字回复"都不等于"动作已发生"——这正是本次新增防线的意义。）

---

## 4. 使用了哪个现有 Scheduler service

没有新增第二套调度，全部复用：

| 复用对象 | 用途 |
| --- | --- |
| `Scheduler.createJob()` | 写 `scheduled_jobs`（`triggerType = once` / `cron_like`） |
| `Scheduler.setEnabled()` | 取消（置 `enabled = false`，保留记录） |
| `SchedulerRunner` | 仍然是应用层每 60 秒 tick |
| `ScheduledJobRepository` | 唯一持久化出口（没有任何地方直接写 SQL） |
| `MessageWriter` / `ProactiveOutbound` | 到点写库（`source = proactive`）与出站 |

---

## 5. schedule action 如何产生

模型通过既有 `ModelRouter`（`taskType = "proactive"`，便宜档）输出受约束 JSON：

```json
{"action":"schedule_message","when":{"kind":"delay","seconds":60},"message":"…","channel":null}
```

`{"action":"cancel_scheduled_message"}` / `{"action":"list_scheduled_messages"}` / `{"action":"needs_clarification"}` / `{"action":"none"}` 也是合法输出。
解析在应用层完成并严格校验（秒数范围、小时 0–23、消息长度上限）；**模型永远不接触数据库**，也不可能直接调用微信 HTTP。
时间说不清 → `needs_clarification` → 只反问，不建任务。

---

## 6. 如何创建 scheduled_job

`ScheduledMessageService.schedule()`（Core 服务，唯一入口）→ `Scheduler.createJob()`：

```ts
createJob({
  userId, characterId,
  kind: "scheduled_message",
  triggerType: "once",
  runAt,                       // 本地时间解析后的 ISO
  nextRunAt: runAt,
  misfirePolicy: "run_once",   // 关机错过 → 回来补发一次
  payload: { message, channel, conversationId, conversationRef, accountId, timezone, requestedAt, requestedChannel },
})
```

**渠道跟随会话**：网页会话 → `channel = web`（真机实测 `channel=web`）；微信会话 → `channel = weixin`。用户没点名渠道时绝不默认走微信。

---

## 7. 任务创建成功后的确认方式

顺序严格是"先动作、后确认"：

1. 解析意图 → 2. **创建 job（成功）** → 3. 生成回复 → 4. 系统在回复末尾追加确定性回执：

```
好的，22:28 我会发你：「这是一条定时提醒用户消息」。
```

这条回执是**系统写的**（不是模型自由发挥），因此不可能出现"回复说建好了、实际没建"的情况。

## 8. 任务创建失败后的行为

- 创建抛错 → 回执变成：**「我理解你要定时，但这次定时任务没有创建成功，请再说一次，我重新设置。」**（绝不输出成功文案）；
- 另外加了一道防线：如果用户明确要求了定时、这一轮**没有**任何动作，而模型的回复又在承诺"X 分钟后发你"，系统会追加更正：**「（这条定时请求没有真正建立，你可以再说一次，我重新设置。）」**；
- 提示词也从"你可以定时发消息"改成"定时由系统负责，你只要自然回应，**不要自己承诺时间**"。

---

## 9. Web 实测结果（真实运行，不是 unit test）

输入就是用户那句话：**「一分钟之后给我发消息」**（网页聊天，真实 DeepSeek）。

**① 发送后立刻查数据库（§九 要求）**

```
JOB: id=job:77m3ew6ken  status=idle  enabled=1  runAt=2026-09-16T14:28:38.822Z
     channel=web  conversationId=01a0aa9d-b724-7c15-9d37-71fd299e55c0
     msg=这是一条定时提醒消息
MSG: character | ……嗯。（+ 系统回执）好的，22:28 我会发你：「这是一条定时提醒消息」。
MSG: user      | 一分钟之后给我发消息
```

> 注：调度器自己的状态枚举里没有 `pending` 字样，等价状态是 `enabled = 1 && status = idle`（= 待发）；执行后变成 `enabled = 0`。

**② 等待到点，验证真的自动发送（数据库为准）**

```
t=14:28:07  job.status=idle  enabled=1  lastRunAt=null   deliveredRows=0
t=14:29:27  job.status=idle  enabled=0  lastRunAt=2026-09-16T14:29:22.590Z  deliveredRows=1
  DELIVERED: 这是一条定时提醒消息   source=proactive   at=2026-09-16T14:29:22.591Z
```

即：**任务存在 → 到点被调度器执行 → 消息按原文落库并送达网页**，整个状态迁移在数据库里可见。

## 10. Weixin 实测结果

同一个 `scheduled_message` handler、同一段出站代码，渠道由会话决定。真机证据（真实 `WeixinChannel` → 手机微信）：

```
14:30:41  创建 job:2i4gojkgi3（channel=weixin, conversationRef=<对方 id>@im.wechat）
14:31:22  job.enabled=1 → 0   lastRunAt=2026-09-16T14:31:22.607Z
          DELIVERED: 一分钟之后给你发消息（微信自动消息测试）  source=proactive
（同一路径早前还成功发过一条「示例提醒」：11:14:11 delivered=true）
```

**必须区分的部分**：微信**投递**是真机验证（`WeixinChannel` 真的发出去了）；"在微信里说一句话 → 自动建 job"这一段，代码与网页完全共用（同一 messaging-pipeline），在本轮由 mock 全链路测试覆盖（见 §12 的 Test F），真机侧需要你在微信里发一句才能标全绿。

## 11. 数据库实际 job 结果

| 场景 | 数据库证据 |
| --- | --- |
| 「一分钟之后给我发消息」（本轮修复重点） | `job:77m3ew6ken`，`enabled=1`，`runAt=14:28:38`，`channel=web` → 14:29:22 执行并落库 `source=proactive` |
| 微信定时消息 | `job:2i4gojkgi3`，`channel=weixin` → 14:31:22 执行并落库 `source=proactive` |
| 重复请求（并发） | 两次相同请求 = 两条独立 job（测试断言） |
| 取消 | `enabled=1 → 0`，记录保留 |

## 12. 测试结果

### 新增/加强的集成测试 `backend/test/integration/scheduled-message.test.ts`（11 条，全绿）

| 用例 | 断言 | 对应任务书 |
| --- | --- | --- |
| **回归：说「一分钟之后给我发消息」也必须真的建 job** | `intentCalls = 1`（不再被过滤器挡掉）+ 建出 1 条 job + 有回执 | Test 1 / Test 2 / Test 3 |
| Test A | 意图 → 建 job → 回执含"好的"与原文；`channel=web`；`runAt` 在 60 秒内 | Test 1–3 |
| Test B | 到点执行 → 会话里出现 `source=proactive` 且**逐字**原文 | Test 4 / Test 5 |
| Test C | 上下文出现被标记"（主动消息）"的定时消息 | Test 5 |
| **Test 6：创建失败必须说实话** | 让 `scheduler.createJob` 抛错 → 回复含"没有创建成功"，**不含**成功回执，且没有 job | Test 6 |
| **防假确认** | 意图 none + 模型自己说"一分钟后我发你" → 追加更正；没有 job | 任务书 §四 / §十六 |
| Test F | 网页/微信各一条 job，`channel` 正确；执行微信 job 不会写进网页会话 | Test 7 / Test 8 |
| 并发 | 两次相同请求 = 两条独立 job | §十八 |
| Test E | "取消刚才的提醒" → `enabled=false` + 回执 | §十五 |
| 澄清 | 时间说不清 → 不建 job + 反问 | §十四 |
| 普通聊天 | 不受影响：不加回执、不建 job、记忆抽取照常 | §十六 |

### 回归

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | backend **372 / 372**、frontend **16 / 16**，0 fail |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm guard` | **8 / 8** |
| 12 个 smoke | 见下方说明（全部通过） |

最终"串行、无并发"重跑结果（12 / 12 全绿）：

```
smoke -> True            smoke:phase45c1 -> True     smoke:phase45d2 -> True
smoke:phase3 -> True     smoke:phase45c2 -> True     smoke:phase45d3 -> True
smoke:phase4 -> True     smoke:phase45c3 -> True     smoke:phase45d4 -> True
smoke:phase45b -> True   smoke:phase45d1 -> True     smoke:phase45e -> True
```

如实记录一次误报：第一遍扫 smoke 时 `phase45c1`、`phase45d2` 报了失败；单独重跑**两条都 OK**，原因是这些 smoke 用固定端口（3548/3549、4540/4541），而当时机器上同时跑着完整测试与真实后端 + 我用于轮询数据库的脚本，属于环境争用/端口占用，**与本次改动无关**（本次没有触碰媒体链路）。

---

## 13. 修改文件

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/services/schedule-intent.ts` | **放宽前置过滤**（覆盖「分钟/小时/秒 + 之后/以后/之内」、「待会/晚点/稍后/一会儿」、「点钟/点半/整」等说法） |
| `backend/src/core/context/context-engine.ts` | 系统提示改写：定时由系统负责，模型**不得自己承诺时间**，也不要说做不到 |
| `backend/src/core/services/messaging-pipeline.ts` | 创建失败时返回"没有创建成功"的诚实回执；新增 `applyScheduledOutcome()` 与 `looksLikeSchedulePromise()` 防假确认；两条入站路径统一走它 |
| `backend/test/integration/scheduled-message.test.ts` | 新增 4 条测试（用户原话回归、创建失败、防假确认、并发），共 11 条 |

未改动：Scheduler 语义、Proactive 策略、微信收发、Memory/Relationship/Emotion/Media/ASR/TTS、ModelRouter。

---

## 14. 已知限制

1. 前置过滤放宽后，个别普通闲聊（含"稍后/一会儿"）会多一次便宜档模型调用；模型会返回 `none`，不影响回复内容。
2. 用户没给内容时，系统用一句通用指令（如"到点了，主动跟对方说句话。"）作为 job 内容；真机这轮模型自己给出了"这是一条定时提醒消息"这种通用内容，符合"不要凭空编造很具体的内容"。
3. 时区按运行机器本机时区解释并记录（真机为 `<本机时区>`）。
4. `once` job 执行完会被调度器禁用；出站带 `scheduled:<jobId>` 幂等键，但网页渠道自身不做去重。


---

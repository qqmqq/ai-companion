# 动作持久化 + 角色化回复 报告

日期：2026-09-16 ｜ 范围：只做两件事——核实"事件/任务/定时消息"是否真的持久化，以及把动作确认从固定模板改成**角色人设自然表达**。未进入 Phase 6，未做 Browser/Agent/Live2D/Voice Clone，未重构 Scheduler/Proactive/Memory/Relationship/Emotion/Weixin。

最终结论（基于本次真实运行重新判定，不沿用旧报告）：

- **EVENT_PERSISTENCE = VERIFIED**
- **TASK_PERSISTENCE = VERIFIED**
- **SCHEDULE_PERSISTENCE = VERIFIED**
- **CHARACTERIZED_ACTION_RESPONSE = VERIFIED**
- **NO_FALSE_CONFIRMATION = VERIFIED**
- **REAL_DATABASE_READBACK = VERIFIED**

---

## A. Event 问题：数据库到底有没有保存

**结论：保存了。** 我直接查了正在运行实例用的那个 SQLite 文件（`backend/data/companion.db`，WAL，迁移 001–007 全部就位，单用户单角色），并做了一次干净复现：

```
输入「明天下午3点有客户会议」→ 立即读库：
events: { id, user_id=01a0a66f-…, character_id=01a0a8b9-…, type=future_plan,
          title=客户会议, status=planned, due_at=2026-09-18T07:00:00Z(=北京明天15:00) }
```

之前的"events 表是空的"不是"没保存"，而是**事件被删掉了**：全代码库里能删事件的只有一条路——`DELETE /api/events/:id`（前端「事件与任务」页的「删除」按钮，且**没有确认弹窗、也不写审计**）。本次已加固：
1. 前端删除事件前加 `confirm()` 确认；
2. `DELETE /api/events/:id` 写一条审计 `event.deleted`（以后删没删、什么时候删的，都查得到）。

事件生命周期也正确：新建后是 `planned`，不会立刻 completed/expired；`type=future_plan` 用的是既有字段，**没有**误建成 scheduled_job。

## B. Event 查询：后台 API 能否重新读到

**能。** 创建后立即 `GET /api/events` → 返回 `[{title: 客户会议, dueAt: 2026-09-18T07:00:00Z}]`；前端「事件与任务」页在挂载时 `api.events()` 拉全量（不带角色过滤），刷新页面会重新拉取。

分类结论：不是 DATABASE_MISSING，不是 API_MISSING，也不是 FRONTEND_MISSING —— 是"可被误删 + 无审计"。

## C. Task：是否持久化

**持久化。** 「今天把论文完成」→ `work_tasks` 出现 `kind=custom, status=pending, payload.title=完成论文, executeAt=北京今天23:00`。
（之前有一次 executeAt 落在过去导致"一建出来就完成"，已修：无钟点时若"今天 23:00"已过则顺延到"明天 09:00"。）

## D. Schedule：是否持久化并执行

**持久化并执行。** 「一分钟后提醒我带伞」→ `scheduled_jobs`（channel 跟随会话：网页→web，微信→weixin）→ 到点由调度器把**原文**写库（`source=proactive`）并经渠道发出；真机今天多条都 `delivered=true`。

## E. Character Response：是否真正使用 CharacterVersion

**是。** 动作确认不再由后端拼固定字符串，而是把**动作事实**注入到角色生成回复的同一份上下文里（那份上下文本来就是按会话冻结的 `characterVersionId` 取 definition/personality/systemPrompt 的）。链路：

```
Action 执行 → 结构化结果(detail) → actionNote() 转成"[系统动作结果] 动作=… 状态=… 时间=… 内容=…"
→ 注入 ContextEngine(app_instructions 最前，P2 永不丢弃) → 角色 LLM 生成回复
```

真机两个完全不同人设、同一句话的对照：

| 输入（相同） | 角色 | 回复（不同） | 后台动作（相同） |
| --- | --- | --- | --- |
| 1分钟后提醒我带伞 | Aria（温柔） | "（点头）……好，记下了。到点提醒你。\n杯子都推到你面前了，顺手喝一口也不亏。" | scheduled_job 各一条，channel=web，runAt=+60s |
| 1分钟后提醒我带伞 | Kai（冷淡寡言） | "知道了。别催。" | 同上 |

两者后台动作**完全一致**，但自然语言确认**明显不同**，且都符合各自人设。

## F. Fixed Template 之前在哪里产生

旧实现：`messaging-pipeline.ts` 的 `planActions()` 直接用 `AssistantActionService` 返回的 `receipt` 字符串（例如"好的，X 我会发你：「…」"），再 `appendConfirmation()` 拼到回复末尾 —— 这就是那段固定模板。
本次移除：action 层仍返回结构化结果，但**回复里不再拼接任何固定话术**；`actionNote()` 只产出事实，措辞交给角色模型。

## G. 最终链路

```
User → Intent(action-intent) → Action Service(persistence) → ActionResult(detail)
     → actionNote(事实) → ContextEngine(注入 app_instructions) → Character LLM → Assistant Message
```

失败安全（NO_FALSE_CONFIRMATION）：
- 动作失败 → 注入"状态=失败"的事实，角色必须如实说没成功；若模型反而声称成功，`correctFalseSuccess()` 追加事实更正；
- 用户要求了定时但这一轮没建成、模型又自己承诺 → 追加"（这条定时请求没有真正建立…）"；
- 时间说不清 → 只问，不建任何对象。

## H. 实际测试（全部真实运行）

| 场景 | 结果 |
| --- | --- |
| Event：「明天下午3点有客户会议」 | events 落库 planned，GET /api/events 可读 |
| Task：「今天把论文完成」 | work_tasks 落库 pending，刷新仍在 |
| Schedule：「1分钟后提醒我带伞」 | scheduled_jobs 落库 → 到点送达（source=proactive） |
| Cancel：「取消刚才的提醒」 | **最近一条** pending 被禁用（修复了"取消了最快到点的那条"的 bug） |
| Normal Chat：「我今天真的很累，明天还要上班」 | 不产生 event/task/schedule |
| 两种角色 | 见 §E 对照表 |

## 修改文件

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/context/context-engine.ts` | `BuildContextInput.actionNote`；动作事实注入 app_instructions（最前、永不丢弃）；系统提示改为"系统负责动作、你负责自然表达" |
| `backend/src/core/services/conversation-service.ts` | `reply/streamReply/prepareChat/generate` 透传 `actionNote` |
| `backend/src/core/services/assistant-action-service.ts` | 导出 `actionNote(result)`：结构化结果 → 只含事实的系统说明；query 结果带 `detail.lines` |
| `backend/src/core/services/messaging-pipeline.ts` | `planActions` 返回 `actionNote`；移除固定模板拼接；`correctFalseSuccess()` 失败/假承诺兜底 |
| `backend/src/core/services/scheduled-message-service.ts` | `pendingJobs` 改为按**创建时间倒序**（"取消刚才的提醒" = 取消最近创建的那条） |
| `backend/src/api/routes/timeline.ts` | `DELETE /api/events/:id` 写审计 |
| `frontend/src/pages/timeline.tsx` | 删除事件前 `confirm()` |
| `backend/test/integration/scheduled-message.test.ts` | 16 条：改断言为"动作事实注入上下文 + 后台对象存在 + 无固定模板" |

## 回归

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | backend **377 / 377**、frontend **16 / 16**，0 fail |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm guard` | **8 / 8** |
| 12 个 smoke（串行） | 全部 PASS |

---

## 已知限制

1. `work_tasks` 承载用户待办（`kind=custom` + `payload.title`），到点会被既有任务执行器标成完成——它是"带时间的待办提醒"，不是完整 todo 应用。
2. 取消只处理"最近一条"。
3. 时区按本机时区解释并记录。
4. 意图识别多一次便宜档模型调用（前置关键词过滤后才调）。

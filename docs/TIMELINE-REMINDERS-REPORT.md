# 「事件与任务」页显示定时提醒

日期：2026-09-17 ・ 触发：用户反馈「事件与任务页面还是没有」

## 1. 先查清楚"没有"是什么

- Vite 正在服务的页面代码是新的（`timeline.tsx` 里有 `deleteTask`、`relationship.tsx` 里有 `deleteRelationshipChange`、`characters.tsx` 里有 `CharacterStudio`）；
- 审计日志显示 18:18 用户用新按钮删掉了 **7 个任务 + 1 个事件**，所以那页当时是空的；
- 关键：**定时提醒根本不在这一页**。提醒存的是 `scheduled_jobs`（kind=scheduled_message），而「事件与任务」页只读 `events` 与 `work_tasks` 两张表，提醒原本只出现在「主动消息 → 调度状态 → 高级」。

用户确认要的是：把这页也加上定时提醒。

## 2. 改动

| 文件 | 改动 |
| --- | --- |
| `frontend/src/pages/timeline.tsx` | 新增「定时提醒」分区：显示提醒原文、时间安排、上次发送、发到哪个渠道；每张卡可「停用 / 启用」「删除」（删除前确认） |
| `frontend/src/lib/types.ts` | `JobDto` 补上 `payload`（提醒原文与渠道本来就在里面，之前类型里没有） |
| `frontend/src/lib/labels.ts` | 新增渠道中文（`web→网页`、`weixin→微信`，认不出的一律「聊天里」）；`nextRunText` 改进：停用的任务显示「原本每天 22:00 执行 / 原本定在 …」，不再只给一个「—」，也不重复"已停用"三个字 |
| `frontend/src/lib/api.ts` | 新增 `deleteJob` |
| `backend/src/api/routes/scheduler.ts` | 删除调度任务：只允许删 `scheduled_message`；系统任务（主动消息 / 事件维护 / 任务执行）拒绝并说明原因；删除写审计 `scheduled_job.deleted` |

### 为什么加这个守卫

默认调度任务（每天 22:00 问候、每 30 分钟冷淡期检查、每 6 小时事件维护）的种子逻辑**只在"一条都没有"时才补**。删掉其中一条就再也回不来了 —— 主动消息会永久停摆。这类任务应该「停用」，不该「删除」。

系统任务不会被列在「事件与任务」页上（只列 `scheduled_message`），所以正常使用碰不到这条限制；守卫是防止误删。

## 3. 验证

### 真机（运行中的后端真实数据，只读检查，不点删除）

后端共 16 条调度任务，其中 13 条是用户定时提醒；页面渲染出「定时提醒（13）」，逐条显示中文说明，例如：

```
提醒我带伞（示例）  ● 已停用  原本定在 2026-09-16 23:09  上次发送：2026-09-16 23:10  发到：微信  [启用] [删除]
```

页面无报错；扫描 `scheduled_message / proactive_message / event_maintenance / cron_like / interval / once / idle / undefined` 全部未出现。

### 新增测试

| 测试 | 覆盖 |
| --- | --- |
| `frontend/test/timeline-reminders.test.mjs`（3 用例） | 提醒出现在这页、原文/渠道/时间都是中文、停用状态正确、系统任务不混进来、认不出的渠道有中文兜底、删除前有确认且删完计数跟着变、空状态给出"怎么加提醒"的提示 |
| `backend/test/integration/phase3-api.test.ts` | 用户提醒可以删（204）；**系统任务删除被拒（400）且拒绝后任务仍在** |
| `frontend/test/scheduler-labels.test.ts` | 补上"停用任务要说明原本安排"的断言 |

## 4. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 401 / 401 通过 |
| pnpm --filter @companion/frontend test | 34 / 34 通过（原 31 + 新增 3） |
| pnpm typecheck / build / guard | 0 / 0 / 8 通过 |

诚实说明：整轮第一次跑时 `asr-provider.test.ts` 挂了一个用例（`invalid_response` 得到 `network`），隔离跑该文件 6/6、与 TTS 一起跑 13/13 通过，属既有的并发抖动（mock 服务在负载下连接被归类成网络错误），与本次改动无关；重跑整套 401/401 通过。

## 5. 说明

- 那条「今天 12:00 去行政楼交材料」的提醒**仍然没建**（当初就因意图解析被截断而没建，见 `docs/ACTION-INTENT-TRUNCATION-FIX-REPORT.md`）。现在它不会再有"建了却不显示"的问题：建出来就会出现在这一页。
- 提醒到点后仍然按原渠道发送（微信的会发到微信），这一页只是把它列出来。

## 结论

| 判定 | 结果 |
| --- | --- |
| REMINDERS_VISIBLE_ON_TIMELINE | VERIFIED —— 真机上 13 条提醒全部列出，中文说明齐全 |
| REMINDER_ACTIONS | VERIFIED —— 停用 / 启用 / 删除（带确认）都作用于真实接口 |
| SYSTEM_JOBS_PROTECTED | VERIFIED —— 系统调度任务拒绝删除，且拒绝后仍然存在 |

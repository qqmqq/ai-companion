# Phase 3 开发报告

> 状态：**已完成**。遵循 `docs/AI-COMPANION-ARCHITECTURE-REPORT.md`（§10–§14、§22–§23、§27–§29）与 Phase 1/2 报告，未重新设计既有架构，未引入 OpenClaw，未实现微信渠道。
> 目标链路已真实跑通：**对话 → 记忆 → 关系 → 情绪 → 运行时状态 → 事件 → 任务 → 调度 → 主动策略 → 上下文 → 廉价模型 → 渠道发送**。

## 1. 修改/新增文件

### 新增（backend/src）
| 文件 | 作用 |
| --- | --- |
| `core/model/relationship.ts` | 关系六维 + 阶段 + 流水 + 里程碑 + RelationshipChange（唯一写入口的数据契约） |
| `core/model/emotion.ts` | 情绪状态（含 valence/arousal/energy/半衰期）、开放情绪标签、历史条目、EmotionChange |
| `core/model/event.ts` | 事件类型/生命周期（planned/active/completed/cancelled/expired）+ 过滤条件 |
| `core/model/work.ts` | WorkTask（工作项）——与"模型路由的 TaskType"明确区分 |
| `core/model/schedule.ts` | ScheduledJob / 触发类型 / misfire 策略 / 运行结果 |
| `core/model/proactive.ts` | ProactivePolicy、自主等级、静音时段、触发评估、决策审计、结果 |
| `core/ports/repositories.phase3.ts` | 六个新仓储端口（relationship / emotion / event / work-task / job / proactive-decision） |
| `core/ports/outbound.ts` | ProactiveOutbound 端口：Core 只说"发这条文本"，不认识渠道 |
| `core/ports/message-writer.ts` | 主动消息写库端口（begin/finalize，复用流式占位纪律） |
| `core/services/relationship-service.ts` | 关系读写、单次变化限幅、阶段计算、流水、里程碑、衰减 |
| `core/services/emotion-service.ts` | 情绪读写、确定性信号、可选模型分析、限幅、半衰期衰减、历史 |
| `core/services/character-state-service.ts` | 运行时状态唯一写入口（活动/地点/心情/日程/精力/计划/互动时间） |
| `core/services/event-service.ts` | 事件生命周期 + 到期过期 + 效果回调（效果由外部注入） |
| `core/services/task-service.ts` | 任务状态机、到期执行、失败重试、事件派生任务（幂等） |
| `core/services/proactive-service.ts` | 主动消息：触发评估 → 策略闸门 → 上下文 → 模型 → 发送 → 审计；含 dry-run |
| `core/services/proactive-message-writer.ts` | 主动消息占位/定稿写库实现 |
| `core/scheduler/scheduler.ts` | 纯 tick 调度器（到期判定、next_run_at 推进、misfire、失败隔离） |
| `core/scheduler/time-of-day.ts` | 本地时间窗 / 每日触发点计算（纯函数，可 FakeClock 测试） |
| `storage/migrations/003_relationship_emotion_event_scheduler.sql` | migration 003（见第 2 节） |
| `storage/repositories/{relationships,emotions,events,work-tasks,scheduled-jobs,proactive-decisions}.ts` | 六个仓储实现 |
| `app/outbound.ts` | 把 ProactiveOutbound 接到 ChannelRegistry |
| `app/scheduler-runner.ts` | 真实定时器（应用层）驱动 Core 的 `scheduler.tick()`，Core 保持无定时器 |
| `api/routes/{relationships,timeline,scheduler,proactive}.ts` | Phase 3 API |
| `test/helpers/fake-clock.ts` | FakeClock（set/advance/setLocal） |
| `test/unit/{relationship,emotion,event-task,scheduler,proactive}.test.ts` | Phase 3 单元与端到端测试 |
| `test/integration/phase3-api.test.ts` | Phase 3 API 端到端 |
| `scripts/phase3-smoke.ts` | 真实进程 / 真实 HTTP 冒烟 |

### 修改
| 文件 | 变更 |
| --- | --- |
| `core/model/character.ts` | 运行时状态新增 `mood`、`scheduleState`、`emotionState`（完整情绪） |
| `core/model/context.ts` | 新增分区 kind（proactive_intent / emotion_state / relationship_state / events）；bundle 与快照新增 `source`、`triggerReason` |
| `core/model/message.ts` | Message 新增 `source`（conversation / proactive / system） |
| `core/model/task.ts` | 模型路由新增 `emotion_analysis`（默认 cheap） |
| `core/ports/events.ts` | 领域事件新增 relationship/emotion/event/task/job/proactive/scheduler 名称 |
| `core/context/context-engine.ts` | 新增情绪/关系/事件/主动意图分区；优先级表重排；注入 Clock |
| `core/services/conversation-service.ts` | 全部时间戳改走注入 Clock；消息写入 source |
| `core/services/character-service.ts` / `summary-service.ts` / `memory/memory-service.ts` | 时间戳改走注入 Clock |
| `core/services/messaging-pipeline.ts` | 回复后新增"反应阶段"：运行时状态 → 情绪 → 关系 |
| `app/bootstrap.ts` | Phase 3 装配（时钟、服务、调度、任务处理器、事件效果、主动出站、默认调度任务） |
| `app/config.ts` | 调度器开关与间隔（`COMPANION_SCHEDULER_ENABLED` / `_INTERVAL_MS`） |
| `api/dto/mappers.ts` | 消息 DTO 暴露 `source`；快照 DTO 暴露 `source`/`triggerReason` |
| `frontend/**` | 新增关系与情绪页、事件与任务页、主动消息页（含调度状态与决策审计） |

## 2. migration 003

文件：`backend/src/storage/migrations/003_relationship_emotion_event_scheduler.sql`

- **messages（ALTER）**：`source TEXT NOT NULL DEFAULT 'conversation'`。
- **context_snapshots（ALTER）**：`source`、`trigger_reason`（用于区分普通回复与主动消息，并记录触发原因）。
- **relationships**：id、user_id、character_id→characters、六个维度（familiarity/trust/affection/intimacy/respect/dependence）、stage、created_at、updated_at；唯一索引 `(user_id, character_id)`。
- **relationship_milestones**：id、relationship_id、key、label、at；唯一索引 `(relationship_id, key)`（阶段跃迁只记一次）。
- **relationship_changes**：id、relationship_id、dimension、before_value、after_value、delta、clamped、reason、source、source_message_id、created_at —— 关系趋势与"限幅是否生效"的审计材料。
- **emotion_history**：id、character_id、user_id、before_json、after_json、reason、source、trigger_kind、source_message_id、conversation_id、intensity、created_at。
- **events**：id、user_id、character_id、type、title、description、status、importance、occurred_at、scheduled_at、due_at、completed_at、recurrence、source、source_message_id、metadata_json、created_at、updated_at；索引 `(status, due_at)`、`(character_id, occurred_at)`。
- **work_tasks**：id、user_id、character_id、kind、status、priority、payload_json、execute_at、attempts、max_attempts、started_at、finished_at、last_error、event_id→events、job_id、created_at、updated_at；索引 `(status, execute_at)`。
- **scheduled_jobs**：id、user_id、character_id、kind、trigger_type、run_at、cron_expr、interval_ms、next_run_at、last_run_at、enabled、status、misfire_policy、payload_json、created_at、updated_at；索引 `(enabled, next_run_at)`。
- **proactive_decisions**：id、user_id、character_id、conversation_id、job_id、trigger_kind、trigger_reason、decision、blocked_reason、autonomy、provider_id、model、message_id、context_snapshot_id、latency_ms、detail_json、created_at；索引 `(character_id, created_at)`、`(decision, created_at)`。

## 3. Relationship 架构

```text
模型 / 事件 / 用户手动
        ↓  RelationshipChange[]（只描述"想改什么"，不写数值）
   RelationshipService
        ├ 单次变化限幅 ±0.05（超出即 clamped=true）
        ├ 全局钳制 0..1
        ├ 阶段计算（六维加权）→ 跃迁时写里程碑
        ├ 全部变化写 relationship_changes 流水
        └ 更新 relationships
```

- 关系与记忆严格分家：记忆回答"发生过什么"，关系回答"我们现在是什么关系"。
- 阶段阈值（加权后）：stranger <0.15 ≤ acquaintance <0.3 ≤ friend <0.5 ≤ close <0.7 ≤ beloved；`familiarity>0.3 && trust<0.15` 直接判为 `strained`。
- 长期无互动 → `applyDecay` 向基线回落（默认 30 天后开始，最多一半幅度）。
- 重要记忆与事件通过 `source=event` 的关系变化影响关系，但**不是每条记忆都改关系**。

## 4. Emotion 架构

```text
消息
 ↓ 确定性信号（关键词/标点，0 成本）——命中即用
 ↓ 未命中且显式开启且长度足够 → task=emotion_analysis（廉价档）
EmotionChange → EmotionService（钳制 0..1 / -1..1）
 ↓
写入 emotion_history（before/after/reason/source/来源消息）
 + character_states.emotionState（完整状态）+ emotion（摘要）+ mood
```

- 情绪是短期状态：`halfLifeMs`（默认 1 小时）到期后按 2 的幂回落到基线；强度 <0.15 时自动回到 neutral。
- 情绪与关系的区别体现在限幅策略上：关系有"单次变化上限"（防跳变）；情绪只做硬钳制（一次强烈刺激本就该产生强烈情绪）。
- 标签是开放集合（内置 13 个常见标签 + 任意字符串），不是固定 6 个的枚举。
- 默认 **不调用模型**（`emotion.analysis.enabled=false`），只有显式开启且消息长度达标才走廉价模型。

## 5. Runtime State

`character_states.state_json` 现包含：`emotionState`（完整情绪）、`emotion`（摘要）、`mood`、`scheduleState`、`activity{id,label,startedAt,expectedEndAt}`、`location{sceneId,label}`、`energy`、`plan[]`、`lastInteractionAt`、`autonomyLevel`。

**唯一写入口是 CharacterStateService**：ConversationService / EmotionService / Scheduler / ProactiveService 全部通过它变更状态；它负责字段校验（label 长度、plan 条数上限）与数值钳制。

## 6. Event 架构

- 生命周期：`planned → active → completed`；旁支 `cancelled`、`expired`（到期未完成且超过宽限期由 `expireOverdue` 标记，由调度器周期触发，不用 setTimeout）。
- 效果通过 `EventEffectHandlers` **注入**（onCreated / onCompleted / onStatusChanged），EventService 本身不认识关系或任务：
  - `onCreated`：带 `dueAt` 的承诺/计划/纪念日 → 派生 `proactive_message` 任务（提前 12 小时）；
  - `onCompleted`：承诺/共同经历/关系变化 → 关系 +trust/+affection（走限幅）。
- 事件与任务的区别：事件是"发生/将要发生的事"，任务（WorkTask）是"要执行的动作"。

## 7. Task 架构

- 状态机：`pending → running → completed`，失败按 `attempts/max_attempts` 重试，超限置 `failed`；可 `cancelled`。
- `runDue()` 逐个执行到期任务，**单个任务失败不影响其它任务**，异常被捕获并记录 `last_error`。
- 处理器由组合根注入（`proactive_message` / `event_reminder` → ProactiveService；`custom` → no-op），TaskService 不认识业务。
- `createFromEvent` 幂等：同一事件同一类任务只派生一次。

## 8. Scheduler 架构

```text
SchedulerRunner（应用层，setInterval）
        ↓ tick()
    Scheduler（Core，纯逻辑，全部基于注入 Clock）
        ├ 取 next_run_at <= now 的 job
        ├ misfire 判定（默认迟到 >1h；drop 策略跳过，不补发风暴）
        ├ 调用注册的 JobHandler（不知道 handler 做什么）
        └ 推进 next_run_at：once→停用；interval/idle→now+interval；cron_like→下一个本地 HH:MM
```

- 触发器：`once`、`interval`、`cron_like`（HH:MM 每日）、`idle`（周期性检查、由 handler 判定资格）、`event`（仅手动/业务触发）。
- 调度器**不生成消息、不调用 LLM**；它只回答"什么时候检查、哪些 job 到期、条件是否满足"。
- 默认任务（首次启动写入）：每天 22:00 的定时问候、每 30 分钟的冷淡期检查、每 6 小时的事件过期维护。

## 9. Proactive 架构

```text
触发评估（确定性规则，0 成本）
   ↓ 不合格 → 记 skipped(not_eligible)，结束
策略闸门（enabled / autonomy / quiet hours / daily limit / cooldown）
   ↓ 不合格 → 记 blocked(具体原因)，**不调用模型**
解析会话 → 构建 ProactiveContext（无当前用户消息，含"为什么说话"）
   ↓
ModelRouter(task=proactive，默认 cheap)
   ↓
落库（source=proactive，partial → completed/failed）
   ↓
ProactiveOutbound → ChannelAdapter.send()
   ↓
记决策审计 + 领域事件
```

- **顺序不可调换**：先规则、再策略、最后才是模型。静音时段/超限/冷却时**绝不花钱生成**（有测试断言模型调用次数不变）。
- 主动消息不伪造用户输入：`messages.source='proactive'`，快照 `context_snapshots.source='proactive'` 且带 `trigger_reason`，其中含 `proactive_intent` 分区。
- dry-run（`POST /api/proactive/preview`）：同样完整走策略与生成，但**不落库、不发送、不占额度**。
- 审计：`proactive_decisions` 记录 trigger_kind、trigger_reason、decision、blocked_reason、autonomy、model、message_id、snapshot_id、latency、detail —— 可回答"为什么发/为什么没发"。

## 10. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/relationships | 所有角色的关系阶段与维度 |
| GET | /api/relationships/:characterId | 关系 + 里程碑 + 变化流水 |
| POST | /api/relationships/:characterId/changes | 手动调整（仍走限幅与流水） |
| GET | /api/emotions/:characterId | 当前情绪 + 心情 + 活动/地点/精力 + 最近历史 |
| GET | /api/emotions/:characterId/history | 情绪历史 |
| POST | /api/emotions/:characterId/stimulus | 注入一次情绪刺激（调试用，走校验与钳制） |
| GET/POST | /api/events | 列表（可按角色/状态过滤）/ 创建 |
| GET/PATCH/DELETE | /api/events/:id | 详情（含派生任务）/ 编辑 / 删除 |
| POST | /api/events/:id/{activate,complete,cancel} | 生命周期流转 |
| GET/POST | /api/tasks | 列表 / 创建 |
| POST | /api/tasks/{run, :id/complete, :id/cancel} | 立即执行到期任务 / 完成 / 取消 |
| DELETE | /api/tasks/:id | 删除 |
| GET | /api/scheduler/status | 运行状态、任务计数、下次执行、失败数 |
| POST | /api/scheduler/tick | 手动 tick（语义与真实定时器一致） |
| GET/POST | /api/scheduler/jobs | 任务列表 / 创建（校验 cron 与 interval） |
| PATCH/DELETE | /api/scheduler/jobs/:id | 启用停用 / 删除 |
| POST | /api/scheduler/jobs/:id/run | 立即执行该 job |
| GET/PUT | /api/proactive/settings | 策略读写（含每个角色"现在能不能发"的解释） |
| GET | /api/proactive/decisions | 决策审计 |
| POST | /api/proactive/preview | dry-run（不发送、不占额度） |
| POST | /api/proactive/trigger | 手动触发真实发送（**同样受策略约束**） |

## 11. 前端

| 页面 | 内容 |
| --- | --- |
| 关系与情绪 | 默认只显示**关系阶段 + 最近变化 + 里程碑**（不做数值游戏）；"高级"开关才显示六维数值条；情绪卡片显示当前情绪、强度、心情、活动/地点/精力、起因与最近变化（before → after） |
| 事件与任务 | 事件创建（类型/标题/时间）、完成/取消/删除；任务列表与"立即执行到期任务" |
| 主动消息 | 开关、自主等级、每日上限、冷却、静音时段、每个角色"现在能不能主动说话"的原因；预览（dry-run）与立即发送；调度状态（运行中、任务数、失败数、待执行、下次执行）；高级区显示任务列表与决策审计 |

## 12. FakeClock

`test/helpers/fake-clock.ts`：`now() / nowIso() / set(iso) / advance(ms) / setLocal(hour, minute, dayOffset)`。
生产使用 `systemClock()`，测试注入 FakeClock，通过 `createContainer({ clock })` 或 chat-stack 直接装配。

> Phase 3 期间发现并修复了一个真实缺陷：ConversationService / CharacterService / SummaryService / MemoryService 原先直接使用真实时间（`nowIso()`），导致注入时钟后**消息时间戳仍是真实时间**，"冷淡期""每日上限"等时间语义会失真。现已全部改走 Clock 端口。

## 13. 测试数量

后端共 **146 项**（Phase 2 为 108，新增 38）。新增覆盖：

- **Relationship**：惰性创建与持久化、单次变化限幅（±0.05）与钳制、流水 before/after/来源、阶段跃迁与里程碑、strained 判定、长期无互动回落。
- **Emotion**：确定性信号分类、限幅与往返持久化（回归：完整状态必须被记住，而不是每次回落基线）、半衰期衰减、模型分析开关与长度闸门、不可解析输出被忽略。
- **Event/Task**：事件全生命周期（含过期）、非法输入拒绝、任务 create/run/complete/cancel、失败重试到 failed、handler 抛异常不击穿、事件派生任务幂等、完成事件推动关系。
- **Scheduler（FakeClock）**：到期执行 / 未到期不执行 / 不重复触发、interval 推进与同窗不重发、once 自动停用、disabled 不参与、cron_like 每日触发与下次时间、失败隔离与状态、misfire drop、runNow 不改变计划。
- **Proactive**：静音时段拦截且**零模型调用**、每日上限与跨天重置、冷却、自主等级（passive/low/high 实际差异）、冷淡期资格判定、dry-run 不发送不占额度且同样受策略约束、成功路径（落库 source / 快照 source+意图 / 用量 / 审计 / 渠道投递）、生成失败记录且不抛出、Scheduler→Trigger→Policy→Model→Channel 端到端。
- **API（集成）**：关系/情绪/事件/任务/调度/主动消息全部端点，含限幅、幂等、策略拦截与审计查询。

## 14. pnpm test

```text
ℹ tests 146
ℹ pass  146
ℹ fail    0
ℹ duration_ms ~6.8s
```

## 15. pnpm typecheck

后端（NodeNext + erasableSyntaxOnly）与前端（bundler + React JSX）**双双通过**。

## 16. pnpm build

后端类型检查通过；前端构建成功（CSS 4.30 kB、JS 259.72 kB / gzip 79.33 kB）。

## 17. pnpm guard

**8/8 通过**（ARCH-1…ARCH-8，未退化）。Phase 3 的关系/情绪/调度/主动全部位于 Core Domain，未引入任何基础设施依赖；Core 依旧零第三方运行时依赖。

## 18. 真实 HTTP / UI 冒烟

`pnpm --filter @companion/backend smoke:phase3`（真实进程 + 真实 SQLite + 真实 HTTP + 本地 OpenAI 兼容 mock 服务）：

```text
CHARACTER: Aria / CONVERSATION: <uuid>
EMOTION: grateful(0.55) mood=感激 lastInteraction=2026-09-12T08:35:00
RELATIONSHIP: stage=stranger trust=0.110 变化=3 条
  最近变化: trust+0.010(正向互动) | affection+0.020(这次聊天让角色感到愉快) | familiarity+0.010(又一次交谈)
EVENT: 周末一起去书店(planned) → 派生任务 1 个（proactive_message）
SCHEDULER: jobs=3 最近即将执行=proactive_message@08:35,proactive_message@08:35
PREVIEW(dry-run): decision=skipped text="（mock 模型）我一直在，慢慢说。…"
PROACTIVE: decision=sent blocked=— text="（mock 模型）我一直在，慢慢说。…"
MESSAGES: user/conversation/completed, character/conversation/completed, character/proactive/completed
SNAPSHOT(proactive): task=proactive reason="手动问候" 含主动意图段=true
USAGE: proactive=2 chat=1
QUIET HOURS: decision=blocked blocked=quiet_hours 模型调用 2 → 2（应不变）
AUTONOMY(passive): blocked=autonomy_passive
DECISIONS: blocked:quiet_hours | sent:- | skipped:-
TICK: due=3 ran=1 skipped=2 tasksDue=1
PHASE 3 SMOKE OK
```

UI：前端已构建通过；关系/情绪、事件/任务、主动消息三页由 API 端到端测试与上述冒烟覆盖（仍无浏览器自动化，见第 23 节）。

## 19. 主动消息 E2E

`test/unit/proactive.test.ts` 的 "scheduler tick drives proactive messages end to end"：

```text
FakeClock(本地 12:00) → Scheduler.tick() → job 到期
  → JobHandler → ProactiveService.propose(trigger=scheduled_window)
  → 触发评估合格 → 策略放行 → ContextEngine(proactive) → TaskLLM(task=proactive)
  → messages(source=proactive, completed) + context_snapshots(source=proactive, trigger_reason)
  → model_usage(task=proactive) + proactive_decisions(sent) + outbound 实际投递
```

随后把时钟拨到 23:30 再次触发：任务照样到期（`outcome=ran`），但 `reason=blocked:quiet_hours`，且**模型调用次数不变**。

## 20. Quiet Hours / Daily Limit / Cooldown / Autonomy 验证

| 机制 | 验证方式 | 结果 |
| --- | --- | --- |
| Quiet Hours | FakeClock 23:30 + 默认窗口 23:00–08:00；API 侧用 00:00–23:59 覆盖全天 | `blocked=quiet_hours`，模型调用 0 次新增 |
| Daily Limit | `dailyLimit=1` 发 1 条后第 2 条被拦；跨天（`setLocal(12,0,1)`）后恢复 | `blocked=daily_limit`，次日 `sent` |
| Cooldown | `cooldownMs=2h`，10 分钟后重试被拦，3 小时后放行 | `blocked=cooldown` → `sent` |
| Autonomy | passive / low / normal / high 四档 | passive→`autonomy_passive`；low→每日上限收紧到 1；high→上限 +1 且冷却减半 |

## 21. Context Snapshot 验证

- 主动消息的快照 `source='proactive'`、`task_type='proactive'`、`trigger_reason='手动问候'`，且包含 `proactive_intent` 分区（"为什么现在主动开口"）。
- 普通回复的快照 `source='conversation'`，包含新增的 `emotion_state`、`relationship_state`、`events` 分区。
- 快照 DTO 已暴露 `source` 与 `triggerReason`，API 可直接回答"这条主动消息为什么发出来"。

## 22. Model Usage 验证

冒烟与测试同时断言：主动消息调用记在 `task_type='proactive'`；聊天记 `chat`；记忆抽取记 `memory_extraction`；情绪模型分析（若开启）记 `emotion_analysis`。token/成本缺少时仍记 NULL（不伪造），沿用 Phase 2 的诚实性约定。

## 23. 已知问题

| # | 问题 | 影响 | 计划 |
| --- | --- | --- | --- |
| P3-1 | 仍无鉴权（仅监听 127.0.0.1） | 本机多人环境有风险 | Phase 4+ 或独立安全阶段 |
| P3-2 | 日程（daily schedule / scheduleState 自动推进）尚未实现 | `scheduleState` 目前只在手动/API 下变化 | 下一阶段：角色日程表驱动 |
| P3-3 | 日程与场景（Scene/Location）联动未实现 | 地点变化靠手动 | 世界/场景阶段 |
| P3-4 | 情绪模型分析默认关闭 | 复杂情绪仅靠关键词，召回有限 | 观察成本后按需开启 |
| P3-5 | 事件效果只覆盖了 promise/shared_experience/relationship_change | 其它类型完成时不改关系 | 按剧情需要扩展 |
| P3-6 | 无浏览器自动化测试 | 前端回归靠人工 | 后续接 Playwright |
| P3-7 | 关系阶段阈值是启发式常数 | 可能不符合个别角色的性格 | 后续做成角色可配置 |
| P3-8 | `cron_like` 只支持每日 HH:MM | 不支持"每周三"/"每月 1 号" | 需要时引入 RRULE 子集 |
| P3-9 | misfire 只实现了 skip/drop/run_once 语义中的 skip/drop 分支（run_once 尚未走"立刻补跑"路径） | 长时间停机后可能少发一次 | 下一阶段补齐 |
| P3-10 | 主动消息不做去重（同内容可能重复） | 观感风险 | 加内容相似度抑制 |
| P3-11 | 决策审计无保留期清理 | 长期运行表会变大 | 与记忆 GC 一起做 |
| P3-12 | 冷却/上限按角色维度计数，未按会话细分 | 多会话场景偏保守 | 按需细化 |

## 24. Phase 4 准备事项

1. **微信独立通道**（下一阶段正式内容）：`channels/weixin/` 按协议独立实现（QR 登录、long-poll 游标两阶段、发送与媒体、引用还原、多账号），**不引入 OpenClaw**；Phase 1 的 ARCH-4/ARCH-7 守卫已就位，加入后会自动验证"删除微信渠道仍然可用"。
2. **主动消息出站已就绪**：`ProactiveOutbound` → `ChannelAdapter.send()`，微信通道只要实现 ChannelAdapter 即可接收主动消息，无需改动 Core。
3. **待收口的 Phase 3 尾巴**：P3-2/P3-3（日程与场景）、P3-9（misfire run_once）、P3-10（重复抑制）。
4. **横切关注点**：本地口令鉴权、数据导出/删除（沿用 Phase 2 的已知问题清单）。

---

**Phase 3 完成。**
停止。
不要进入 Phase 4。

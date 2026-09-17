# 调度后台界面中文化 报告

日期：2026-09-17 ・ 范围：只改「显示层」，不动调度逻辑、数据结构与接口返回。

## 1. 这次改了什么（改动范围）

| 文件 | 改动 |
| --- | --- |
| `frontend/src/lib/labels.ts` | 新增：调度/任务相关中文词典 + 格式化函数（唯一字典） |
| `frontend/src/pages/proactive.tsx` | 「调度状态」整段改为中文：状态、统计、接下来会跑的任务、高级区任务卡、执行记录 |
| `frontend/src/pages/timeline.tsx` | 工作项标题/状态改走同一个字典 |
| `frontend/test/scheduler-labels.test.ts` | 新增：词典映射 + 未知取值安全（6 个用例） |
| `frontend/test/scheduler-ui.test.mjs` | 新增：真实渲染页面，扫描内部枚举（3 个用例） |
| `frontend/test/live-scheduler-ui.check.mjs` | 新增：拿**运行中的后端真实数据**渲染页面做真机检查（不进 pnpm test） |

后端（`backend/src/**`）、数据库表结构、API 返回字段：**一行未改**。数据库里仍然是 `scheduled_message` / `cron_like` / `idle`，只是不再直接显示给用户。

## 2. 统一中文词典（唯一一处）

`frontend/src/lib/labels.ts` 是唯一的翻译点，页面不再各写各的中文：

| 内部值 | 用户看到 |
| --- | --- |
| scheduled_message | 定时消息 |
| proactive_message | 主动消息 |
| event_maintenance | 事件维护 |
| task_runner | 任务执行 |
| memory_extract / summarize / event_reminder / custom | 记忆整理 / 对话摘要 / 事件提醒 / 自定义任务 |
| once | 一次性 |
| interval | 间隔重复 |
| cron_like | 每天固定时间 |
| idle | 空闲触发 |
| event | 事件触发 |
| idle / running / failed / disabled（任务状态） | 待机中 / 执行中 / 执行失败 / 已停用 |
| pending / running / completed / failed / cancelled（工作项） | 待执行 / 执行中 / 已完成 / 执行失败 / 已取消 |
| idle_check / scheduled_window / event_due / task / manual | 隔了一段时间没说话 / 到了约定的时间 / 有事情临近了 / 任务触发 / 你手动触发 |
| sent / skipped / blocked / failed | 已发送 / 没有发送 / 被规则拦下 / 发送失败 |
| quiet_hours / daily_limit / cooldown / not_eligible … | 处于静音时段 / 已达到今日上限 / 距上次太近（冷却中）/ 现在没有合适的理由 … |

另外每个任务类型都配了一句人话解释（鼠标悬停可见），例如：定时消息 = 按你指定的时间，自动发送一条消息；事件维护 = 每隔一段时间自动检查事件状态，不需要你操作。

## 3. 普通界面不再出现内部枚举

改动前的「调度状态」页直接打印 `scheduled_message`、`cron_like`、`idle`、`once` 这类值；现在：

- 「调度器状态」→ 运行中 / 已停止，任务总数 / 已启用 / 执行失败 / 待执行的工作项 / 上次检查，全部是中文说明；
- 「接下来会自己跑的任务」→ 主动消息・空闲触发・下一次执行 2026-09-17 01:04；
- 「每天 22:00 执行」「每 6 小时检查一次（下次 …）」「自动判断（下次检查 …）」，不再出现 cron_like / interval；
- 状态显示规则：任务被停用时一律显示「已停用」，不会绕成「执行失败」；
- 时间一律本机时间，格式 `YYYY-MM-DD HH:MM`。

## 4. 未知取值不会崩、不会出现 undefined

遇到词典里没有的值（例如以后新增的任务类型）统一降级为中文占位：`未知任务类型` / `未知触发方式` / `未知状态` / `未知触发原因` / `未知结果` / `被规则拦下`，不抛异常、不显示 undefined、不显示 null。原始值只通过 `rawValue()` 交给 tooltip 和高级区的「开发者信息」行。

## 5. 开发者信息只出现在高级区

页面上多了一个开关「高级：任务与执行记录」（默认关闭）。打开后才出现原来的任务卡与执行记录，并且每张卡最后一行才是：

```
开发者信息：任务类型 proactive_message ・ 触发方式 cron_like ・ 状态 idle
```

普通用户不打开这个开关，整个页面没有任何内部枚举。

## 6. 前端测试

`frontend/test/scheduler-labels.test.ts`（6 个用例）：逐个断言映射表（scheduled_message→定时消息、cron_like→每天固定时间、once→一次性、pending→待执行、enabled→已启用…），并断言未知取值返回中文占位、`formatMoment` 对 null / 非法时间返回 `—`。

`frontend/test/scheduler-ui.test.mjs`（3 个用例，jsdom 真渲染页面，输入故意含一个未来才有的新枚举）：

1. 默认层文字全部是中文，且扫描 `proactive_message / scheduled_message / event_maintenance / brand_new_kind / cron_like / interval / once / idle / not_eligible / quiet_hours / undefined` 全部不出现；
2. 未知枚举不崩、不报错、不出现 undefined / null；
3. 高级区里原始值只出现在「开发者信息」段落：把该段落挖掉后再扫描一次，内部枚举仍然不出现。

## 7. 真实页面检查（用运行中的后端数据）

`frontend/test/live-scheduler-ui.check.mjs` 把页面挂起来，fetch 全部打到 http://127.0.0.1:8787 的**真实接口**（16 条真实任务：13 条 scheduled_message、2 条 proactive_message、1 条 event_maintenance）。实际渲染结果节选：

```
调度器状态 运行中 任务总数：16 已启用：3 执行失败：0 待执行的工作项：2 上次检查：2026-09-17 00:50
接下来会自己跑的任务
  主动消息 已启用 空闲触发 下一次执行：2026-09-17 01:04
  事件维护 已启用 间隔重复 下一次执行：2026-09-17 03:01
  主动消息 已启用 每天固定时间 下一次执行：2026-09-17 22:00
高级（展开后）：定时消息 ● 已停用 类型：一次性 — 上次执行：2026-09-16 23:10 启用 立即执行一次
  执行记录：用户才安静了 15 分钟 / 现在没有合适的理由 / 隔了一段时间没说话
```

脚本输出结论：普通界面里的内部枚举 = 无；高级区去掉开发者信息行后的内部枚举 = 无；页面报错 = 无；页面出现 undefined = false。

## 8. 调度行为没有改变

- 本次只改前端显示层，没有改 Scheduler / Proactive / Event / Task / Schedule 的代码、表结构与接口字段；
- 后端返回的字段名和取值原样保留（例如 `/api/scheduler/jobs` 仍然返回 kind: "scheduled_message"）；
- 「立即检查一次」「立即执行一次」「启用 / 停用」调用的还是原来的三个接口，参数没变；
- 后端测试里的调度、主动消息、定时消息集成用例全部通过（见下）。

## 9. 回归结果

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 377 / 377 通过 |
| pnpm --filter @companion/frontend test | 25 / 25 通过（原 16 + 新增 9） |
| pnpm typecheck | 退出码 0 |
| pnpm build | 退出码 0 |
| pnpm guard（ARCH-1…ARCH-8） | 8 / 8 通过 |

诚实说明：第一次并行跑整套后端测试时，`weixin-audio-messages.test.ts` 有 1 个用例失败（语音转码在并发下超时，期望 available 得到 failed），单独重跑该文件 10/10 通过，随后整套重跑 377/377 通过。这是既有的并发抖动，与本次显示层改动无关。

## 结论

| 判定 | 结果 |
| --- | --- |
| SCHEDULER_UI_CHINESE | VERIFIED —— 调度状态页所有面向用户的文字均为中文，术语统一来自 `frontend/src/lib/labels.ts` |
| NO_INTERNAL_ENUM_ON_NORMAL_UI | VERIFIED —— 普通界面（高级开关关闭）用真实后端数据渲染后，内部枚举零出现；原始值只在高级区「开发者信息」行 |
| SCHEDULER_BEHAVIOR_UNCHANGED | VERIFIED —— 后端、表结构、接口字段零改动，四道门全绿 |

顺带记录（不在本次范围，未改）：聊天页「这一轮模型会看到什么」弹窗与设置页模型列表仍会显示技术标识（context section kind、provider.kind），它们本来就属于开发者/高级区域。

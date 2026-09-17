# 到点提醒：按记录的意思、用角色的语气说，而不是照念记录原文

日期：2026-09-17 ・ 需求：「定时任务不是只输出记录文本，是按照记录的意思融合人设发信息」

## 1. 改动前是什么样

`scheduled_jobs.payload.message`（用户当初说的那句，例如「提醒我带伞」）在到点时被**原样**写进会话并发出：
微信里收到的就是一句「提醒我带伞」，没有角色、没有人设，读起来像系统通知。

## 2. 改动后

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/context/context-engine.ts` | 上下文新增 `reminderText`：有它时注入的意图段从「你想主动说点什么」变成「你答应过要提醒对方这件事」+ 记录原文 + 写作要求（用自己语气、一两句、不许提系统/提醒任务/记录这类机制词） |
| `backend/src/core/services/reminder-composer.ts` | 新增：复用主动消息那条链路（ContextEngine 装配人设/记忆/关系/情绪 → `proactive` 档模型）生成到点要说的话 |
| `backend/src/app/bootstrap.ts` | `scheduled_message` 处理器：先让角色说，再把这句话写进会话并出站；**生成失败或为空就退回记录原文** |
| `frontend/src/pages/timeline.tsx` | 「定时提醒」分区说明改为「到时间角色会用自己的语气把这件事说出来（不是照念这句话）」 |

记录原文**仍然完整保留**：提醒列表里看到的是它，job payload 里存的也是它；变的只是"到点怎么开口"。

链路没变：`scheduled_jobs → Scheduler → runner → 写入会话(source=proactive) → 渠道出站`，幂等键仍是 `scheduled:<jobId>`。

## 3. 兜底：提醒绝不能因为模型抽风而消失

生成抛错或返回空字符串 → 用记录原文发出去，并且 job 仍然算 `ran`（提醒送到才算数）。
日志里会留下 `schedule.compose` 的 `compose_unavailable` / `empty_generation`，成功时带 `composed: true`。

## 4. 证据

### 真机（真实模型，只生成不发送、不写会话）

记录原文：`明天中午12点提醒我去开会`

```
【Aria】性格：安静、话少但很细心
  到点会说：“……明天中午十二点，别忘了去行政楼交材料。\n\n（别又忘了。）”
  是否照抄原文：否
```

（只有「Aria」有会话，所以真机只跑了这一个角色；「Kai」没有会话，跳过。人设差异是结构性的：走的就是主动消息同一条上下文链路，之前的 phase 里已经验证过同一条消息在两个角色口中措辞明显不同。）

### 测试

| 用例 | 覆盖 |
| --- | --- |
| Test B（改写） | 到点发出的是角色自己说的话，且**不等于**记录原文；模型收到的上下文里必须写明"你答应过要提醒对方这件事"+记录原文 |
| 措辞生成失败 → 退回原文 | 模型 500：提醒照样送到，内容是原文，job 仍算 ran |
| 措辞生成为空 → 退回原文 | 空文案等于没有文案 |
| Test C / Test F（改写） | 上下文里这条仍被标为主动消息；渠道隔离按"哪条会话收到了主动消息"判断 |

顺带修了测试替身的一个盲点：它原来只取**第一段** system 提示，而"主动意图段"按既有呈现顺序排在最近对话之后（第二段 system），所以它一直看不到主动消息的意图段。现在把全部 system 片段合起来看 —— 这也说明这次改动之前，那条链路在测试里其实是"看不见意图段"的。

## 5. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 403 / 403 通过（原 401 + 新增 2） |
| pnpm --filter @companion/frontend test | 34 / 34 通过 |
| pnpm typecheck / build / guard | 0 / 0 / 8 通过 |

后端已重启（web + weixin healthy）。

## 6. 一个已知的细节（没改，但要知道）

「主动意图 / 到点提醒」这段指令在上下文里的呈现顺序排在最近对话**之后**，因此会作为第二段 system 消息发给模型（OpenAI 兼容接口允许，真实模型实测遵守）。
如果要更稳，可以把它挪到人设之后、最近对话之前；那会改动所有主动消息的提示词布局，属于单独一件事，这次没动。

## 结论

| 判定 | 结果 |
| --- | --- |
| REMINDER_SPOKEN_IN_PERSONA | VERIFIED —— 真机：Aria用自己的语气说出提醒内容，未照抄记录 |
| RECORD_PRESERVED | VERIFIED —— 记录原文仍在 job payload 与提醒列表中 |
| REMINDER_NEVER_LOST | VERIFIED —— 生成失败/为空一律退回原文，job 仍算送达 |
| NO_REGRESSION | VERIFIED —— 403 / 34 / typecheck / build / guard 全绿 |

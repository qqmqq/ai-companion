# WEIXIN + PROACTIVE 全链路自检报告

日期：2026-09-16 ｜ 范围：只查两个问题——「微信收到消息没反应」与「自动消息发不出去」。未进入 Phase 6，未新增任何功能。

## 结论速览

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 微信入站 | **FAIL → 已修复**（根因见 §8.1）；修复后用真实手机复测 **NOT VERIFIED**（微信服务器在修复后未再投递任何消息） |
| 2 | AI 处理 | **PASS**（mock 全链路 + 网页真实链路；决策记录里 provider/model 明确） |
| 3 | 微信出站 | **MOCK PASS / REAL NOT VERIFIED**（出站必须先用真实入站拿到 context_token，而入站在修复后没再收到过真实消息） |
| 4 | 自动消息 | **PASS**（修复后 job → 决策 sent → 消息落库 → 通道发送，全链路走通） |
| 5 | Scheduler | **PASS**（持续 tick，时区正确，due/skipped 可解释） |
| 6 | Proactive | **PASS**（policy 评估正常，拒绝时给出明确规则而不是静默） |
| 7 | 真实微信 | **REAL WEIXIN = NOT VERIFIED**（详见 §7） |

---

## 1. 微信入站

**结果：FAIL（已被真实日志复现）→ 已修复；真实复测 NOT VERIFIED**

### 系统自检（启动后实测，不只看进程）

| 组件 | 实测 |
| --- | --- |
| Backend | /api/system/health → status=ok, database=ok |
| Frontend | http://localhost:5173 可访问，页面模块可加载 |
| Database | WAL 正常，messages / conversations / channel_cursors / scheduled_jobs 可读写 |
| Weixin Channel | state=connected, loggedIn=true, requiresRelogin=false，健康 healthy |
| Long poll | 持续运行：实测每 18–20 秒一轮，ret=0 errcode=0，游标每轮提交 |
| Scheduler | running=true，62+ ticks，lastError=null |
| Proactive | policy enabled=true, autonomy=normal，资格评估返回 allowed |
| ModelRouter | chat → openai-compatible-01a0a8a9 / deepseek-flash |
| Message service | 网页真实往返 OK（用户消息 → 模型 → 落库 → 回复） |
| ChannelAdapter | web 与 weixin 均已注册并启动 |

### 断点定位（真实日志，逐层）

Long poll 侧全部正常，问题在解析阶段：

```
{"step":"weixin.poll","status":"completed","accountId":"<机器人账号>@im.bot","ret":0,"errcode":0,"received":1,"cursorChanged":true}
{"step":"weixin.inbound","status":"completed","received":1,"processed":0,"duplicates":0,"skipped":1}
{"step":"weixin.inbound","status":"skipped","reason":"self_echo"}
```

时间 06:49:53 —— 用户从手机发出的消息确实到了服务器、也确实被我们收到了，然后被判定成「机器人自己发的回声」丢弃。丢弃之后：没有 conversation、没有 message、没有模型调用、没有回复。这与现场完全一致（channel_message_ids = 0、conversations 里只有 web 一条）。

### 修复

selfUserId 传错了对象：

| 字段 | 真实含义 | 原来怎么用的 |
| --- | --- | --- |
| ilink_bot_id | **机器人自己**的 id（= 我们的 accountId，如 <机器人账号>@im.bot） | 没用在自我判定上 |
| ilink_user_id | **扫码用户本人**的 id | 被当成「机器人自己」用于 self_echo 判定（错） |

所以用户发的每一条消息都等于 ilink_user_id，全部被判为 self_echo。现在改成用 accountId（机器人 id）做自我判定，机器人自己发的消息仍然会被跳过（避免回声循环）。

新增两条回归测试（真实形状）：扫码用户本人发来的消息不能被 skip；机器人自己发的消息仍然被 skip。

> 旧测试之所以没抓到，是因为 mock 把 ilink_user_id 设成了一个跟发送者不同的假 id（self-A vs user-A），与真实语义相反。这次把测试改成真实形状，问题会被永久挡住。

### 修复后的真实复测

修复并重启后（06:51:21 起）连续观察 6 轮以上轮询：received=0, cursorChanged=false，微信服务器没有再投递任何消息（用户在此期间多次发送）。因此「修复后能收能回」没有拿到真机证据。

---

## 2. AI 处理

**结果：PASS**

- 入站消息进入 ContextEngine → ModelRouter → 真实 LLM：由 /api/proactive/decisions 与 model_usage 双重佐证（providerId=openai-compatible-01a0a8a9, model=deepseek-flash, latency 约 1.2–2.2 秒）。
- 网页真实链路：用户消息 → 真实回复（嗯。……还是老样子？今天有刚烘的耶加。）→ 落库 → 通过 web 适配器送达。
- 日志只记录 provider / model / 时长 / 状态与 id，不含 API Key、token、cookie、credential 或消息内容。

### 需要记录、但未修改的观察（与本次两个问题无关）

模型偶发空回复 / 超短回复：06:36 网页聊天出现 status=failed, error_text=生成内容为空；06:44 主动消息只生成了 1 个字（店）。链路每一步都成功（决策 stage=send），是模型输出质量问题。按无关问题只记录处理，未改动。

---

## 3. 微信出站

**结果：MOCK PASS / REAL NOT VERIFIED**

- Mock 全链路（smoke:phase4）：REPLY → WEIXIN: （角色）我在，刚忙完手头的事。 | to=wx-user-1 | context_token=ctx-user-1 —— assistant message → WeixinChannel.send() → sendmessage → 渠道返回，全部走通。
- 真实出站的前提是先有一条真实入站：协议要求发送时必须带该会话的 context_token，而这个 token 只能从入站消息里拿到。由于修复后没有新的真实入站消息，真实出站无法验证。
- 出站可观测性：发送失败会记录 weixin send failed（含 accountId 与错误信息，不含凭据）；重试有上限。

---

## 4. 自动消息

**结果：PASS（链路）/ 真实微信送达 NOT VERIFIED**

修复前：scheduler 每轮 due=1 ran=0 skipped=1，主动消息从未生成。修复后实测：

```
POST /api/scheduler/jobs/job:m1htfoehcl/run → outcome=ran
proactive_decisions: decision=sent, stage=send, provider=openai-compatible-01a0a8a9, model=deepseek-flash, latency=2225ms
log: proactive message sent  characterId=01a0a8b9-... chars=1
```

消息落库（messages 里出现 role=character 的主动消息）并投递到当时最近活跃的会话 = web 会话。因为那时系统里还没有任何微信会话（微信入站被 §8.1 的 bug 挡掉了），所以它出现在网页而不是手机上——这正是「自动消息没有真正发到微信」的直接原因链。

---

## 5. Scheduler

**结果：PASS**

- runner.running=true，intervalMs=60000，ticks 持续增长，lastError=null。
- 时区正确：cron 22:00 的 job next_run_at = 2026-09-16T14:00:00.000Z（UTC+8 的 22:00），不是服务器时区假设。
- 跳过可解释：due=1 ran=0 skipped=1 对应 proactive job 的 job has no character（见 §8.2），不是没跑。

---

## 6. Proactive

**结果：PASS**

- policy gate 正常工作，且拒绝时给出具体规则，不会静默：
  - idle_check：用户 10 分钟前刚说过话 → 未达 inactivityThresholdMs = 24h → 拒绝（这是策略，不是故障）。
  - 静音时段 23:00–08:00、每日上限 3、冷却 30 分钟：均可在 /api/proactive/settings 看到。
- 为验证链路，使用 scheduled_window 触发（不绕过 policy、不删规则）→ decision=sent。

---

## 7. 真实微信

**REAL WEIXIN = NOT VERIFIED**

理由（有证据）：

1. 修复前的真实入站确实到达过：06:49:53 received=1 + skipped=self_echo，即「手机 → 微信 → 我们」的物理链路是通的，丢掉消息的是我们的判定逻辑。
2. 修复后的真实入站未再出现：06:50–06:53 连续 6+ 轮轮询全部 received=0, cursorChanged=false，用户在此期间多次发送（用户确认就是那个唯一的机器人会话）。也就是说消息没有投递到这台绑定账号上。
3. 因此「修复后手机发消息 → 手机收到回复」这条端到端事实没有被观察到，不能写 VERIFIED。

可复现的下一步（需要手机操作）：重新扫一次新码（今天多次换绑，服务端会话可能已陈旧）→ 绑定后立刻在新出现的机器人会话里发一条消息。

---

## 8. Root Cause

### 8.1 微信收到消息没反应（致命）

backend/src/channels/weixin/receiver/long-poll.ts 把 secret.ilinkUserId（扫码用户本人的 id）当成「机器人自己」传给 mapper 做自我判定，导致用户发的每条消息都被判为 self_echo 丢弃。

```ts
// 之前（错）：ilink_user_id 是用户的 id，不是机器人的
selfUserId: secret.ilinkUserId,
// 现在（对）：机器人自己的 id 就是 accountId（登录响应的 ilink_bot_id）
selfUserId: accountId,
```

### 8.2 自动消息发不出去（三层）

1. 种子 job 没有角色：scheduled_jobs.character_id = NULL（当初种 job 时用户还没有任何角色）。
2. handler 直接跳过：bootstrap.ts 的 proactive_message handler 在 characterId === null 时返回 outcome=skipped —— 跳过就是永远不生成。
3. 补偿写入无效：ScheduledJobRepository.update() 的 UPDATE 语句没有 character_id 列，所以「把没有角色的 job 绑到角色上」这类修正根本写不进数据库（这一层是修第 2 层时才暴露出来的）。

修复：启动时把缺角色的 proactive job 绑定到用户的第一个角色 + handler 兜底 + UPDATE 补上 character_id。

### 8.3 入站角色的隐含前提（附带修掉）

resolveCharacterId 只认 metadata.characterId 或设置里的 defaultCharacterId，而全代码库没有任何地方写过 defaultCharacterId → 即使消息收进来了也会因为「没有角色」被丢弃。现在增加兜底：用用户的第一个角色，并在日志里标明来源（source: metadata / defaultCharacterId / first-character-fallback）。

### 8.4 可观测性缺陷（已修）

- 入站被跳过原来只记 debug 级日志 → 消息被丢掉时日志里什么都看不到。现在改为 info 并带 reason。
- 新增轮询心跳（COMPANION_WEIXIN_TRACE=1 时开启）：每轮记录 ret / errcode / received / cursorChanged，用于证明 long poll 是持续运行而不是「请求一次就结束」。
- 入站管线新增分步日志：inbound.received → inbound.character → inbound.conversation → inbound.persist_user → inbound.generate → inbound.deliver，任一步失败会写 status=failed + errorCategory。

---

## 9. 修改文件

| 文件 | 改动 |
| --- | --- |
| backend/src/channels/weixin/receiver/long-poll.ts | self 判定改用 accountId（机器人 id）；被跳过的消息由 debug 升为 info；新增轮询心跳 trace |
| backend/src/channels/weixin/receiver/inbound-mapper.ts | 注释澄清 selfUserId 语义（必须是机器人 id，不能是 ilink_user_id） |
| backend/src/core/services/messaging-pipeline.ts | 角色解析三级兜底 + 分步链路日志（received / character / conversation / persist / generate / deliver） |
| backend/src/app/bootstrap.ts | proactive job 无角色时兜底用用户第一个角色；启动时补偿绑定历史 job |
| backend/src/storage/repositories/scheduled-jobs.ts | update() 的 SQL 补上 character_id |
| backend/test/integration/weixin-channel.test.ts | 新增两条真实形状回归测试（用户消息不被 self_echo 丢；机器人消息仍被跳过） |

未改动：Memory / Relationship / Emotion / Media / ASR / TTS / ModelRouter 的业务逻辑（仅在 MessagingPipeline 里增加日志与角色兜底）。

---

## 10. Regression

| 命令 | 结果 |
| --- | --- |
| pnpm test | backend **356 / 356**（原 354 + 新增 2），frontend **12 / 12**，0 fail |
| pnpm typecheck | exit 0 |
| pnpm build | exit 0 |
| pnpm guard | **8 / 8** |
| smoke | PASS |
| smoke:phase3 | PASS |
| smoke:phase4（微信登录 / 收消息 / 回复 / 主动消息送达微信） | PASS |
| smoke:phase45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 / 45e | 全部 PASS |
| smoke:phase5 | 不存在：该冒烟脚本随上一轮 CORE CLEANUP 一起删除（SillyTavern 角色卡子系统已移除），不是本次遗漏 |

没有删除任何测试，也没有降低断言；新增的两条测试是把 mock 从「不真实的 id 关系」改成真实形状后必然失败的用例。

---

## 附：现场时间线（真实证据）

```
06:30:46  scheduler tick due=1 ran=0 skipped=1        ← 主动消息被跳过（§8.2）
06:32:30  旧微信账号 <已删除的机器人账号>@im.bot 被删除
06:33:02  账号 <临时机器人账号>@im.bot 绑定成功
06:36:38  网页聊天：模型返回空 → decision=failed(empty_generation)  ← 模型质量问题（只记录）
06:44:16  重启（含 job 角色补偿）→ 两个 proactive job 绑定到角色
06:44:30  手动跑 proactive job → decision=sent，消息落库 → 投递到 web 会话
06:48:20  轮询心跳：ret=0 received=0 cursorChanged=false（长轮询健康）
06:49:47  账号 <机器人账号>@im.bot 绑定成功（用户重新扫码）
06:49:53  received=1 → skipped(self_echo)              ← 真实故障现场（§8.1）
06:51:21  重启（含 self 判定修复）
06:51:39+ 轮询心跳：received=0 cursorChanged=false（服务器未再投递）
```



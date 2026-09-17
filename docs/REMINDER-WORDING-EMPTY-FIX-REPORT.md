# 到点提醒又发了原文？—— 措辞生成为空的修复

日期：2026-09-17 ・ 现象：23:06 说「两分钟后提醒我带伞」，23:09 收到的是原文「提醒我带伞」，没有人设。

## 1. 先看日志（两行就说清了）

```
15:09:05  warn  reminder composer produced empty text; falling back to the recorded reminder
                {step:"schedule.compose", status:"failed", errorCategory:"empty_generation"}
15:09:06  info  scheduled message delivered  {jobId:"job:ztptyz4df3", delivered:true, composed:false}
```

`composed:false` = 走的是兜底分支。也就是说：**"让角色用自己的语气说"这段代码是执行了的，但模型返回了空字符串**，于是按设计退回记录原文（提醒不能丢）。

上一条提醒（04:01 那条）也是 `composed:false` —— 这个路径一直在默默退化成原文。

## 2. 根因：又是那个 200 tokens 的输出预算

措辞这一步用的是 `maxOutputTokens: 200`。对"先想再答"的模型（deepseek-flash）来说，
这点预算会被思考过程吃掉，正文直接返回空 —— 与之前**意图解析被截断**那次是同一个病根：
预算太小 + 失败时静默降级到更差的行为。

不同之处在于：这次降级是**有意设计**的兜底（宁发原文也不能不发提醒），所以它不会报错、只会安静地变得没有人设 ——
要不是当时留了 `schedule.compose` 这条 warn 日志，根本查不到。

## 3. 修复

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/services/reminder-composer.ts` | 输出预算 200 → **600**；返回空时**重问一次**（1200）；仍然为空才退回原文；日志带上 `finishReason`，能一眼看出是"空"还是"被截断" |
| `backend/src/core/services/proactive-service.ts` | 主动消息那条链路是同一个预算，一起放宽到 600（否则它也会以「生成内容为空」失败、干脆不开口） |
| `backend/test/integration/scheduled-message.test.ts` | 测试替身支持"按顺序返回聊天回复"；新增用例：第一次空 → 重问一次 → **发出的是重问出来的那句话**，且断言不等于记录原文 |

## 4. 证据（真实模型，连续 5 次）

角色：Nova（会话 01a0ac07…），提醒原文都是「提醒我带伞」：

```
第1次 (1877ms, 60 字): “*她没回头…声音压得很低*\n\n“到点了。伞在门口，出门前记得拿。””
第2次 (1171ms, 70 字): “*她指尖在桌沿轻轻叩了一下…*\n“时间到了。伞在门口，别忘了带。””
第3次 (1407ms, 65 字): “*她没转头，只是抬手虚点了下桌沿，杯子的位置…*\n\n“两分钟到了。伞在门口，出门再…””
第4次 (1313ms, 49 字): “*她抬眼看了你一下…*\n\n“两分钟到了。伞就在门口——带上它。””
第5次 (1546ms, 70 字): “*她偏过头看了你一眼…*\n“两分钟到了。伞就在门口。””
空文案次数：0 / 5
```

五次全部非空、全部是 Nova 的语气（冷淡、话少、句子短），没有一次退回原文。

## 5. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 413 / 413 通过（新增 1 例） |
| pnpm --filter @companion/frontend test | 41 / 41 通过 |
| pnpm typecheck / build / guard | 0 / 0 / 8 通过 |

后端已重启（23:21），web + 微信 healthy。

## 6. 说明

- 兜底逻辑**保留**（重问两次还是空就发原文）：提醒的价值高于文风，宁可没有人设也不能不提醒。
- 23:09 那条已经发出去了，撤不回；**再发一次「两分钟后提醒我带伞」就能看到新行为**。

## 结论

| 判定 | 结果 |
| --- | --- |
| ROOT_CAUSE_FOUND | VERIFIED —— 措辞调用返回空字符串，按设计退化成记录原文（日志 composed:false） |
| BUDGET_FIXED | VERIFIED —— 200 → 600，空则重问一次（1200），真实模型连跑 5 次 0 空 |
| PERSONA_WORDING_RESTORED | VERIFIED —— 5 次输出全部是角色自己的语气，不再是「提醒我带伞」 |
| NO_REGRESSION | VERIFIED —— 413 / 41 / typecheck / build / guard 全绿 |

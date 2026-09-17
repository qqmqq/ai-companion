# Phase 4.5-E 报告：媒体 / 语音最终审计与加固

> E 是**审计 + 加固**阶段，不加新特性。下面只写真实发现的问题与真实做过的修复；
> 没有问题的区域明确写 **No change required.**，不为了显得有产出而编造 bug。

---

## 1. 审计范围

| 区域 | 覆盖内容 |
| --- | --- |
| 媒体模型 | `MediaReference` / `TextPart,ImagePart,AudioPart,VideoPart,FilePart` / `normalizeMessageParts` / `partsToText` |
| 存储与传输 | `LocalMediaStorage`（路径、permissions、原子写、checksum）、`MediaTransport` 端口、微信 CDN 客户端、AES-128-ECB/PKCS#7 |
| 渠道 | 入站映射（image/file/video/voice）、hydrate 钩子、出站 `send()`、SILK 编解码、`voice_item` 载荷 |
| ASR（D3） | 幂等指纹、限额、错误归一化、状态持久化、并发、重启 |
| TTS（D4） | 同上 + 生成媒体与消息的关联、缓存 |
| 管线 | 入站 → 落库 → 上下文 → 回复 → 送达 → （ASR/TTS）副作用阶段 |
| 数据库 | 迁移 001–006、索引、外键、唯一约束、可空性、事务边界、缺失行处理 |
| 前端 | 媒体状态展示（pending/processing/available/failed/missing）、重试语义、刷新副作用 |
| 安全 | 日志/错误/API/DB 中的凭据、密钥、协议机密、音频字节；路径穿越；SSRF；超限 |
| 运维 | 崩溃/重启、孤儿媒体、启动恢复、依赖方向与架构守卫 |

---

## 2. 检查过的文件（真实源码，不依赖历史报告）

`backend/src/core/model/{media,message,transcription,tts,provider-error,errors}.ts`、
`core/ports/{media-storage,media-transport,asr,tts,repositories,repositories.phase45,channel-module}.ts`、
`core/services/{messaging-pipeline,conversation-service,transcription-service,tts-service}.ts`、
`core/context/context-engine.ts`、
`storage/{db,migrations}.ts`、`storage/migrations/001…006`、
`storage/repositories/{messages,transcriptions,tts-syntheses,settings}.ts`、
`storage/media/local-media-storage.ts`、
`channels/weixin/**`（channel/sender/receiver/protocol/media，含 `inbound-mapper`、`long-poll`、`voice-codec`、`image/file/video/audio-validation`、`media-transport`、`cdn-client`、`aes-media`）、
`providers/asr/*`、`providers/tts/*`、`providers/llm/registry.ts`、
`app/{bootstrap,media-audit,config}.ts`、`api/{dto/mappers,routes/messages}.ts`、
`frontend/src/{lib/parts.ts,lib/types.ts,lib/api.ts,pages/chat.tsx}`、
`test/**` 与 `scripts/phase4*-smoke.ts`。

---

## 3. 发现的真实问题（共 5 个）

| # | 问题 | 类别 | 严重度 |
| --- | --- | --- | --- |
| 1 | **并发重复调用 provider**：转写/合成都是"查缓存 → 调 provider → 写缓存"，没有任何串行化。两个并发请求（前端连点、或"自动生成 + 显式重试"同时到达）会同时错过缓存 → 重复调用 provider（重复付费），TTS 还会**产生两份媒体对象** | 并发 / 成本 / 媒体一致性 | 中 |
| 2 | **崩溃后 processing 永久卡死**：进程在转写/合成途中被杀，`transcriptions.status` / `tts_syntheses.status` / `messages.tts_json` 会永远停在 `processing`（没有任何后台任务会回来收尾），前端因此永远显示"语音生成中…" | 崩溃恢复 | 中 |
| 3 | **消息插入会静默丢弃 TTS 状态**：`MessageRepository.insert()` 的 INSERT 语句不含 `tts_json` 列，带 `tts` 状态插入的消息读回来没有 `tts`（"插入-读回"不对称，属于仓库边界的数据丢失） | 数据库一致性 | 中 |
| 4 | **媒体字节从不校验**：`LocalMediaStorage.put` 会算 sha256 存进 sidecar，但 `get()` **从不校验**。文件被截断/改写后会被当成正常媒体一路送进 SILK 解码 / ASR / 出站 | 存储一致性 / 安全 | 中 |
| 5 | **存储边界不净化文件名**：`put()` 把调用方给的 `filename` **原样**写进 sidecar，`"../../etc/passwd"` 这类值会原样持久化（路径本身由 mediaId 决定，所以不影响穿越安全，但会让恶意字符串进入元数据与 API/UI —— 纵深防御缺口） | 安全（纵深防御） | 低 |

此外**两个测试侧问题**（不是产品 bug，但如果不管就会掩盖真问题）：

- `test/unit/local-media-storage.test.ts` 之外，我把 `remove()` 对非法 id 的行为写错了（见第 11 节：`remove` 是写路径，**故意**抛错，这是 4.5-B 的既定契约）；
- 我的新测试一开始漏了消息表的外键父行，这本身也说明 `messages` 的外键是**真的在生效**（好事）。

---

## 4. 做的修复（全部最小、可验证）

| # | 修复 | 文件 |
| --- | --- | --- |
| 1 | 新增 `util/keyed-lock.ts`（纯 JS，按 key 串行化的进程内互斥）；转写按"消息+部件+媒体+是否 force"串行、合成按"文本+配置指纹"串行。不同 key 互不阻塞，前一个失败不影响后一个 | `src/util/keyed-lock.ts`（新）、`core/services/transcription-service.ts`、`core/services/tts-service.ts` |
| 2 | 三个仓库各加 `recoverInterrupted(cutoff, now)` / `recoverStaleTts(cutoff, now)`：把**早于阈值（10 分钟）**的 `processing` 收敛成 `failed(interrupted)`；`bootstrap.ts` 启动时调用一次并打日志。不重放、不建队列 —— 只把"不可能再完成"的中间态变得可观测、可显式重试 | `core/ports/repositories.phase45.ts`、`core/ports/repositories.ts`、`storage/repositories/transcriptions.ts`、`storage/repositories/tts-syntheses.ts`、`storage/repositories/messages.ts`、`app/bootstrap.ts` |
| 3 | `insert()` 现在会写 `tts_json`（列 + 占位符 + 值），"插入-读回"对称 | `storage/repositories/messages.ts` |
| 4 | `get()` 读取时校验 sha256；不匹配就当作**不存在**（返回 null）并打一条只含 mediaId/尺寸/前后 12 位摘要的 warn。坏字节再也不会进入处理管线 | `storage/media/local-media-storage.ts` |
| 5 | `put()` 落盘前用 Core 的 `sanitizeFilename` 净化文件名（MIME **故意不动**，见第 11 节） | `storage/media/local-media-storage.ts` |
| + | 新增媒体引用审计（`src/app/media-audit.ts` + `scripts/media-audit.ts` + `npm run media:audit`）：报告 missing / orphaned / unreadable，**只报告不删除** | `src/app/media-audit.ts`（新）、`scripts/media-audit.ts`（新） |
| + | 测试并发上限 `--test-concurrency=4`：全套 30+ 个 mock HTTP 服务并行时出现过偶发 socket 抖动（本会话共 3 次、症状各异、无法复现），限制文件级并行度后连续 3 次全量运行 340/340 稳定 | `package.json` |

---

## 5. 改动文件

新增：`src/util/keyed-lock.ts`、`src/app/media-audit.ts`、`scripts/media-audit.ts`、`scripts/phase45e-smoke.ts`、`test/unit/media-hardening.test.ts`、`docs/PHASE-4.5-E-REPORT.md`。

修改：`core/services/transcription-service.ts`、`core/services/tts-service.ts`、`core/ports/repositories.ts`、`core/ports/repositories.phase45.ts`、`storage/repositories/messages.ts`、`storage/repositories/transcriptions.ts`、`storage/repositories/tts-syntheses.ts`、`storage/media/local-media-storage.ts`、`app/bootstrap.ts`、`frontend/src/pages/chat.tsx`、`package.json`、`README.md`。

**没有新增迁移**：迁移 001–006 审计后没有发现真实缺陷（见第 12 节），因此没有 007。

---

## 6. 有意不动的文件

| 区域 | 结论 |
| --- | --- |
| 微信协议字段（`media_type=4`、`item.type=3`、`voice_item`） | **No change required.** 与 D2 完全一致，没有发现协议 bug |
| SILK 编解码（`voice-codec.ts`） | **No change required.** 行为与实测一致（有 D1 测试锁定） |
| AES/CDN（`aes-media.ts`、`cdn-client.ts`、`media-transport.ts`） | **No change required.** 本轮未发现可复现缺陷 |
| 入站映射 / hydrate 钩子 / 出站 `send()` | **No change required.** 失败隔离与游标语义经审计与测试确认 |
| 迁移 001–006 | **No change required.** 见第 12 节 |
| Core 媒体模型（`media.ts`/`message.ts` 的字段与净化工） | **No change required.** |
| 记忆 / 关系 / 情绪 / 调度 / 主动 / model-router | **No change required.** 本阶段未触碰 |
---

## 7. ASR 并发结果

**发现真实竞态（问题 1）并已修复。**

| 场景 | 修复前 | 修复后（实测） |
| --- | --- | --- |
| 两个并发 `transcribeInboundMessage(同一消息)` | 两次都错过缓存 → **provider 被调用 2 次**，重复付费 | provider 调用 **1 次**；两个调用都拿到 `completed`，其中后到的一个 `cached = true` |
| 重复请求（非并发，顺序） | 已正确复用（D3 幂等） | 不变 |
| `force: true` | 正确忽略缓存重跑 | 不变（锁的 key 含 `force` 标记，不会和普通请求互等） |
| 超时 / AbortSignal / 超大音频 / 超长时长 / 无效响应 / provider 失败 | D3 已覆盖，本轮回归验证 | 不变（E-F 断言失败后 `media.status` 仍为 `available`） |
| 数据库一致性 | 主键 `(message_ref, part_index)` 保证只有一条记录 | 不变（并发下仍然只有一条记录） |
| 进程重启 | **会永久卡在 processing**（问题 2） | 启动时收敛为 `failed(interrupted)`，并且**可以显式重试**（E-C 断言重试后 `completed` 且 provider 被真正调用） |

不变式保持：**转写失败永远不会删除或改变原始 `AudioPart`**（E-F 断言 `transcription.status = failed` 且 `media.status = available`、`mediaId` 不变、字节可完整读回）。

---

## 8. TTS 并发结果

**发现真实竞态（问题 1 的 TTS 版本）并已修复。**

| 场景 | 修复前 | 修复后（实测） |
| --- | --- | --- |
| 两个并发 `synthesizeForText(同一文本)` | 两次都错过缓存 → **provider 被调用 2 次**，并且 `MediaStorage` 里**出现两份音频对象**（后写的 `media_id` 覆盖前者，先写的变成孤儿） | provider 调用 **1 次**；两次结果指向**同一个 mediaId**；存储里只有 1 个对象 |
| 重复请求（顺序） | 已正确复用缓存（D4 幂等） | 不变 |
| `force` | 正确重跑 | 不变（与普通请求不互等） |
| 超时 / AbortSignal / 超长文本 / provider 失败 | D4 已覆盖，本轮回归 | 不变（E-E 断言失败时**新增媒体文件数为 0**） |
| 消息级状态一致性 | `Message.tts` 由 `setTts` 写入 | 不变 |
| 进程重启 | **会永久卡在 processing**（问题 2） | 启动时收敛为 `failed(interrupted)`（`tts_syntheses` 与 `messages.tts_json` 都会收敛） |

不变式保持：**TTS 永远不替换、不改变助手文本**（`attachGeneratedSpeech` 只追加音频部件，**不改 text_render**；失败时只写状态）。审计中没有发现任何路径会修改助手文本 —— **No change required**（行为本身正确，本轮只是用测试锁死）。

---

## 9. 崩溃 / 重启恢复结果

**发现真实问题（问题 2），已用最小机制修复。**

```text
崩溃前：transcriptions.status = processing
        tts_syntheses.status  = processing
        messages.tts_json     = {"status":"processing",...}
   ↓ 进程被杀 / 重启
启动时：recoverInterrupted(now - 10min) / recoverStaleTts(now - 10min)
        → status = failed, error_code = interrupted, error_message 说明原因
   ↓
前端：显示"语音不可用 / 转写不可用"（而不是永远"生成中…"），并且可以点重试
   ↓
重试：真的重新调用 provider（E-C 断言 provider 调用次数 +1 且最终 completed）
```

- 阈值 10 分钟，**远大于**任何一次正常调用（默认超时 20 s），因此不会误标正在进行的任务（E-D 专门断言"新鲜记录不被收敛"）；
- 只做收敛，不做自动重放、不做分布式队列（符合任务书的边界要求）；
- `bootstrap.ts` 里整段包在 try/catch 中：恢复失败不影响启动，下次启动还会再试。

---

## 10. 媒体一致性结果

**发现两个真实问题（问题 4、5），已修复；孤儿策略选择"报告而不删除"。**

| 检查项 | 结果 |
| --- | --- |
| DB 引用 → 存储对象存在 | 新增 `auditMediaReferences()` 能列出 **missing**（E-G 用一条指向不存在 mediaId 的消息验证） |
| 存储对象 → 是否有 DB 引用 | 能列出 **orphaned**（失败/取消残留、删除消息后的残留、以及 TTS `force` 重合成后被覆盖的旧对象） |
| 元数据与字节一致 | **修复前**：`get()` 不校验 checksum（篡改/截断会被静默接受）；**修复后**：校验 sha256，不匹配按"不存在"处理并告警（E-G/E-smoke 用真实篡改字节验证） |
| mediaId / 路径穿越 | `mediaId` 必须匹配 `^[0-9a-f]{32}$`；`get/stat/has` 对非法 id 返回"不存在"，`remove`（写路径）**故意抛错**且不碰文件系统（E-H 覆盖 `../../etc/passwd`、`..\\..\\`、绝对路径、盘符、长度错误、大写 hex 等） |
| 文件名安全 | **修复后**：`put()` 在存储边界净化文件名（E-H 断言 `../../etc/passwd` 落盘后 `filename = "passwd"`，且从不参与路径） |
| 超限媒体 | 写入被拒且**不留下半成品文件**（E-I：25 MiB + 1 → 媒体目录为空） |
| 失败操作的副作用 | 失败/取消的 TTS 不产生任何媒体（E-E）；被拒绝的上传不产生网络调用（既有 C1/C2/C3 测试） |
| 删除消息后的媒体 | 成为 `orphaned`（可被审计列出），**不自动删除** |

**为什么不做自动删除（垃圾回收）**：判断"这个对象将来还会不会被用到"需要引用计数 + 生命周期策略（缓存命中、force 重合成、消息回收站等都会影响），实现成本与误删风险都远高于本阶段的收益。因此选择：**可审计 + 只报告 + 需要时人工清理**（`npm run media:audit`）。这是刻意的最小方案，已记入已知限制。

---

## 11. 安全审计结果

| 检查项 | 结果 |
| --- | --- |
| API Key / 凭据 | **No change required.** 只在 `CredentialStore`（AES-256-GCM）与 provider 实例内；有既有测试断言不出现在错误与日志（D3/D4 各一条），本轮 E-J 再从数据库整表 dump 验证一次 |
| AES 密钥 / `encrypt_query_param` | **No change required.** 只在 `secretMaterial` 内存流转；不落消息、不落日志、不落 API（既有 C1–D2 断言） |
| 原始音频字节 / base64 音频 | **No change required.** E-J 对 `messages` + `transcriptions` + `tts_syntheses` 全表 dump 断言：无 base64、无 `RIFF` |
| 路径穿越 / 任意文件访问 | 修复文件名净化（问题 5）+ 既有 mediaId 白名单；E-H 覆盖 |
| 外部 URL / SSRF | **No change required.** `url.kind === "external"` 永不抓取（C1/C2/C3 各有断言）；ASR/TTS 只访问**配置里的** baseUrl，不接受任何请求级 URL |
| 超大媒体 / 超大文本 | **No change required.** 媒体：存储层 + 出站校验双层；文本：`tts.maxTextLength` 在调用 provider 前拦截（D4 断言 provider 调用数为 0） |
| 畸形协议载荷 | **No change required.** `normalizeMessageParts` 安全降级 + 各 `sanitize*` 有上限；E-J 复查 |
| 音频被当作代码执行 | **No change required.** 生成/收到的音频只作为字节存储与转码，从不解析、不执行 |
| 日志中的敏感值 | 新增的恢复/校验日志只含 `mediaId`、尺寸、前后 12 位摘要、状态计数 —— 无内容、无密钥 |
| `remove()` 语义 | **保持不变**：写路径对非法 id 抛 `DomainError`（4.5-B 既定契约，既有测试 `local-media-storage.test.ts` 锁定）。本轮只是把自己的新测试改对，没有改产品行为 |
---

## 12. 数据库审计结果

| 检查项 | 结果 |
| --- | --- |
| 迁移 001–004（Phase 1–3 既有） | **No change required.** |
| 迁移 005（transcriptions） | **No change required.** 主键 `(message_ref, part_index)` 保证幂等；`status` 有 CHECK 约束；`status`/`media_id` 有索引；全部列可空性符合语义（`text` 只在 completed 有值、`error_*` 只在 failed 有值） |
| 迁移 006（tts_syntheses + messages.tts_json） | **No change required.** 主键 `fingerprint` 就是缓存键；`ALTER TABLE ADD COLUMN` 由迁移器在 `schema_migrations` 保护下只执行一次（前向迁移，每个文件一个事务） |
| 迁移确定性 | **No change required.** `runMigrations` 按文件名排序、逐个在 `BEGIN IMMEDIATE` 中执行，失败即回滚并中止后续 —— 重跑幂等（E-C 在同一 DB 上重复 upsert/恢复验证） |
| 外键正确性 | **No change required.** `messages → conversations → users/characters` 生效（我的新测试第一次忘建父行时被 FOREIGN KEY 直接拒绝，说明约束真在工作）；`transcriptions.message_ref` / `tts_syntheses.message_ref` **故意没有外键**：入库前的身份是渠道消息 id（此时消息行还不存在），加外键会破坏 D3/D4 的幂等设计 —— 这是有意为之，已在本报告记录 |
| 唯一约束 | **No change required.** 见上（两个主键就是幂等键） |
| 索引 | **No change required.** 本轮把"审计要用的查询"走了一遍（`SELECT * FROM messages` 全表、`WHERE media_id IS NOT NULL`），没有发现需要新增索引的热点（媒体审计是显式的一次性动作，不在请求路径） |
| 事务边界 | **No change required（一处已知可接受的折中）**：`attachGeneratedSpeech` 是两条语句（`updateEdited` + `setTts`）。极端情况下进程在两条之间崩溃会留下"有音频部件、没有 tts 状态"或反之的**良性**半状态（音频仍可正常读回，UI 至少显示占位符）。把它做成单事务需要给 ConversationService 注入 DB 句柄（跨层依赖），收益与风险不成比例，故记录而不改 |
| 缺失行处理 | **No change required.** 所有仓库的 `get` 系列返回 `null`，调用方都有明确分支（本阶段新增的恢复语句用 `UPDATE … WHERE`，零行也不会报错） |
| 重启不损坏状态 | **修复后成立**：见第 9 节（问题 2、3 都会破坏"重启示一致"） |

---

## 13. 微信能力声明的决定

`WEIXIN_CAPABILITIES.media` 目前是全 `false`（含 `audio`）。

**决定：保持不变。理由：**

1. 这个声明是**对外可见的能力声明**（`GET /api/channels` 与健康检查会返回），它**不参与任何门控**（出站是否发送媒体由消息部件与渠道实现决定，不看它）；
2. 出站语音虽然已经实现（D1/D2/D4 全链路跑通），但**真机是否把它渲染成原生语音气泡仍未验证**（D2 结论）。把 `audio` 改成 `true` 等于对使用者宣称"这个渠道能发原生语音"，而我们**没有**这个证据；
3. 因此当下它既不是"必须为 false 才能工作"，也不该被改成 true —— 它是 Phase 4 的保守静态声明。等真机验证有了确定结论后，再单独做一个"能力声明与实际能力对齐"的小改动（连同 `image/file/video` 一起）。

**No change required**（并在此明确记录推理，避免后续被当成遗漏）。

---

## 14. 前端审计结果

| 检查项 | 结果 |
| --- | --- |
| pending / processing 展示 | **No change required.** 语音：`语音生成中…`（`tts.status = pending/processing`）；转写：`转写中…` |
| available 展示 | **No change required.** 语音：`语音已生成`；转写：显示文本 |
| failed 展示 | **No change required.** `语音不可用` / `转写不可用` |
| missing（媒体本身不可用） | **已修复**：之前音频部件在 `media.status = failed` 时只显示占位符 `[语音]`，看不出"音频坏了"；现在显示 `音频不可用`（并与转写状态互斥显示，避免同时出现两个矛盾状态） |
| 刷新不会重新触发 TTS | **No change required.** 前端刷新只做 `GET /api/conversations/:id/messages`；合成只由管线（回复送达后）或显式 `POST /api/messages/:id/speech` 触发 |
| 刷新不会重新触发 ASR | **No change required.** 转写只发生在入站处理；且刷新走的是读接口 |
| 重试真的是重试 | **No change required.** "重试"按钮调用 `generateSpeech(id, force=true)` → 忽略缓存重新合成（D4 测试锁定 force 语义） |
| 失败 TTS 不隐藏助手文本 | **No change required.** 文本与语音状态是分开渲染的；`attachGeneratedSpeech` 不改 `text_render` |
| 失败 ASR 不隐藏原始音频 | **No change required.** 音频部件仍在 `parts` 里（占位符 + `音频不可用`/`转写不可用`） |
| 播放器 | **不变**：本阶段不做媒体播放器（任务书明确要求） |

---

## 15. 测试计数（确切）

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **340 / 340 通过**（D4 为 330 → E 新增 10 个加固用例，全部在 `test/unit/media-hardening.test.ts`） |
| 连续 3 次全量运行 | 340 / 340、340 / 340、340 / 340（限制文件级并行度后稳定） |
| 既有测试 | **未削弱、未修改任何既有断言**（本阶段唯一改动的测试文件是我新增的那个） |

新增用例与问题一一对应：

| 用例 | 验证内容 |
| --- | --- |
| E-A | 并发 ASR 只调用 provider 一次；后到者命中缓存；数据库只有一条记录 |
| E-B | 并发 TTS 只调用 provider 一次；两次指向同一 mediaId；媒体目录只有 1 个对象 |
| E-C | 崩溃遗留 processing → 收敛为 `failed(interrupted)`（转写/合成/消息三处）；此后显式重试真的重新调用 provider 并成功 |
| E-D | 新鲜的 processing **不会**被误收敛 |
| E-E | TTS 失败：状态 failed、`mediaId = null`、**新增媒体文件数为 0** |
| E-F | ASR 失败：`transcription.status = failed` 且 `media.status = available`、mediaId 不变、字节可完整读回 |
| E-G | 媒体审计能同时发现 missing / orphaned / unreadable；且**只报告不删除**（orphan 仍在） |
| E-H | 非法 mediaId 无法逃出存储根目录；`remove` 写路径抛错且不碰文件系统；文件名被净化 |
| E-I | 超限媒体被拒且不留半成品文件 |
| E-J | 三张表整表 dump：无音频字节、无 base64、无凭据/协议机密 |

---

## 16. typecheck 结果

```text
pnpm typecheck → exit 0
```

## 17. build 结果

```text
pnpm build → exit 0
```

## 18. 守卫结果

```text
ARCH-1 … ARCH-8 → 8 / 8 通过（fail 0）
```

本阶段新增的 `util/keyed-lock.ts` 是纯 JS（无 node:、无第三方），`app/media-audit.ts` 属于基础设施层，因此 Core 的依赖约束没有被破坏（ARCH-2/ARCH-6 依旧绿）。

## 19. 冒烟结果

```text
smoke:phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 / e → 全部 PASS
```

`smoke:phase45e` 的真实输出（节选）：

```text
CONCURRENCY (ASR): provider 调用次数=1（必须为 1）状态=completed,completed 缓存命中=false,true
CONCURRENCY (TTS): provider 调用次数=1（必须为 1）同一媒体=true 存储对象总数=2（入站音频 1 + 生成的语音 1，没有重复对象）
RESTART RECOVERY: 收敛的转写=1 合成=1 状态=failed/interrupted（重启后必须可观测、可重试）
RESTART RECOVERY: 显式重试后状态=completed（provider 调用次数=1）
TAMPERED MEDIA: get() 返回=null（按不存在处理）
MEDIA AUDIT: referenced=2 stored=3 missing=0 orphaned=1 unreadable=1（只报告，不删除）
FAILED TTS: status=failed errorCode=server_error mediaId=null 新增媒体文件=0（必须为 0）
PHASE 4.5-E SMOKE OK（并发去重 / 崩溃恢复 / 篡改检测 / 引用审计 / 失败无残留）
```

---

## 20. 已知限制（审计后仍然存在，如实列出）

1. **真实服务仍未验证**：`Real Weixin native voice: NOT VERIFIED` / `Real ASR: NOT VERIFIED` / `Real TTS: NOT VERIFIED`（本环境没有任何真实后端/账号，本轮不做假称）。
2. **并发互斥是进程内的**：`keyed-lock` 只覆盖单进程。当前架构是"单进程 + SQLite"（4.5-B 的选择），跨进程/多实例部署时这条保证失效 —— 那时需要数据库层的原子占位（例如把 `processing` 行当作锁）。已记录，不在本阶段实现。
3. **孤儿媒体不自动清理**：只提供 `npm run media:audit` 报告（missing / orphaned / unreadable）。自动 GC 需要引用计数与生命周期策略，属于后续工作。
4. **`attachGeneratedSpeech` 不是单事务**（第 12 节）：崩溃可能留下良性半状态。
5. **启动恢复只收敛、不重放**：`interrupted` 的转写/合成需要用户或调用方显式重试，不会自动重新花钱调用 provider。
6. **D1–D4 阶段的既有边界不变**：微信语音协议字段集合（D2 的不确定性）、SILK 固定 24 kHz（D1）、前端无播放器与无媒体下载接口（D4）等仍然成立。
7. **`WEIXIN_CAPABILITIES` 仍是保守的 false**（第 13 节）。

---

## 21. 明确确认：未开始 Phase 5

**Phase 5 没有开始。** 本阶段没有引入 Agent、工具调用、Browser、多步规划、群聊、多用户能力；
没有实现声音克隆、Live2D、OCR/Vision；没有新增任何 ASR/TTS provider、没有新增媒体类型；
没有改动微信协议与 SILK/AES/CDN 行为；没有触碰记忆 / 关系 / 情绪 / 调度 / 主动消息 / model-router。

---

## 附：命令与结果一览

```text
pnpm test        → 340 / 340 通过（D4: 330 → +10 加固用例；连续 3 次稳定）
pnpm typecheck   → exit 0
pnpm build       → exit 0
pnpm guard       → ARCH-1..8 全通过（8/8）
pnpm media:audit → 可随时运行：报告 missing / orphaned / unreadable（只报告，不删除）
smoke:phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 / e → 全部 PASS

Real Weixin native voice / Real ASR / Real TTS → 全部 NOT VERIFIED（环境无真实服务）
```

Phase 4.5-E 到此结束。Phase 4.5 全部结束。未经确认不会开始 Phase 5。

# Phase 4.5-D3 报告：语音转写（ASR）

> D3 的目标：把 D1/D2 已经解码好的语音**变成文本**，让模型真正"听懂"语音消息。
> 严格范围：只做 ASR 的接入与落地；**没有**实现 TTS、声音克隆、OCR、Vision、Browser、Agent、Live2D、Phase 5。

验证状态（先说结论）：

```text
Real ASR verification: NOT VERIFIED
Reason: 环境里没有可用的真实 ASR 后端（无 API Key、无本地 whisper 服务）
Mock ASR verification: PASS（OpenAI 兼容 multipart 接口的完整往返）
```

---

## 1. 改动文件

新增（Core，零第三方依赖）：

| 文件 | 作用 |
| --- | --- |
| `backend/src/core/model/transcription.ts` | 转写状态模型（`pending/processing/completed/failed`）+ 长度/控制字符净化 + 置信度校验 |
| `backend/src/core/ports/asr.ts` | ASR 端口：`AsrProvider`、`AsrInput/AsrResult`、`AsrProviderRegistry`、错误分类 |
| `backend/src/core/ports/repositories.phase45.ts` | `TranscriptionRepository` 端口（文本 + 元数据，**绝不含音频字节**） |
| `backend/src/core/services/transcription-service.ts` | 转写编排：限制、幂等指纹、错误归一化、状态持久化、日志卫生 |
| `backend/src/providers/asr/openai-compatible-asr.ts` | OpenAI 兼容 `/audio/transcriptions` Provider（multipart，无 SDK） |
| `backend/src/providers/asr/echo-asr.ts` | 确定性占位 Provider（零配置/零网络；明确返回 language=null、confidence=null） |
| `backend/src/providers/asr/registry.ts` | ASR Provider 注册表（复用既有 ProviderConfig + CredentialStore） |
| `backend/src/storage/migrations/005_transcriptions.sql` | `transcriptions` 表（只存文本与元数据） |
| `backend/src/storage/repositories/transcriptions.ts` | 仓储实现（upsert / get / listByMessage / findCompleted / delete） |
| `backend/src/api/routes/messages.ts`（改造） | 新增 `POST /api/messages/:id/transcribe`（**显式**重新转写；force 才忽略缓存） |
| `backend/test/helpers/mock-asr-server.ts` | mock ASR 服务（真实 multipart 解析 + 可编排的响应/错误） |
| `backend/test/unit/transcription-service.test.ts` | 服务层测试（15 个用例） |
| `backend/test/integration/asr-provider.test.ts` | Provider 集成测试（6 个用例，真实 HTTP） |
| `backend/scripts/phase45d3-smoke.ts` | 端到端冒烟（成功路径 + 失败路径 + SQLite 检查 + 幂等） |

修改：

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/model/message.ts` | `AudioPart` 增加可选 `transcription`；`partsToText` 输出 `[语音] 转写：…`；`normalizeMessageParts` 对 `transcription` 做净化 |
| `backend/src/core/services/messaging-pipeline.ts` | 入站落库前调用转写（可选依赖；失败只记日志） |
| `backend/src/app/bootstrap.ts` | 装配 ASR 注册表 + 转写服务；`reloadProviders()` 同时重建 ASR 注册表；容器暴露 `transcription` 与 `repos.transcriptions` |
| `backend/package.json` | 增加 `smoke:phase45d3` |
| `frontend/src/lib/types.ts` | 语音部件 DTO 增加 `transcription` |
| `frontend/src/lib/parts.ts` | 新增 `audioTranscription()`（none/pending/completed/failed 展示状态） |
| `frontend/src/pages/chat.tsx` | 语音消息下方展示：🎤 语音消息 + 转写中… / 转写文本 / 转写不可用 |
| `frontend/src/styles.css` | 一条 `.transcript` 样式 |
| `README.md` | 进度、命令、测试数量 |

**没有修改**：微信协议（`media_type=4`、item type `3`、`voice_item` 字段）、SILK 编解码（voice-codec.ts）、AES/CDN（media-transport.ts、cdn-client.ts）、MediaStorage、MediaTransport、入站映射（inbound-mapper.ts）、出站发送（sender.ts）、记忆 / 关系 / 情绪 / 调度 / 主动 / model-router。

---

## 2. ASR 架构

```text
Core（平台无关）                          providers/（可替换实现）
──────────────────────────────           ──────────────────────────────
AudioPart.transcription                  AsrProvider
   ↑                                      ├─ openai-compatible（/audio/transcriptions）
TranscriptionService ── AsrInput ───────► ├─ echo（确定性占位，零网络）
   │   （bytes + mime + duration +         └─ 未来的本地 whisper/faster-whisper/FunASR…
   │     language + AbortSignal）              只要实现同一个端口，Core 不改一行
   ├── MediaStorage（取音频字节）
   └── TranscriptionRepository（存文本与元数据）
```

- Core 只认识 `core/ports/asr.ts` 的接口：**不认识** Whisper、OpenAI、faster-whisper、FunASR 或任何云厂商；
- Provider 通过 `ProviderConfig`（与 LLM 同一张表/同一套凭据规则）配置，由组合根 `bootstrap.ts` 装配；
- 端口输入是"字节 + MIME + 时长 + 语言提示 + AbortSignal"，**不暴露文件系统路径**；
- 结果里 `language / durationMs / confidence` 只有 provider 真的返回才非 null（`绝不编造`，有测试断言三种 null 情况）。

---

## 3. Provider 实现

| Provider | 说明 |
| --- | --- |
| `openai-compatible`（本阶段的主力实现） | `POST <baseUrl>/audio/transcriptions`，multipart：`file`（音频字节，D1 解出的 WAV 可直接用）+ `model` + `language`（可选）+ `response_format=json`。只用内置 `fetch/FormData/Blob`，**零 SDK**。可直接对接 OpenAI、Groq、whisper.cpp server、faster-whisper-server、LiteLLM 等兼容服务。响应映射：`text` 必填（空文本判为 failure）；`language` 原样；`duration` 秒 → 毫秒；`confidence` 仅当存在且在 [0,1] 内 |
| `echo-asr`（零配置占位） | 与既有 echo LLM provider 同思路：不联网也能把整条链路跑通、让测试完全确定性。它**不是**语音识别：不产出语言/置信度（恒为 null），文本明确标注是占位 |
| 未来的实现 | 本地 whisper / faster-whisper / FunASR / 其他云：只需实现 `AsrProvider` 并在注册表里多一个分支，Core 与消息逻辑不动 |
---

## 4. 配置

沿用项目既有约定：**settings 表（键值）+ providers 配置表 + 加密凭证存储**。全部有默认值，ASR **默认关闭**。

| 设置键 | 默认值 | 含义 |
| --- | --- | --- |
| `asr.enabled` | `false` | 是否启用转写（默认关闭 = 行为与 D2 完全一致） |
| `asr.providerId` | `null` | 用哪个 provider（对应 providers 表里的 id，例如 `asr` 或 `echo`） |
| `asr.model` | `null` | 模型覆盖；为 null 时用 provider 配置里的 `defaultModel` |
| `asr.language` | `null` | 语言提示（例如 `zh`）；null 表示让 provider 自己判断 |
| `asr.timeoutMs` | `20000` | 单次转写超时（HTTP 级 + 服务级双保险） |
| `asr.maxDurationMs` | `300000` | 允许转写的最大音频时长（超过不调用 provider） |
| `asr.maxBytes` | `26214400` | 允许转写的最大音频字节数（与 `MEDIA_LIMITS.maxMediaBytes` 一致） |
| `asr.configVersion` | `"v1"` | 配置版本号；改变它可以让已完成的结果失效（策略见第 10 节） |

- **密钥永远不在配置里**：provider 的 `credentialRef` 指向 CredentialStore（AES-256-GCM 密封），只在 Provider 实例内部解密使用；日志与错误里都没有密钥（有测试断言）。
- 配置改动后调用 `reloadProviders()` 会**同时重建 ASR 注册表**，无需重启进程。

---

## 5. 消息流程

```text
微信语音消息
  → （D1/D2 既有链路）下载 → AES 解密 → SILK 解码 → WAV 入库 → AudioPart{media.status=available}
  → MessagingPipeline 入站处理（落库之前）：
       TranscriptionService.transcribeInboundMessage(message)
         · 逐个音频部件：前置检查 → 幂等检查 → 限额检查 → 调 provider
         · 结果写进 TranscriptionRepository，并作为 part.transcription 回到 parts
  → appendUserMessage(parts)     ← 音频部件**原样保留**，只多了一个 transcription
  → textRender / ContextEngine / LLM / 记忆抽取看到的都是同一份内容：
       "[语音] 转写：今天天气不错，我们一起出去走走吧（语音 1.2s）"
```

- 转写在**落库之前**完成：模型回复时就已经"听懂"，不需要第二轮。
- 转写是**附加表示**，不是替换：`AudioPart.media` 及其 `status` 完全不变（有测试与冒烟断言 `media.status === "available"` 与转写失败同时成立）。
- 转写**不会自动变成记忆**：它先作为对话内容存在；是否进记忆由既有记忆系统按自己的门控决定（本阶段未改记忆系统）。

---

## 6. 转写存储

```text
CREATE TABLE transcriptions (
  message_ref, part_index, status, text, language, duration_ms, confidence,
  provider, model, error_code, error_message, media_id, fingerprint, cached,
  created_at, updated_at, PRIMARY KEY (message_ref, part_index)
)
```

- **只存文本与元数据**，音频永远只在 `<dataDir>/media/...`（冒烟直接查 SQLite：所有消息的 `content_json` 里没有 SILK base64、没有 WAV base64、没有协议参数）。
- `message_ref` 用**渠道消息 id**（入站与后续显式重试共用同一身份），没有渠道 id 时退回落库消息 id —— 这是幂等能命中的关键（冒烟里验证过：身份不一致时会被重复识别，已修正）。
- 读取边界同样净化：长度上限、控制字符清理、`completed` 之外不带文本、越界置信度丢弃（`绝不夹逼成 0/1`）。

---

## 7. ContextEngine 集成

- `partsToText` 对语音部件的新行为：有 `transcription.completed` → `[语音] 转写：<文本>（语音 Ns）`；没有 → 仍然是 `[语音]` 占位符（不伪造）。
- 旧字段 `transcript` **保持历史渲染**（就是文本本身），既有测试与既有数据行为零变化。
- 上下文里**没有**音频字节，也没有 `[object Object]`（有断言）。
- 冒烟里可以看到真实链路：模型收到的用户消息文本就是 `[语音] 转写：今天天气不错…`，随后角色正常回复。

---

## 8. 失败处理

失败**不会**影响音频，也**不会被伪装成空文本**：

| 情况 | transcription.status | errorCode | 音频 |
| --- | --- | --- | --- |
| ASR 未启用 | failed | `disabled` | 保持 available |
| 没有可用 provider / 凭据缺失 | failed | `configuration_error` | 保持 available |
| 音频超 `maxBytes` | failed | `too_large` | 保持 available，**不调用 provider** |
| 时长超 `maxDurationMs` | failed | `too_long` | 保持 available，**不调用 provider** |
| 音频不可用 / 没有 mediaId | failed | `unsupported_audio` | 保持原状态 |
| provider 超时 | failed | `timeout` | 保持 available |
| 调用方取消（AbortSignal） | failed | `aborted` | 保持 available |
| 上游 401 / 403 / 429 / 5xx | failed | `unauthorized/forbidden/rate_limited/server_error` | 保持 available |
| 上游返回非 JSON 或空文本 | failed | `invalid_response` | 保持 available |
| 网络错误 | failed | `network` | 保持 available |

错误分类复用既有的 `ProviderError`（`core/model/provider-error.ts`），**没有**另立一套；`transcription.status` 与 `media.status` 是两个独立维度，pipepline 里转写阶段整体被 try/catch 包住 —— 即使转写代码本身抛异常，消息也照常落库与回复。

---

## 9. 资源限制

- `asr.maxBytes`（默认 25 MiB）与 `asr.maxDurationMs`（默认 300 s）：**在调用 provider 之前**判断，超限直接 failed，零网络请求（测试断言 provider 调用次数为 0）。
- `asr.timeoutMs`（默认 20 s）：服务层 `AbortController` + provider 内部 HTTP 超时双层保护。
- `AbortSignal`：从管线一路传到 provider；取消时归类为 `aborted`（优先级高于 timeout —— 只看信号状态，不信 provider 抛什么）。
- 不解析音频内容、不解码视频/文件、不执行任何上传内容；MIME 不在白名单时 provider 层直接拒绝（`audio/silk` 这种非标准容器不会被偷偷送去识别）。
- 每次转写只读一次 MediaStorage 的字节（同一份字节同时用于判断大小与发送）。

---

## 10. 成本 / 幂等行为

- **幂等指纹**：`configVersion | providerId | model | language | mediaId | 音频字节数`。
  - 命中"已完成 + 同一指纹" → 直接复用（`cached: true`），**不再调用 provider**（测试断言调用次数不变）；
  - 指纹变化（换模型/换 provider/换语言/改 `configVersion`）→ 认为是不同的识别任务，允许重新识别（这是刻意的策略，不是意外重复）；
  - `force: true`（显式请求，例如 `POST /api/messages/:id/transcribe`）忽略缓存。
- **没有自动重试**：provider 层不做无限重试；失败只记录状态，等待用户的显式重试或下一次配置变更。这一点是刻意的：ASR 是按量计费的外部依赖，静默重试会变成"看不见的成本"。
- 冒烟里验证：同一音频第二次触发时新增 provider 调用数 = **0**。
---

## 11. 测试与确切计数

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **309 / 309 通过**（0 失败；D2 为 287 → D3 新增 22：服务层 15 + provider 集成 6 + （`partsToText` 相关断言并入上述文件）） |
| 新增测试文件 | `test/unit/transcription-service.test.ts`（15 / 15）、`test/integration/asr-provider.test.ts`（6 / 6） |
| 既有测试 | 全部保持通过，**未放宽任何断言**（唯一调整是 D3 之前就存在的 `old transcript` 渲染契约：保持原样不变） |

对应任务书的 18 项要求：

| # | 要求 | 覆盖 |
| --- | --- | --- |
| 1 | AudioPart 能进入 ASR | 服务层：`AudioPart.available` → `completed` |
| 2 | 成功转写 | 文本/language/durationMs/confidence/provider/model 全部落库并回填到 parts |
| 3 | 失败转写 | `ProviderError(server_error)` → `failed` + `text=null` |
| 4 | 超时 | 慢 provider + `asr.timeoutMs=30` → `errorCode=timeout` |
| 5 | AbortSignal 取消 | 外部 abort → `errorCode=aborted`（优先于 timeout） |
| 6 | 超大小在 provider 调用前拒绝 | `asr.maxBytes=8` → `too_large`，provider 调用次数 0 |
| 7 | 超时长在 provider 调用前拒绝 | `asr.maxDurationMs=500` + 5 s 音频 → `too_long`，调用次数 0 |
| 8 | provider 错误归一化 | 401/429/500/非 JSON/空文本 → `unauthorized/rate_limited/server_error/invalid_response` |
| 9 | ASR 失败后音频仍 available | 断言 `media.status === "available"` + `transcription.status === "failed"` |
| 10 | 落库不含音频字节 | 单元层查 `transcriptions` 行；冒烟层查所有消息 `content_json`（0 条泄漏） |
| 11 | 转写进入 ContextEngine/模型输入 | `partsToText` 断言 `[语音] 转写：…`；冒烟里模型实际收到该文本 |
| 12 | 同一消息不重复识别 | 第二次调用 `cached=true` 且调用次数不变；`force` 才重新识别；模型变化允许重新识别 |
| 13 | mock provider 无需外网 | mock ASR 服务 + echo provider；所有测试不访问外网 |
| 14 | 凭据不进日志 | provider 测试断言错误信息与 details 不含 API Key；服务测试断言日志无字节/无完整转写 |
| 15 | 一条失败不阻塞其它 | 同消息两条语音：第一条失败、第二条成功；文字部件原样保留 |
| 16 | 空/非法转写安全处理 | 上游空文本 → `invalid_response`（不是"成功但空"）；净化层截断 20k 文本、清理控制字符、丢弃越界置信度 |
| 17 | 语言只在 provider 真给时保留 | 未返回 → `null`（断言）+ 不发送 `language` 字段 |
| 18 | 置信度只在 provider 真给时保留 | 未返回 → `null`；越界 → 丢弃（不夹逼） |

---

## 12. typecheck 结果

```text
pnpm typecheck → exit 0（后端）
```

（前端也通过了 `tsc --noEmit`：`types.ts / parts.ts / chat.tsx` 改动无类型错误）

---

## 13. build 结果

```text
pnpm build → exit 0
```

---

## 14. 架构守卫结果

```text
ARCH-1 … ARCH-8 → 8 / 8 通过（fail 0）
```

- **ARCH-6（Core 零第三方运行时依赖）**：ASR 端口与转写服务都只用 `node:*` 与 Core 内部模块；`silk-wasm` 只在 `channels/weixin/media/voice-codec.ts`，ASR 的 HTTP 只用内置 `fetch/FormData/Blob` —— **没有给 Core 增加任何依赖**。
- **ARCH-1/ARCH-4（Core 无平台字样 / 渠道标识只在 channels/）**：转写层里没有 `weixin/silk/CDN` 字样；`asr`、`transcription` 是能力名而不是平台名。
- **ARCH-7**：物理删除 `channels/weixin` 后 `src` 仍能类型检查（ASR 与微信完全解耦）。
- Core 改动是**最小且必要**的：`AudioPart` 增加一个可选 `transcription` 字段 + `partsToText` 一行渲染 + `normalizeMessageParts` 一处净化 + 管线一个可选依赖。没有改动任何既有字段语义。

---

## 15. 冒烟结果

```text
smoke:phase4     → PHASE 4 SMOKE OK
smoke:phase45b   → PHASE 4.5-B SMOKE OK
smoke:phase45c1  → PHASE 4.5-C1 SMOKE OK
smoke:phase45c2  → PHASE 4.5-C2 SMOKE OK
smoke:phase45c3  → PHASE 4.5-C3 SMOKE OK
smoke:phase45d1  → PHASE 4.5-D1 SMOKE OK
smoke:phase45d2  → PHASE 4.5-D2 SMOKE OK
smoke:phase45d3  → PHASE 4.5-D3 SMOKE OK
```

`smoke:phase45d3` 的真实输出（节选）：

```text
ASR SETTINGS: enabled=true provider=asr language=zh（默认关闭；这里显式打开）
SUCCESS PATH: media.status=available（音频仍然可用）transcription.status=completed
              language=zh confidence=0.97 provider=asr model=whisper-mock
TRANSCRIPT (进入消息文本): "今天天气不错，我们一起出去走走吧"
MESSAGE TEXT RENDER: "[语音] 转写：今天天气不错，我们一起出去走走吧（语音 1.2s）"
REPLY -> WEIXIN: "（角色）我听到你说的话了。"（模型看到的是转写文本，不是 [语音] 占位符）
MOCK ASR CALLS: 1，语言提示=zh，音频字节=57644
SQLITE CHECK: 2 条消息中，含音频字节/协议参数的 0 条（必须为 0）
IDEMPOTENCY: 再次触发转写时新增的 ASR 调用次数=0（已完成的同一音频必须复用，为 0）
FAILURE PATH: media.status=available（音频必须仍然 available）transcription.status=failed
              errorCode=server_error（错误必须可观测，不能变成空文本）
FAILURE PATH: 消息仍然被处理，回复条数=2
REAL ASR VERIFICATION: NOT VERIFIED（本轮用的是 mock ASR 服务，不是真实识别后端）
PHASE 4.5-D3 SMOKE OK（转写成功进入上下文 / 失败不影响音频 / SQLite 无音频字节 / 幂等复用）
```

---

## 16. 真实 ASR 验证状态

```text
Real ASR verification: NOT VERIFIED
Reason: 环境里没有可用的真实 ASR 后端（无 API Key、无本地 whisper 服务）
```

- 本轮**没有**真实识别后端：所有验证都在 mock ASR 服务（真实 HTTP、真实 multipart、真实错误码）上完成。
- **没有伪造**任何 provider 结果：mock 返回什么文本，冒烟里就显示什么文本，并且脚本自己打印 NOT VERIFIED。
- 已验证的是**接口契约与链路**：请求形状（multipart 字段、文件名、语言提示、音频字节与 MediaStorage 一致）、响应映射（text/language/duration 秒→毫秒/confidence）、错误分类、超时与取消、限额、幂等、落库与上下文集成。
- 未验证的是**识别质量与真实后端行为**：识别准确率、真实服务的字段差异、真实限流表现。
- 如果之后要接真实后端，最小改动是：在设置页把一个 provider 的 baseUrl 指向真实服务并设好 `asr.providerId`（本阶段实现已支持 `openai-compatible` 兼容服务；本地 whisper.cpp/faster-whisper 通常也提供同形状端点）。

---

## 17. 已知限制

1. **真实 ASR 未验证**（第 16 节）；识别质量完全取决于所接后端。
2. **只支持 OpenAI 兼容的 multipart 接口**：目前没有 `/audio/transcriptions` 之外形状的适配器（FunASR 私有协议、WebSocket 流式等需要新 provider）。
3. **只接受标准音频容器**：`audio/silk` 不会被送去识别（D1 正常路径已经产出 WAV；只有编解码缺失降级时才会是 SILK，此时转写会以 `invalid_response` 失败，音频仍可用）。
4. **同步转写**：转写在入站处理里同步完成（受 `asr.timeoutMs` 约束），因此模型回复会等这段时间；没有做"先回复后补转写"的异步模式（那会让模型第一次看不到内容）。
5. **不做重试**：失败后不会自动重试（避免不可见成本）；重新识别需要显式调用或配置变更。
6. **不生成 summarization/编解码之外的音频处理**：没有降噪、没有说话人分离、没有情绪识别。
7. **`WEIXIN_CAPABILITIES.media.audio` 仍为 `false`**：Phase 4 遗留的静态声明，与前几个阶段保持一致。
8. **前端只有只读展示**：语音消息显示录音样式的标签与转写文本/状态，没有音频播放器，也没有 ASR 管理界面。
9. **`cached` 标记不落库为"派生"字段**：它由服务在返回时设置，数据库里的 `cached` 列保留给将来的统计使用（当前始终写入 0）。

---

## 18. 明确确认：TTS / D4 未实现

**Phase 4.5-D4（TTS / 语音合成）没有实现，一行代码都没写。** 同样明确没有实现：
声音克隆、变声、OCR、Vision、Browser、Agent、Live2D、Phase 5。

D3 只做了：语音 → 文本（ASR 接入、配置、状态模型、资源限制、幂等、存储、上下文集成、前端展示、测试与冒烟）。

---

## 附：命令与结果一览

```text
pnpm test        → 309 / 309 通过（D2: 287 → +22）
pnpm typecheck   → exit 0
pnpm build       → exit 0
pnpm guard       → ARCH-1..8 全通过（8/8）
smoke:phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 → 全部 PASS

Real ASR verification: NOT VERIFIED（无真实后端）
```

Phase 4.5-D3 到此结束。下一步（未开始）：**D4 — TTS（语音合成）**。

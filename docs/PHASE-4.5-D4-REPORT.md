# Phase 4.5-D4 报告：语音合成（TTS）

> D4 的目标：让角色能把回复**说出来**。文字永远是权威表示，语音是可选附加表示。
> 严格范围：只做 TTS 接入与落地；**没有**实现声音克隆、Live2D、Browser、Agent、Phase 5。

验证状态（先说结论）：

```text
Real TTS verification: NOT VERIFIED
Reason: 环境里没有可用的真实 TTS 后端（无 API Key、无本地 Piper/CosyVoice/Fish Speech 服务）
Mock TTS verification: PASS（OpenAI 兼容 /audio/speech 的完整往返 + 真实 WAV 字节）
Native Weixin voice rendering: NOT VERIFIED（D2 结论不变：未在真机验证原生语音气泡）
```

---

## 1. 改动文件

新增（Core，零第三方依赖）：

| 文件 | 作用 |
| --- | --- |
| `backend/src/core/model/tts.ts` | TTS 状态模型（`pending/processing/completed/failed/skipped`）+ 输出格式与 MIME 映射 + 净化 |
| `backend/src/core/ports/tts.ts` | TTS 端口：`TtsProvider`、`TtsInput/TtsResult`、`TtsProviderRegistry` |
| `backend/src/core/services/tts-service.ts` | 合成编排：限额、指纹缓存、错误归一化、MediaStorage 写入、状态持久化 |
| `backend/src/util/hash.ts` | 纯 JS 稳定哈希（Core 不允许 node:/第三方依赖 → 用它做文本指纹） |
| `backend/src/providers/tts/openai-compatible-tts.ts` | OpenAI 兼容 `/audio/speech` Provider（JSON 请求 → 音频字节；只用内置 fetch） |
| `backend/src/providers/tts/echo-tts.ts` | 确定性占位 Provider（生成**真实可解码 WAV**，零网络） |
| `backend/src/providers/tts/wav.ts` | provider 层私有的 44 字节 WAV 写入（依赖方向不允许 providers → channels） |
| `backend/src/providers/tts/registry.ts` | TTS 注册表（复用既有 ProviderConfig + CredentialStore） |
| `backend/src/storage/migrations/006_tts.sql` | `tts_syntheses` 表 + `messages.tts_json` 列 |
| `backend/src/storage/repositories/tts-syntheses.ts` | 合成记录仓储（只存引用与元数据） |
| `backend/test/helpers/mock-tts-server.ts` | mock TTS 服务（真实 HTTP + 可编排响应/错误/响应头） |
| `backend/test/unit/tts-service.test.ts` | 服务层测试（13 个用例） |
| `backend/test/integration/tts-provider.test.ts` | Provider 集成测试（7 个用例，真实 HTTP） |
| `backend/scripts/phase45d4-smoke.ts` | 端到端冒烟（成功路径 + 失败路径 + SQLite 检查 + 幂等 + 既有语音出站链路） |

修改：

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/model/message.ts` | `Message` 增加可选 `tts`（消息级语音状态）；`MessagePart` 不需要新类型（复用既有 `AudioPart`/`FilePart`） |
| `backend/src/core/services/conversation-service.ts` | 新增 `attachGeneratedSpeech()`（追加音频部件但**不改 text_render**）、`setSpeechState()`、`getMessage()` |
| `backend/src/core/services/messaging-pipeline.ts` | 文字回复落库并送达后，**后台**合成语音；成功则挂到该助手消息 + 作为第二条出站消息发送；失败只更新状态 |
| `backend/src/core/ports/repositories.ts` | `MessageRepository` 增加 `setTts()` |
| `backend/src/storage/repositories/messages.ts` | 读写 `tts_json`（读取边界净化；插入时默认 NULL，由 `setTts` 写入） |
| `backend/src/api/dto/mappers.ts` | 消息 DTO 暴露 `tts`（没有语音时字段缺席） |
| `backend/src/api/routes/messages.ts` | 新增 `POST /api/messages/:id/speech`（显式生成/重试；只生成不投递） |
| `backend/src/app/bootstrap.ts` | 装配 TTS 注册表与服务；`reloadProviders()` 一并重建；容器暴露 `tts` 与 `repos.ttsSyntheses` |
| `backend/package.json` | 增加 `smoke:phase45d4` |
| `frontend/src/lib/types.ts` | `MessageDto.tts` |
| `frontend/src/lib/api.ts` | `generateSpeech()` |
| `frontend/src/pages/chat.tsx` | 助手消息展示 🔊 语音生成中… / 语音已生成 / 语音不可用 + 失败时"重试" |
| `README.md` | 进度、命令、测试数量 |

**没有修改**：微信协议（`media_type=4`、item type `3`、`voice_item` 字段）、SILK 编解码、AES/CDN、MediaStorage/MediaTransport、入站映射、ASR 链路（D3）、记忆/关系/情绪/调度/主动/model-router。

---

## 2. TTS 架构

```text
Core（平台无关）                          providers/（可替换实现）
──────────────────────────────           ──────────────────────────────
Message.tts（消息级状态）                 TtsProvider
   ↑                                      ├─ openai-compatible（/audio/speech）
TtsService ── TtsInput ──────────────────► ├─ echo（确定性 WAV，零网络）
   │   （text + voice + language +          └─ 未来的 Piper / CosyVoice / Fish Speech / Edge TTS…
   │     model + speed + format + Abort）       只要实现同一端口，Core 一行不改
   ├── MediaStorage.put（音频字节 → mediaId）
   └── TtsSynthesisRepository（只存引用与元数据）
```

- Core 只认识 `core/ports/tts.ts`：不认识 OpenAI、ElevenLabs、Edge TTS、Piper、CosyVoice、Fish Speech；
- 状态是**消息级**的（一段语音代表整条回复），与 D3 的**部件级**转写状态彼此独立：一条消息可以"有转写没语音"，也可以"有语音没转写"；
- `TtsResult` 里的 `durationMs / sampleRate` 只有 provider 真的返回才非 null（echo 会返回真实值，OpenAI 兼容实现读取可选响应头，不猜）。

---

## 3. Provider 实现

| Provider | 说明 |
| --- | --- |
| `openai-compatible`（主力） | `POST <baseUrl>/audio/speech`，JSON：`{model, input, voice, response_format, speed?}`，响应体是**音频字节**。MIME 优先取上游 `Content-Type`（否则用请求格式对应的 MIME）；时长/采样率取可选的 `x-audio-duration-ms` / `x-audio-sample-rate` 响应头，没有就 null。可以对接 OpenAI 及任何同形状的自建/本地服务。**没有**把 `language` 塞进请求体（不是该接口的字段，不发明） |
| `echo-tts`（零配置占位） | 不联网、确定性：按文本哈希决定基频、按时长生成 24 kHz/单声道/16bit PCM 并打成 WAV。它**不是语音合成**（没有人声），但产出的是**真实、可解码、可被 D1 编码成 SILK** 的音频，因此出站语音链路能被真正验证 |
| 未来的实现 | Piper / CosyVoice / Fish Speech / Edge TTS：实现 `TtsProvider` 并在注册表加一个分支即可 |

---

## 4. 配置

沿用项目既有约定（settings 键值 + providers 表 + 加密 CredentialStore），**全部有安全默认值，TTS 默认关闭**。

| 设置键 | 默认值 | 含义 |
| --- | --- | --- |
| `tts.enabled` | `false` | 是否启用（关闭时行为与 D3 完全一致） |
| `tts.providerId` | `null` | 使用哪个 provider（providers 表里的 id） |
| `tts.model` | `null` | 模型覆盖（null → provider 的 `defaultModel`） |
| `tts.voice` | `null` | 音色（openai 兼容实现必须能拿到音色，否则明确失败） |
| `tts.language` | `null` | 语言（仅作为配置记录，当前 openai 兼容接口不使用它） |
| `tts.speed` | `null` | 语速（null = 不发送该字段） |
| `tts.timeoutMs` | `20000` | 单次合成超时（服务层 + provider HTTP 双层） |
| `tts.maxTextLength` | `4000` | 最大合成文本长度（超限**不调用 provider**） |
| `tts.outputFormat` | `"wav"` | 期望输出容器（非法值回落到 wav） |
| `tts.delivery` | `"voice"` | 投递方式：`voice`（原生语音）/ `file`（音频文件）/ `text`（只回文本） |
| `tts.configVersion` | `"v1"` | 配置版本号（参与指纹；改变它可以让缓存失效） |

密钥只存在 CredentialStore（provider 的 `credentialRef`），只在 Provider 实例内部解密；日志与错误里都没有密钥，也不记录完整待合成文本（只记录长度与哈希）。
---

## 5. 消息流程（文字永远先活下来）

```text
用户消息
  → LLM 生成回复
  → 助手消息（纯文本）落库          ← 权威内容
  → 文字回复发送（渠道 send）
  → 【后台】TTS：
       成功 → MediaStorage.put(WAV, origin=generated)
            → conversations.attachGeneratedSpeech(消息, AudioPart, tts)
              （追加音频部件；**不改 text_render**，上下文里不会混进 [语音]）
            → 作为**第二条出站消息**发送：既有 D1/D2 语音链路（WAV → SILK → voice_item）
       失败 → 只写消息级 tts.status = failed（带 errorCode），不产生任何媒体消息
```

- `tts.delivery` 决定第二条消息的类型：`voice`（既有语音链路）或 `file`（既有文件链路），`text` 则完全不合成；
- 语音**不会**变成新的用户消息，**不会**被回灌 ASR，**不会**产生记忆（`13 的三条约束都有对应断言/实现约束）；
- 转写（D3）与合成（D4）方向相反、互不调用：ASR 只看入站语音，TTS 只看助手文本。

---

## 6. MediaStorage 集成

- 合成结果通过 `MediaStorage.put({ bytes, mimeType, filename: null, origin: "generated" })` 入库，返回 `mediaId`；
- `origin = "generated"`：这是**系统生成**的媒体，与渠道来的媒体（`origin = "channel"`）区分开；
- 生成的音频随后进入既有音频管线（D1 的 SILK 编码、D2 的 `voice_item`、4.5-B 的 AES/CDN）；
- 数据库里只有 `mediaId` + 元数据：`tts_syntheses` 表存指纹/状态/媒体引用/错误；`messages.tts_json` 存消息级状态。**没有任何音频字节**（冒烟直接查 `content_json` 与 `tts_json`：0 条含字节）。

---

## 7. 微信集成

- **没有改动任何微信协议字段**：`getuploadurl.media_type = 4`、`item.type = 3`、`voice_item.media{encrypt_query_param, aes_key, encrypt_type}` 与 D2 完全一致（冒烟打印了实际线上形状来证明）；
- 生成的 WAV 由既有 D1 编解码器编成 SILK（冒烟验证：CDN 上解密回来的字节 `isSilk = true`，解码回 1040 ms）；
- 出站消息体复用既有 `send()` 路径（幂等键 `<messageId>:speech:voice:0`），没有新增任何发送逻辑；
- **不宣称** TTS 一定能在真机上渲染成原生语音气泡：D2 的结论（`Native Weixin voice rendering: NOT VERIFIED`）保持不变；
- `tts.delivery = "file"` 提供可靠降级：音频走既有文件通道（人工选择，**不做**对客户端静默渲染失败的自动探测）。

---

## 8. 失败行为

| 情况 | 文字回复 | message.tts | 音频 |
| --- | --- | --- | --- |
| TTS 未启用 | 正常送达 | `failed / disabled`（或完全不产出，`delivery=text`） | 无 |
| 没有 provider / 凭据缺失 | 正常送达 | `failed / configuration_error` | 无 |
| 文本超 `maxTextLength` | 正常送达 | `failed / too_long`，**provider 调用数 = 0** | 无 |
| 上游 401/403/429/5xx | 正常送达 | `failed / unauthorized·forbidden·rate_limited·server_error` | 无 |
| 超时 | 正常送达 | `failed / timeout` | 无 |
| 调用方取消 | 正常送达 | `failed / aborted`，**不留下任何媒体引用** | 无 |
| 上游返回 200 但空音频 | 正常送达 | `failed / invalid_response` | 无 |
| 没有可用音色 | 正常送达 | `failed / model_unavailable`，**provider 调用数 = 0** | 无 |
| 输出格式非法 | 正常送达 | `failed / unsupported_format` | 无 |

- 失败分类复用既有 `ProviderError` 体系（没有另立一套）；
- 合成阶段整体被包在 `scheduleSpeech().catch()` 里：**即使 TTS 代码本身抛异常，文字回复与整条消息也不会受影响**；
- `state.mediaId` 在非 `completed` 状态下恒为 null（净化层强制），因此不可能出现"失败但声称有音频"。

---

## 9. 幂等 / 缓存行为

- **指纹**：`configVersion | providerId | model | voice | language | speed | outputFormat | 文本哈希`（文本哈希是纯 JS 64 位稳定哈希，另存文本长度做二次校验）；
- 命中"已完成 + 同指纹" → 直接复用（`cached: true`），**不再调用 provider**（测试：第二次调用 provider 次数不变；冒烟：再次请求语音时新增调用 = 0）；
- `voice` / `model` / 文本变化 → 指纹变化 → 视为新的合成任务（有测试逐项断言）；
- `force: true`（`POST /api/messages/:id/speech`）才允许忽略缓存；
- **不会**因为前端刷新而重新合成：合成只发生在"回复生成后"一次，或用户显式请求时；
- 没有自动重试循环：失败就停在 `failed`，等显式重试。

---

## 10. 限额

- `tts.maxTextLength`（默认 4000 字符）：**在调用 provider 之前**判断，超限直接 `too_long`（provider 调用数为 0）；
- `tts.timeoutMs`（默认 20 s）：服务层 `AbortController` + provider HTTP 超时；
- `AbortSignal`：从管线/API 一路传到 provider；取消归类为 `aborted`（只看信号状态，优先于 timeout），取消**不会**留下媒体文件（测试断言 store 里没有资产）；
- provider 错误归一化 + 失败隔离（第 8 节）；
- 不解析、不执行生成的音频（它只是字节；编解码仍只有 D1 那一处）；
- 生成音频的大小天然受 `MEDIA_LIMITS.maxMediaBytes` 约束（MediaStorage 写入时校验）。

---

## 11. 前端改动（最小）

- 助手消息下方：🔊 语音 + `语音生成中…` / `语音已生成` / `语音不可用`；
- 失败时多一个"重试"按钮，调用 `POST /api/messages/:id/speech`（`force: true`）并就地更新该条消息；
- 状态通过既有领域事件 `conversation.updated` 推送刷新（与文字消息同一条通道），不需要轮询、也不需要在刷新时触发合成；
- 没有音频编辑器、没有播放器、没有 ASR/TTS 管理界面（本阶段不做）。
---

## 12. 测试计数（确切数字）

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **330 / 330 通过**（0 失败；D3 为 309 → D4 新增 21：服务层 13 + provider 集成 7 + 1 个（并入上述文件）） |
| 新增文件 | `test/unit/tts-service.test.ts`（13 / 13）、`test/integration/tts-provider.test.ts`（7 / 7） |
| 既有测试 | 全部保持通过，**未削弱任何断言**（唯一影响面是消息 DTO 多了可选 `tts` 字段与消息读写多了 `tts_json` 列） |

诚实记录一次偶发：本阶段某一次全量运行里出现过 **1 个失败**（某个媒体失败隔离断言期望 `failed` 得到 `available`），随后两次全量运行都是 **330/330**、同一批文件稳定通过，无法复现。这类抖动在前面阶段（C1/D3）也记录过，症状相同（本地 mock 服务在并发负载下的时序抖动），与本次改动无关（该次运行前只改了文档）。

对应任务书 `15 的 20 项要求：

| # | 要求 | 覆盖 |
| --- | --- | --- |
| 1 | Provider 抽象 | `TtsProvider` 端口 + 服务注入注册表；Core 不 import 任何 TTS SDK |
| 2 | mock provider | `echo-tts`（确定性真实 WAV）+ mock HTTP 服务 |
| 3 | 成功合成 | 文本 → provider → MediaStorage → `completed` + 真实元数据 |
| 4 | provider 失败 | `server_error` → `failed`，`mediaId = null` |
| 5 | 超时 | 慢 provider + `tts.timeoutMs=30` → `timeout` |
| 6 | AbortSignal 取消 | 外部 abort → `aborted`，store 里没有残留资产 |
| 7 | 最大文本长度 | `maxTextLength=10` + 11 字符 → `too_long`，provider 调用数 0 |
| 8 | 错误归一化 | 401/429/500/空音频 → `unauthorized/rate_limited/server_error/invalid_response` |
| 9 | 凭据不外泄 | provider 测试断言错误信息不含 API Key；服务测试断言日志不含文本/字节 |
| 10 | 音频经 MediaStorage | 逐字节对比 + `origin = generated` |
| 11 | 音频不进 SQLite | 查 `tts_syntheses`/`messages` 两处：无 base64、无 RIFF；冒烟查全表 |
| 12 | 文字回复在 TTS 失败后仍成功 | 冒烟失败路径：文字已送达、出站消息数 3（没有多发的语音）、`tts.failed` |
| 13 | 不产生用户消息 | 冒烟断言语音挂在**助手消息**上（`audioParts` 属于 assistant），用户消息数不变 |
| 14 | 不回灌 ASR | 管线里 ASR 只在入站处理，TTS 结果不进入任何入站路径（代码结构与冒烟均可验证） |
| 15 | 幂等/缓存防重复合成 | 第二次同指纹 → `cached=true`、provider 调用数不变；冒烟新增调用 = 0 |
| 16 | 不同 voice/model/text → 不同身份 | 逐项断言（voice / model / text 变化各自触发新的合成） |
| 17 | 既有 AudioPart 仍有效 | 音频部件仍是既有 `AudioPart`（media 引用 + status），未新增媒体模型 |
| 18 | 图片/文件/视频/音频功能不变 | 全部既有测试 + C1/C2/C3/D1/D2/D3 冒烟全过 |
| 19 | 微信出站收到合法音频且不发明字段 | 冒烟打印 `media_type=4`、`item.type=3`、`voice_item.keys=media` |
| 20 | 一条失败不阻塞其它 | 服务测试：第一条失败、第二条成功 |

---

## 13. typecheck 结果

```text
pnpm typecheck → exit 0（后端）
前端 tsc --noEmit → exit 0
```

---

## 14. build 结果

```text
pnpm build → exit 0（后端 tsc --noEmit）
根目录 pnpm build → 后端 + 前端（vite build）均成功
```

---

## 15. 架构守卫结果

```text
ARCH-1 … ARCH-8 → 8 / 8 通过（fail 0）
```

本阶段修掉了三个真实的架构问题（都是先被守卫抓到、再修的，记录在此不掩饰）：

1. **Core 一开始 import 了 providers 里的格式常量** → 违反 ARCH-2；把 `TTS_FORMAT_MIME `/`isSupportedTtsFormat` 移到 `core/model/tts.ts`；
2. **echo provider import 了渠道内的 WAV 工具** → 违反 ARCH-3/ARCH-4/ARCH-7（删掉 channels 后 src 无法类型检查）；改为 provider 层私有的 `providers/tts/wav.ts`（SILK 编解码仍然只有渠道内那一处）；
3. **Core 用了 `node:crypto` 做文本哈希** → 违反 ARCH-2/ARCH-6（守卫把 node: 也视为外部依赖）；改为纯 JS `util/hash.ts`。

其余依赖方向保持不变：TTS 的 HTTP 只用内置 `fetch/FormData`，**没有**给 Core 加任何第三方依赖。

---

## 16. 冒烟结果

```text
smoke:phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 → 全部 PASS
```

`smoke:phase45d4` 的真实输出（节选）：

```text
TTS SETTINGS: enabled=true provider=tts voice=mock-voice delivery=voice（默认关闭）
SENT MESSAGES: type1(...) → type3(...:speech:voice:0)     ← 先文字，后语音
TEXT REPLY (权威内容): "你好，今天过得怎么样？"（仍然完整保留，没有被语音替换）
TTS STATE: status=completed provider=tts model=tts-mock voice=mock-voice mime=audio/wav durationMs=1000
AUDIO PART: kind=audio media.status=available mediaId=...（挂在这条助手消息上，不是新消息）
MEDIA STORAGE: isWav=true origin=generated format=24000Hz/1ch
WEIXIN OUTBOUND: media_type=4（语音=4）item.type=3（语音=3）voice_item.keys=media client_id=...:speech:voice:0
SILK: isSilk=true（生成的 WAV 被既有链路转成 SILK）/ 解码回=1040ms
SQLITE CHECK: 2 条消息中，含音频字节的 0 条（必须为 0；库里只有 mediaId 与元数据）
IDEMPOTENCY: 再次请求语音时新增 TTS 调用=0（同一段文本必须复用缓存，为 0）
FAILURE PATH: 文字回复="第二句不同的回复。"（已成功送达）tts.status=failed errorCode=server_error
              mediaId=null audioParts=0
FAILURE PATH: 出站消息数=3（失败时不会多发一条语音，也不会吞掉文字）
REAL TTS VERIFICATION: NOT VERIFIED（本轮用的是 mock TTS 服务，不是真实合成后端）
NATIVE WEIXIN VOICE RENDERING: NOT VERIFIED（D2 结论保持不变：未在真机验证原生语音气泡）
PHASE 4.5-D4 SMOKE OK（文字权威 / 语音入库 / 既有语音链路复用 / 失败不影响文字 / 幂等复用）
```

---

## 17. 真实 TTS 验证状态

```text
Real TTS verification: NOT VERIFIED
Reason: 环境里没有可用的真实 TTS 后端（无 API Key、无本地 Piper/CosyVoice/Fish Speech 服务）
```

- 本轮所有验证都在 mock TTS 服务上完成（真实 HTTP、真实 JSON 请求体、真实 WAV 字节、真实响应头、真实错误码），**没有伪造**任何真实 provider 结果；
- 已验证：请求形状（`model/input/voice/response_format/speed`）、响应字节与 MIME 映射、可选时长/采样率响应头、错误分类、超时/取消、限额、幂等、MediaStorage 入库、既有语音出站链路（WAV → SILK → `voice_item`）；
- 未验证：真实合成音质、真实服务的字段差异与限流表现、真机播放效果；
- 若之后接入真实后端：在设置里把某个 provider 的 baseUrl 指向真实服务并设好 `tts.providerId` / `tts.voice`（`tts.enabled = true`）即可，无需改代码。

---

## 18. 已知限制

1. **真实 TTS 未验证**（第 17 节）；**原生微信语音渲染未验证**（沿用 D2 结论）。
2. **只支持 OpenAI 兼容的 `/audio/speech` 形状**：非该形状的服务（私有协议、WebSocket 流式）需要新 provider。
3. **同步等待**：合成发生在回复送达后的后台任务里，但它是**同一进程内的异步任务**；若进程在合成完成前退出，那条回复会停留在 `processing`（没有持久化的任务队列/重启续跑，这是刻意的范围控制）。
4. **音色必须可用**：openai 兼容实现要求配置里有 `tts.voice`，否则明确失败（不猜默认音色）。
5. **`tts.language` 只作为配置记录**：当前 OpenAI 兼容接口没有该字段，我们**没有**把它塞进请求体（不发明参数）。
6. **前端不播放**：只显示状态与文本（没有音频播放器，也没有 `/api/media/...` 下载接口；Web 端播放属于后续工作）。
7. **`delivery = "file"` 是人工选择**：系统无法探测客户端静默不渲染语音，也不做自动降级。
8. **不做声音克隆、不做多角色音色库、不做情绪→音色映射**（那是 Phase 6/Performance 的范围）。
9. **`WEIXIN_CAPABILITIES.media.audio` 仍为 `false`**：Phase 4 遗留的静态声明，与前几个阶段保持一致。
10. **`tts_syntheses.cached` 列恒为 0**：缓存的"命中"是在返回时标记的运行时字段，数据库列留给将来的统计使用。

---

## 19. 明确确认：未实现声音克隆

**声音克隆没有实现，一行代码都没有。** 同样没有实现：TTS 以外的语音 AI（情绪识别、声纹识别、变声、语音转换）、Live2D / 口型同步 / 表情动画。

D4 只做了：文本 → 语音（端口、配置、状态模型、限额、幂等、MediaStorage、既有语音出站链路、前端状态展示、测试与冒烟）。

---

## 20. 明确确认：未开始 Phase 5

**Phase 5 没有开始。** 本阶段没有引入任何 Agent、工具调用、Browser、多步规划、群聊或多用户能力；
也没有改动记忆 / 关系 / 情绪 / 调度 / 主动消息 / model-router 的任何语义。

---

## 附：命令与结果一览

```text
pnpm test        → 330 / 330 通过（D3: 309 → +21）
pnpm typecheck   → exit 0
pnpm build       → exit 0（后端 + 前端）
pnpm guard       → ARCH-1..8 全通过（8/8）
smoke:phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 → 全部 PASS

Real TTS verification: NOT VERIFIED（无真实后端）
Native Weixin voice rendering: NOT VERIFIED（沿用 D2 结论）
```

Phase 4.5-D4 到此结束。未经确认不会继续到 Phase 5 或任何其它特性。

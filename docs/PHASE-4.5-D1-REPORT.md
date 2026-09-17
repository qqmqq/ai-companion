# Phase 4.5-D1 报告：微信语音（音频传输 + SILK 编解码）

> 阶段目标：补上**音频传输**与 **SILK 编解码边界**，让微信语音消息能收发；
> **不做**任何语音理解（没有 ASR、没有 TTS、没有声纹/情绪识别）。
>
> 说明：本阶段指令在"`27 测试 — codec"处被**截断**，28 节之后的要求没有收到。
> 处理方式：沿用 C1/C2/C3 已确认的约定（同样的测试方式、同样的冒烟方式、报告 1–11 节、STRICT STOP），没有自行扩大范围。

验证强度（诚实说明）：

```text
Real Weixin voice integration: NOT VERIFIED
Mock integration: PASS
```

"Mock integration: PASS"：真实 silk-wasm 编解码 + 真实协议代码（AES-128-ECB/PKCS#7、getuploadurl、CDN 上传/下载、voice_item 构造、长轮询入站映射、本地媒体存储）在真实进程、真实 HTTP、真实 SQLite、真实文件系统上跑通，对面是本地 mock 微信后端与 mock CDN。
"NOT VERIFIED"：没有用真实微信账号与真实 CDN 域名验证过。**另外**：参考实现的发送链路从未发过语音（见第 4 节），出站语音的字段集合存在真实不确定性，已如实标注。

---

## 1. 改动文件

新增：

| 文件 | 作用 |
| --- | --- |
| `backend/src/channels/weixin/media/voice-codec.ts` | SILK 编解码边界：纯 JS 容器识别 + 44 字节 WAV 头 + 可注入的 silk-wasm loader + 缺库降级 |
| `backend/src/channels/weixin/media/audio-validation.ts` | 音频校验：大小、MIME 语法、容器一致性（不解码、不分析） |
| `backend/test/unit/voice-codec.test.ts` | 编解码单元测试（9 个用例，跑真实 silk-wasm） |
| `backend/test/unit/audio-validation.test.ts` | 音频校验单元测试（6 个用例） |
| `backend/test/integration/weixin-audio-messages.test.ts` | 语音收发集成测试（10 个用例） |
| `backend/scripts/phase45d1-smoke.ts` | 端到端冒烟：入站 SILK→WAV 落库、出站 WAV→SILK 可解码 |

修改：

| 文件 | 改动 |
| --- | --- |
| `backend/package.json` | **新增运行时依赖 silk-wasm@^3.7.1（不是 devDependency）** + `smoke:phase45d1` 脚本 |
| `backend/src/channels/weixin/protocol/media-types.ts` | 新增 `WeixinVoiceItem`；顺手把 C3 遗留的"注释错位"修正（file_item 的文档注释归还给 file_item） |
| `backend/src/channels/weixin/protocol/types.ts` | `MessageItem` 增加 `voice_item` |
| `backend/src/channels/weixin/receiver/inbound-mapper.ts` | 支持 `ITEM_TYPE_VOICE` → `AudioPart`；`extractText` 不再把语音当"不支持"；`mediaPart()` 增加 audio 分派 |
| `backend/src/channels/weixin/channel.ts` | `validateInboundMedia` 变为 async 并支持语音（SILK→WAV，含缺库降级）；`prepareOutboundMedia` 支持 `AudioPart`（WAV/SILK → SILK）；`send()` 增加语音分派；`WeixinChannelDeps` 增加可注入的 `voiceCodec` |
| `backend/src/channels/weixin/sender/sender.ts` | 新增 `SendVoiceInput` + `sendVoice()`，复用既有 `sendItem` |
| `backend/src/channels/weixin/index.ts` | 启动自检（Phase 0 风险 R6）：编解码可用/不可用都在启动日志里说清楚 |
| `backend/test/helpers/mock-weixin-server.ts` | 新增 `inboundVoiceMessage()` |
| `backend/test/helpers/weixin-media-stack.ts` | 允许注入 `voiceCodec` |
| `README.md` | 进度、命令、测试数量更新 |

**没有修改**：`core/` 下任何文件（`media.ts`、`message.ts`、`ports/*` 全部未动 → **Core 改动 = 0**）、`storage/media/local-media-storage.ts`、`media-transport.ts`（直接复用）、`long-poll.ts`、记忆 / 关系 / 情绪 / 调度 / 主动 / model-router / 前端 / Phase 4 / 4.5-A / 4.5-B / C1 / C2 / C3 的既有行为。


---

## 2. 音频格式边界（本阶段最重要的设计决定）

```text
Core / MediaStorage                       微信通道内部
─────────────────────────────            ─────────────────────────────
可用音频字节（WAV / SILK / 其它）   ⇄   SILK（微信要求的线上格式）
```

- **存储里永远是"可用音频"，绝不是密文**：CDN 密文只在 `MediaTransport` 内存里存在，从不落库。
- **入站**：SILK（微信发来的格式）→ 解码 → **24 kHz / 单声道 / 16bit PCM + 44 字节 WAV 头** → 入库为 `audio/wav`。这是 Phase 0 研究记录的参考实现行为，本阶段照做。
- **出站**：存储里是 WAV → 编码为 SILK 再上传；存储里**已经是 SILK** → 原样上传（逐字节不变，不做无意义的转码）；其它容器（MP3/AAC/FLAC…）→ **明确拒绝**（本阶段没有通用音频解码器，绝不把 MP3 当 PCM 乱编成噪声）。
- 转换**只发生在出站这一侧**，存储内容不被改写。

---

## 3. 入站架构

```text
微信 voice 消息（item_list[].type = 3）
  ↓ inbound-mapper.collectParts
  voice_item.media.encrypt_query_param / full_url  → 下载引用（不进入 Core）
  voice_item.media.aes_key                         → 密钥（不进入 Core；语音没有 aeskey 字段）
  ↓ 部件：AudioPart{ media: {origin:"channel", status:"pending", width:null, height:null, durationMs:null} }
  ↓ 去重认领 + context_token 落加密存储（Phase 4 既有逻辑，未改动）
  ↓ hydrateMedia(candidates)（C1 引入的钩子，本次只是支持 kind="audio"）
      1. decodeWireMediaKey(aesKey)
      2. MediaTransport.download(...)      ← CDN 下载密文 + AES-128-ECB/PKCS#7 解密
      3. validateAudio(bytes)              ← 大小 + MIME 语法（协议不给 MIME → 兜底）
      4. 必须是 SILK，否则 failed（not_silk）
      5a. 编解码可用 → silkToWav()          ← 解码 + 手工 44 字节 WAV 头
      5b. 编解码不可用 → **原样保存 SILK**（audio/silk，见第 7 节 R6 降级）
      6. MediaStorage.put(bytes, mimeType) ← 入库的是 WAV（或降级时的 SILK）
      7. sanitizeMediaReference({ mediaId, mimeType, sizeBytes, durationMs, width:null, height:null, status:"available" })
  ↓ applyMediaReferences / markMediaFailed（失败只标这一个部件）
  ↓ Core：消息落库，音频只在 MediaStorage 里；**不生成 transcript**（没有 ASR）
```

失败隔离沿用 C1/C2/C3：解码失败（损坏/密钥错误/不是 SILK）只把该 `AudioPart` 标成 `failed`，消息照常投递、批次照常提交、游标语义不变。

---

## 4. 出站架构

```text
Core（InternalResponse.parts: [{kind:"audio", media:{mediaId}}]）
  ↓ WeixinChannel.send()
      1. 文字先发（若有）
      2. 逐条媒体（按 parts 出现顺序，一次 sendmessage 一个 item）：
         prepareOutboundMedia(accountId, conversationRef, part)
           a. mediaId === null → DomainError(invalid_input)（external URL 明确拒绝：SSRF 防护）
           b. MediaStorage.get(mediaId) → 不存在 → DomainError(not_found)
           c. validateAudio(bytes, declaredMime) → 空/超限/MIME 非法/容器矛盾 → DomainError(invalid_input)
           d. SILK → 原样；WAV → 编码；其它 → DomainError(invalid_input)
           e. MediaTransport.upload({kind:"audio", bytes: SILK}) → 明文加密 → CDN 上传
         sender.sendVoice({ encryptQueryParam, aesKeyProtocolBase64, idempotencyKey })
           → voice_item{ media }
  ↓ sendmessage（沿用既有重试 / 幂等 / context_token / -14 处理）
```

**诚实的不确定性（重要）**：协议资料确认了 `getuploadurl.media_type = 4`（语音）与 item 类型码 `3`（voice），
但**参考实现的发送链路从未发过语音**（Phase 0 研究原文："类型存在（media_type:4），但参考实现在发送链路从未使用"）。
因此 voice_item 除 `media` 之外是否还需要别的字段（大小/时长/其他）**无法从现有资料确认**。
本阶段的处理：只发送与图片/视频/文件同构的 `media{encrypt_query_param, aes_key, encrypt_type}`，
**不发明任何字段**（有测试断言 `voice_size` 之类的字段不存在），并在第 10 节明确标注这是未验证点。

---

## 5. 协议映射（实际使用的字段）

### 5.1 出站 voice item

| 字段 | 值 | 来源 |
| --- | --- | --- |
| `getuploadurl.media_type` | `4`（`UPLOAD_MEDIA_TYPE_VOICE`） | 既有 `uploadMediaTypeFor("audio")`（4.5-B 已实现，本次未改） |
| `getuploadurl.rawsize` | SILK 明文字节数 | 编码结果 |
| `getuploadurl.filesize` | `ceil((n+1)/16)*16` | 既有 `encryptedSize` |
| `getuploadurl.rawfilemd5` | 明文 MD5（hex） | 既有 `plaintextMd5Hex` |
| `getuploadurl.no_need_thumb` | `true` | 本阶段不做缩略图 |
| `item.type` | `3`（`ITEM_TYPE_VOICE`） | 协议常量 |
| `item.voice_item.media.encrypt_query_param` | CDN 响应头 `x-encrypted-param` | `MediaTransport.upload().secretMaterial` |
| `item.voice_item.media.aes_key` | `base64("32 位 hex 十六进制字符串")` | 既有 `mediaKeyToProtocolBase64` |
| `item.voice_item.media.encrypt_type` | `1`（`CDN_ENCRYPT_TYPE_PACKED`） | 协议常量 |
| 其它字段 | **不发送** | 协议资料没有语音的大小/时长字段，不发明 |

### 5.2 入站 voice item

| 线上字段 | 处理 |
| --- | --- |
| `item_list[].type === 3` | 映射为 `AudioPart` |
| `voice_item.media.encrypt_query_param` | 交给 `MediaTransport.download`（不落消息） |
| `voice_item.media.full_url` | 同上（下载地址备选） |
| `voice_item.media.aes_key` | **唯一**的密钥来源（语音没有 `aeskey` 字段）；两种 base64 形态都支持（沿用 `decodeWireMediaKey`） |
| 缺下载引用或缺密钥 | 该部件直接 `status:"failed"`，不尝试下载 |
| 时长 | 协议不提供；**来自编解码器的真实解码时长**（不是从字节数推算的猜测） |
| transcript | 协议不提供，本阶段也不生成（没有 ASR） |


---

## 6. 大小 / MIME 策略

**大小（复用 `MEDIA_LIMITS`，没有第二套配置）**：0 字节拒绝（`empty`）；等于上限通过；超过上限拒绝（`too_large`）。
协议**没有**语音的大小字段，所以入站无法做"下载前按声明大小拒绝"；实际保护来自既有的 `MediaTransport` `maxBytes`（4.5-B 实现，不会无界下载）。出站超限在 `validateAudio` 阶段就被拒绝，**零上传请求**。

**MIME（不做白名单）**

| 输入 | 行为 |
| --- | --- |
| `audio/mpeg`、`audio/wav`、`audio/wave`、`audio/x-wav`、`audio/ogg`、`audio/webm`、`audio/mp4`、`audio/aac`、`audio/flac`、`audio/silk`、`application/octet-stream` | 通过 |
| 其它未知但语法合法的音频类型（`audio/x-something-weird`） | **通过**（不做白名单） |
| 协议未提供 MIME（入站语音的真实情况） | 通过，安全兜底 `application/octet-stream` |
| 语法非法（`"not a mime"`、`audio/`、`/mpeg`、非字符串、超长） | 拒绝 `invalid_mime` |
| 声明 `audio/wav` 但内容是 SILK（或反之） | 拒绝 `mime_mismatch` |
| 认不出容器（例如 MP3 头） | **放行**（只读魔数，不猜） |

容器识别只认 SILK（`0x02 + "#!SILK_V3"`）与 WAV（RIFF/WAVE，并解析 fmt/data 头）；这是**纯 JS**实现，不依赖 wasm 是否加载成功。

---

## 7. SILK 依赖与降级（Phase 0 风险 R6）

| 决策 | 说明 |
| --- | --- |
| 选型 | `silk-wasm@^3.7.1`（WASM，MIT，Node ≥16，无需原生编译） |
| 依赖类型 | **`dependencies`（运行时依赖）**，不是 `devDependencies` —— 这正是 Phase 0 研究指出的 R6 问题（参考实现把 `silk-wasm` 放在 devDependencies，生产安装可能根本没有 SILK 能力）。有单元测试直接读 `package.json` 断言这一点 |
| 隔离 | 编解码只存在于 `channels/weixin/media/voice-codec.ts`；Core 与 `media-transport` 都不依赖它，Arch 守卫 ARCH-6（Core 零运行时依赖）依旧全绿 |
| 启动自检 | `channels/weixin/index.ts` 在创建渠道时检查一次并打日志（`weixin voice codec ready` / `unavailable`），启动即可见，不必等第一条语音 |
| 缺库降级 | 入站：**原样保存 SILK**（`audio/silk`，`status: available`，不丢数据）；出站：需要转码时明确失败（`channel_unavailable`），但**已经是 SILK 的媒体依然能原样发送**（不需要编解码器） |
| 可注入 | `createVoiceCodec({ load })` 允许注入假实现 → 测试可以覆盖"缺库/损坏/截断"等分支，生产用真实库 |

实测行为（来自本机 probe 与测试，不是猜测）：

- `encode(PCM 24 kHz 1 秒)` → 3599 字节 SILK，`duration = 1000ms`；
- `decode(同一段)` → 48000 字节 PCM，**duration = 1040ms** —— SILK 以 20ms 为帧，解码时长会向上取整到帧边界，因此测试容差取 **2 帧 = 40ms**（有实测依据）；
- `decode(随机字节)` 抛错；`decode(空)` 抛错；**`decode(被截断的 SILK)` 不抛错，而是按帧尽力解码出更短的音频** → 测试据此断言"不崩、且不会解出比完整解码更多的数据"，而不是假设它一定抛错；
- `encode(任意字节)` 不校验内容（把输入当 PCM）→ 所以我们**绝不**把未知容器交给 `encode`，只允许 SILK（passthrough）与 WAV（显式编码），裸 PCM 必须由调用方显式声明。

---

## 8. 安全

| 资产/风险 | 处理 |
| --- | --- |
| `botToken` / `context_token` | 只在加密凭证存储与渠道内部；不出现在 Core、日志、API 响应 |
| AES 密钥 / `secretMaterial` | 只在内存里流转（`decodeWireMediaKey` → 加解密 → 直接写进协议字段）；与可公开的 `MediaHandle` 严格分离 |
| `encrypted_param` | 不落消息、不落日志、不落 API 响应（有断言） |
| 音频字节 | 只进 `MediaStorage`；消息表只有 `mediaId` + 元数据。冒烟直接查 `messages.content_json` 断言既没有 SILK base64 也没有 WAV base64、也没有协议参数 |
| SSRF | `url.kind === "external"` 永不自动抓取；出站"只有外部 URL、没有 mediaId"直接拒绝，并断言零网络调用 |
| 路径安全 | 文件名净化与 `mediaId` 白名单路径沿用既有实现（本阶段不引入文件名——语音没有文件名） |
| 日志卫生 | 只记录 `mediaId`、大小、MIME、时长、HTTP 状态、拒绝原因；编解码层无 logger、无 console（有源码级断言） |
| 不解码/不分析 | 没有 ASR、TTS、声纹、降噪、波形分析、embedding；编解码层唯一允许的动态导入就是 `silk-wasm`（有断言） |


---

## 9. 测试与真实结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **276 / 276 通过**（0 失败；较 C3 的 251 增加 25：编解码 9 + 音频校验 6 + 音频集成 10） |
| `pnpm typecheck` | 通过（退出码 0） |
| `pnpm build` | 通过（退出码 0） |
| `pnpm guard` | ARCH-1 … ARCH-8 全通过（ARCH-5 依赖清单、ARCH-6 Core 零运行时依赖、ARCH-7 删除 `channels/weixin` 后仍可类型检查） |
| `pnpm smoke:phase4` / `phase45b` / `phase45c1` / `phase45c2` / `phase45c3` | 全部 PASS（既有能力未回归） |
| `pnpm smoke:phase45d1` | PASS（PHASE 4.5-D1 SMOKE OK） |

覆盖点：

1. **编解码单元测试（真实 silk-wasm）**：PCM→SILK→PCM 往返；输出非空、24 kHz、单声道、16bit（从我们写的 WAV 头读出）；时长落在帧量化容差内；同一 SILK 解码两次逐字节一致（确定性）；已是 SILK → 逐字节透传不重编码；裸 PCM 必须显式声明才接受；奇数长度/不支持的采样率明确拒绝；空/随机/损坏输入明确失败；缺库时 `available() === false` 且操作显式报错；假实现注入可用；`silk-wasm` 必须在 `dependencies`；编解码层无 console/fetch/logger 且只导入 `silk-wasm`。
2. **音频校验单元测试**：容器识别（SILK/WAV/unknown）、常见与未知 MIME、缺省兜底、声明与容器矛盾、WAV 头不可解析、上限边界（0/1/精确上限/上限+1）、MIME 语法非法。
3. **入站集成**：CDN → 解密 → **SILK 解码 → WAV 入库**；`status=available`、`mimeType=audio/wav`、`durationMs ≥ 1000`（真实解码时长）、`width/height=null`、`transcript 不存在`；落库 WAV 等于确定性解码结果且**不是** SILK 原文；WAV 头为 24 kHz/1ch/16bit；上下文占位符不含 `[object Object]`。
4. **入站二进制保真（无转码路径）**：编解码不可用时，含 `0x00/0x01/0x7F/0x80/0xFE/0xFF` 的字节**逐字节**落库（`Buffer.compare === 0`）。
5. **入站失败隔离**：缺密钥 / CDN 404 / 密钥错误 / 内容不是 SILK 四种全部 `failed` 且 `mediaId=null`；正常语音仍 `available`；`outcome.processed = 5`（一条不丢）。
6. **出站集成**：`media_type=4`、`item.type=3`、`encrypt_type=1`、`client_id=…:audio:0`、`voice_size 不存在`（不发明字段）；CDN 上是 SILK 且可解码回 1 秒音频（帧量化容差内）；**CDN 上不是原始 WAV**。
7. **出站 SILK 保真**：存储里已是 SILK → 上传字节与原字节**逐字节一致**（原始传输无损）。
8. **出站拒绝路径（零网络）**：外部 URL、无 mediaId、存储未命中/非法 id、MP3（本阶段没有通用解码器）、空音频、声明与容器矛盾 → 六种 `DomainError`；`getuploadurl`/`sendmessage` 调用数为 0、CDN 上传数为 0。
9. **无编解码器时的出站语义**：需要转码 → `channel_unavailable` 且不上传半成品；已是 SILK → 照常发送。
10. **顺序与幂等**：`text + audio + file + audio` → `idem-mix`、`idem-mix:audio:0`、`idem-mix:file:0`、`idem-mix:audio:1`，item 类型依次为语音/文件/语音。
11. **重试与 -14**：第一次 503 后重试成功（复用同一 `client_id`）；`errcode -14` 不重试、`health=degraded`。
12. **日志泄漏**：全链路日志不含 token、媒体密钥（两种编码）、下载参数、SILK/WAV 字节的 base64/hex。

冒烟 `smoke:phase45d1` 真实输出（节选，无密钥/参数）：

```text
SILK CODEC: available=true（silk-wasm 是 runtime dependency）
INBOUND: SILK 明文 5051 字节 → CDN 密文 5056 字节（WAV 源 72044 字节）
CORE AUDIO PART: status=available mediaId=0f684a54... mime=audio/wav size=72044 时长=1540ms 宽高=null transcript=(无，本阶段没有 ASR)
CONTEXT RENDER: "[语音]"（占位符，无 [object Object]：true）
MEDIA STORAGE: 是 WAV=true（不是 SILK=true）/ 与确定性解码结果一致=true / 格式=24000Hz 1ch 16bit
DB CHECK: content_json 里没有音频字节（SILK 或 WAV）、也没有协议参数=true
GETUPLOADURL: media_type=4（语音=4）rawsize=3599 filesize=3600 no_need_thumb=true
SENT ITEM: type=3（语音=3）encrypt_type=1 client_id=smoke-voice-out-1:audio:0 / 额外字段=无（不发明字段）
CDN 上的是 SILK=true / 解码回可播放音频=true（时长 1040ms，帧量化容差内）/ 与源 WAV 不同=true / receipt=srv-2
PHASE 4.5-D1 SMOKE OK（入站 SILK→WAV 落库，出站 WAV→SILK 端到端可解码）
```

（同时验证了启动自检日志：`"weixin voice codec ready" + fields.codec = "silk-wasm"`）

---

## 10. 真实服务验证

```text
Real Weixin voice integration: NOT VERIFIED
Mock integration: PASS
```

- 已验证：SILK 编解码的真实行为（真实 wasm、真实错误路径）、字段命名与编码、CDN 加解密、重试/幂等/`-14`、失败隔离、大小与 MIME 策略、日志卫生、依赖类型（运行时依赖）。
- 未验证（必须知道的两点）：
  1. 真实微信语音消息的**字段集合**是否只需要 `media`（参考实现的发送链路从未发过语音，见第 4 节）；
  2. 真实微信语音的**采样率/参数**是否恒为 24 kHz 单声道（我们按 Phase 0 研究的固定值处理；若真实语音是 8k/16k，解码参数需要可配置化）。

---

## 11. 已知限制

1. **真实微信未验证**，且出站语音字段存在不确定性（见第 4、10 节）。
2. **不生成转写文本**：没有 ASR；`AudioPart.transcript` 在本阶段永远缺席（不是被丢弃，而是从不产生）。
3. **不做任何语音 AI**：没有 TTS、声纹、情绪识别、降噪、波形分析、embedding、RAG。
4. **只支持 SILK 与 WAV 容器**：MP3/AAC/FLAC/OGG 等出站会被明确拒绝（没有通用音频解码器，不引入 ffmpeg）；这也意味着未来的 TTS 若直接产出 MP3，需要额外一步转码才能发语音。
5. **固定 24 kHz / 单声道 / 16bit**：来自 Phase 0 研究；不同采样率的真实语音可能导致音调异常（见第 10 节第 2 点）。
6. **SILK 有损**：解码结果与原始 PCM 不是逐字节一致（测试用帧量化容差与确定性解码两个不变量来覆盖，而不是假装无损）。
7. **`secretMaterial` 未持久化**：每次出站都要重新上传（C1 起的既有约束）。
8. **整块内存传输**：受 `MEDIA_LIMITS.maxMediaBytes`（25 MiB）限制，未做流式。
9. **无入站大小闸门**：协议没有语音大小字段，只能在下载后按实际字节判断（下载本身仍受 `maxBytes` 保护）。
10. **`WEIXIN_CAPABILITIES.media.audio` 仍为 `false`**：Phase 4 遗留的静态声明（仅供参考展示，不参与门控），与前几个阶段保持一致，未在本阶段改动。
11. **Web 端没有录音/播放 UI**：本阶段前端未改动；HTTP API 出站消息仍是纯文本。

---

## 12. 后续阶段（本阶段**未**实现）

```text
D2 — 语音协议扩展（超出 D1 所需的部分）
ASR / 语音识别 / Whisper
TTS / 语音合成 / 声音克隆 / 变声
声纹识别 / 语音情绪识别 / 降噪 / 语音增强 / 音频 embedding / 音频 RAG
OCR
Vision
Live2D / 口型同步 / 表情动画
Browser
Agent
Phase 5
```

Phase 4.5-D1 到此结束。未经确认不会自动进入 D2 或 Phase 5，也不会做与音频无关的重构。




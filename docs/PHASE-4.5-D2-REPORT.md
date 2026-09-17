# Phase 4.5-D2 报告：微信语音协议 + 真实兼容性

> D2 的目标：把 D1 的"音频传输 + SILK 编解码"提升到**协议正确**并且**对真实客户端兼容性有明确结论**的程度。
> 本阶段**没有**实现 ASR（D3 的内容），也没有 TTS、语音克隆、OCR/Vision、Browser/Agent/Live2D、Phase 5。

真实兼容性结论（先说最重要的）：

```text
Real Weixin verification: NOT VERIFIED
Reason: no real Weixin account/environment available

Native Weixin outbound voice: NOT VERIFIED
Reason: 无法在真机上观察客户端是否把消息渲染成原生语音气泡
```

本阶段的所有验证都在本地 mock 微信后端 + mock CDN 上完成。API 接受语音载荷**不等于**真机把它渲染成语音气泡，
因此我们**不宣称**原生语音兼容性（详见第 10、11 节）。

---

## 1. 改动文件

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `backend/src/channels/weixin/channel.ts` | 幂等键改为**按协议名**生成：语音用 `<key>:voice:<i>`（图片/文件/视频保持 `image`/`file`/`video` 不变），并补上说明注释 | D2 明确要求 `<key>:voice:0`；"audio" 是 Core 的媒体种类，"voice" 是微信的消息类型，两者必须区分 |
| `backend/test/integration/weixin-audio-messages.test.ts` | 3 处幂等键断言从 `:audio:0` 改为 `:voice:0` | 跟随上面的协议命名（**没有**放宽任何断言） |
| `backend/test/integration/weixin-voice-protocol.test.ts` | **新增**：D2 协议与兼容性测试（11 个用例） | D2 的核心交付物 |
| `backend/scripts/phase45d2-smoke.ts` | **新增**：端到端冒烟（含 SQLite 层的"无音频字节"断言、协议结构、幂等键、降级路径、NOT VERIFIED 声明） | D2 的验收入口 |
| `backend/package.json` | 新增 `smoke:phase45d2` | 冒烟入口 |
| `README.md` | 进度、命令、测试数量更新 | 交付记录 |
| `docs/PHASE-4.5-D2-REPORT.md` | **新增**：本报告 | 交付物 |

---

## 2. 有意不改的文件

| 文件 | 为什么不动 |
| --- | --- |
| `backend/src/core/**` | **Core 改动 = 0**。`AudioPart`、`MediaReference`、`MediaStorage`、`MediaTransport` 已经够用；D2 没有引入任何 Core 概念 |
| `backend/src/channels/weixin/media/voice-codec.ts`（D1） | SILK 编解码已经正确且经过实测；D2 只**复用**，不重写 |
| `backend/src/channels/weixin/media/audio-validation.ts`（D1） | 校验策略（大小/MIME 语法/容器一致性）已经覆盖 D2 要求 |
| `backend/src/channels/weixin/media/media-transport.ts`（4.5-B） | AES/CDN 上传下载完全复用；`media_type=4` 的映射早在 4.5-B 就实现 |
| `backend/src/channels/weixin/sender/sender.ts` | `sendVoice()` 在 D1 已按确认字段实现（只发 `media`），D2 未发现更强协议证据 → 保持原样 |
| `backend/src/channels/weixin/receiver/inbound-mapper.ts``、`long-poll.ts` | 入站映射与 hydrate 钩子已经正确；D2 只做验证 |
| `backend/src/channels/weixin/protocol/media-types.ts` | `WeixinVoiceItem` 只有 `media` —— 没有新确认的字段可加 |

---

## 3. 已确认的协议事实（本阶段实际使用的全部字段）

| 事实 | 来源 | 本实现 |
| --- | --- | --- |
| `UploadMediaType.VOICE = 4`（`getuploadurl.media_type`） | Phase 0 研究报告 `3.7 + 既有 4.5-B 实现 | 使用 |
| `MessageItemType.VOICE = 3`（`item_list[].type`） | Phase 0 研究报告 `3.6 | 使用 |
| 语音 item 的媒体对象是 `voice_item.media{encrypt_query_param, aes_key, encrypt_type}` | 与图片/视频/文件同构的 CDN 引用（报告 `3.6 的媒体 item 表 + `3.7 的下载规则） | 使用 |
| 语音**没有** `aeskey` 字段；密钥只能来自 `media.aes_key` | 报告 `3.7："语音/文件/视频必须有 media.aes_key" | 使用 |
| CDN 上传/下载、AES-128-ECB/PKCS#7、`filesize = ceil((n+1)/16)*16`、`rawfilemd5` = 明文 MD5 | 报告 `3.7 | 复用既有实现 |
| **参考实现的发送链路从未发过语音** | 报告 `3.6 原文："类型存在（media_type:4），但参考实现在发送链路从未使用" | **不发明字段**：只发 `voice_item.media` |
| `voice_size` / `sample_rate` / `duration` / `duration_ms` / `codec` / `md5` / `file_name` / `len` / `thumb_media` | **没有任何资料确认语音有这些字段** | **一个都不发**（有测试断言线上 item 只有 `type` + `voice_item`，`voice_item` 只有 `media`，`media` 只有 3 个键） |

也就是说：D2 **没有发现**比 D1 更强的协议证据，因此 D1 的"只用确认字段"的行为被**保留并加固**（用结构断言锁死）。

---

## 4. 入站语音流程（验证结果）

```text
getupdates 批次
  → inbound-mapper：item_list[].type === 3 → AudioPart{ media: { origin:"channel", status:"pending" } }
      · 下载引用取 voice_item.media.encrypt_query_param / full_url
      · 密钥只取 voice_item.media.aes_key（没有 aeskey 回退）
      · 协议没有大小/时长/MIME 字段 → 一律 null，绝不猜测
  → 去重认领 + context_token 加密存储（Phase 4 既有逻辑，未改）
  → hydrateMedia(candidates)（C1 引入的钩子）
      validateAudio → 必须真的是 SILK → silkToWav() → 24kHz/1ch/16bit WAV
      （编解码不可用时改为原样保存 audio/silk —— Phase 0 风险 R6 的降级）
  → MediaStorage.put（只落盘可用音频）
  → AudioReference：mediaId / mimeType=audio/wav / sizeBytes / durationMs（**来自真实解码**）/ width=null / height=null
  → applyMediaReferences 写回，或 markMediaFailed 只标记该部件
  → Core：消息落库，上下文里是占位符 [语音]
```

验证到的事实（测试 + 冒烟的真实输出）：

- 正常语音：`status=available`、`mimeType=audio/wav`、`durationMs=1240ms`（1.2 秒源音频，SILK 帧量化内）、落库字节是 WAV 且**不是** SILK、格式为 `24000Hz/1ch/16bit`；
- 缺密钥的语音：`status=failed`，同一批次的**文字消息照常投递**（跨消息隔离，不只是同消息内隔离）；
- 截断的 SILK：批次不崩、游标照常提交（`committed=true`），解码结果不会比完整解码更大（实测 silk-wasm 对截断输入是"按帧尽力解码"）；
- **未确认的元数据被忽略**：故意在 `voice_item` 里塞入 `voice_size=999` / `duration=5000` / `sample_rate=8000` / `codec="amr"`，结果 `sizeBytes` 用的是真实字节、`durationMs` 来自真实解码（不是 5000）、采样率按项目约定解码（不采用 payload 里的值）；
- `[语音]` 占位符保持不变，消息里没有 `[object Object]`、没有协议参数、没有音频字节；
- 冒烟脚本直接查 SQLite：`6 条消息，其中含音频字节或协议参数的有 0 条`。
---

## 5. 出站语音流程（验证结果）

```text
Core：InternalResponse.parts = [{ kind:"audio", media:{ mediaId } }]
  → WeixinChannel.send()
      1. 其它部件（文字/媒体）按既有顺序发送
      2. 语音：prepareOutboundMedia()
         a. mediaId === null → DomainError(invalid_input)（external URL：不抓取，SSRF 防护）
         b. MediaStorage.get(mediaId) → 不存在 → DomainError(not_found)
         c. validateAudio() → 空/超限/MIME 非法/容器矛盾 → DomainError(invalid_input)
         d. codec.toSilk()：已经是 SILK → 原样（逐字节）；WAV → 编码成 SILK；其它容器 → DomainError(invalid_input)
         e. MediaTransport.upload({ kind:"audio" }) → getuploadurl(media_type=4) → AES 加密 → CDN 上传
      3. sender.sendVoice() → voice_item{ media }，复用既有 sendItem()（重试/幂等/context_token/-14）
  → sendmessage（一次一个 item）
```

验证到的事实（D2 冒烟真实输出）：

```text
OUTBOUND WIRE: media_type=4（语音=4）item.type=3（语音=3）
              voice_item.keys=media  media.keys=encrypt_query_param,aes_key,encrypt_type
              client_id=smoke-d2-voice:voice:0
NO INVENTED FIELDS: true
OUTBOUND CODEC: isSilk=true 与源 WAV 不同=true 解码回=1040ms（SILK 20ms 帧量化内）receipt=srv-4
```

- 幂等键：`<key>:voice:0`、`<key>:voice:1`（确定性、可重放；同一响应重发复用同一组键，服务端才能去重）；
- 已是 SILK 的媒体**逐字节原样上传**，不做无意义转码；
- WAV/PCM 走既有编解码器编码；MP3/AAC 等**明确失败**，绝不静默当成 PCM 上传；
- CDN 上解密回来的字节必须是 SILK，且能解码成可播放音频（1 秒 → 1040ms，帧量化容差内）。

---

## 6. SILK 处理（D2 的结论：只加固，不改写）

| 场景 | 行为 |
| --- | --- |
| 入站 SILK | `silkToWav()` → 24 kHz / 单声道 / 16bit PCM → 手工 44 字节 WAV 头 → 入库 `audio/wav` |
| 出站 WAV | `toSilk()` → `encode(wav, 0)`（WAV 自带采样率，按库的约定传 0） |
| 出站已是 SILK | 直接透传（`converted=false`），**逐字节一致**（有断言） |
| 出站其它容器 | 明确拒绝（本阶段不引入通用音频解码器，也不引入 ffmpeg） |
| 编解码缺失 | 入站降级为原样保存 SILK（不丢数据）；出站需要转码时明确失败；已是 SILK 仍可发送 |
| 时长 | 只有**真实解码**才产生时长；协议不提供时入站不猜、出站不发送 |
| 采样率 | 固定 24000（Phase 0 研究结论）；payload 里出现的 `sample_rate` 一律忽略 |

---

## 7. 测试与确切结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **287 / 287 通过**（0 失败；D1 为 276 → D2 新增 11 个协议/兼容性用例） |
| D2 新测试文件 | `test/integration/weixin-voice-protocol.test.ts`：**11 / 11 通过** |
| D1 回归 | `weixin-audio-messages.test.ts` **10 / 10 通过**（仅幂等键期望值随协议命名更新） |

D2 测试逐条覆盖（对应任务书的 16 项要求）：

| # | 要求 | 覆盖方式 |
| --- | --- | --- |
| 1 | `media_type = 4` | 断言 `getuploadurl` 请求体 `media_type === 4`，并断言常量本身等于 4 |
| 2 | item type = 3 | 断言 `item.type === ITEM_TYPE_VOICE === 3` |
| 3 | 语音载荷结构正确 | 断言 `item` 的键集合恰为 `["type","voice_item"]`，`voice_item` 恰为 `["media"]`，`media` 恰为 `["encrypt_query_param","aes_key","encrypt_type"]`，且 `encrypt_type = 1` |
| 4 | 不发明字段 | 对 `voice_size/size/duration/duration_ms/sample_rate/samplerate/codec/md5/file_name/len/thumb_media` 逐项断言**不存在** |
| 5 | 入站映射 | `voice_item` → `AudioPart`（`kind=audio`、`type=audio`、`status=available`、`mimeType=audio/wav`、`durationMs≥1000`、`transcript` 缺席） |
| 6 | 出站映射 | `AudioPart` → `voice_item`；CDN 密文解密回来是 SILK |
| 7 | 幂等键 `<key>:voice:0` | 多语音断言 `[":voice:0", ":voice:1"]`；重发同一响应键不变 |
| 8 | 已有 SILK 字节不变 | 上传字节与存储字节 `Buffer.compare === 0` |
| 9 | 编码出的 SILK 可解码 | 解密 → `isSilk` → `silkToWav()` → 时长在帧量化容差内 |
| 10 | 损坏/截断安全失败 | 截断 SILK：批次不崩（`processed=2`、`committed=true`）、同批文字照常投递、解码结果不会更大；非 SILK 内容 → `failed`（D1 测试） |
| 11 | 大小上限 | 存储层拒绝上限 + 1（`DomainError invalid_input`）且**零网络调用**；校验层边界（0 / 1 / 精确上限 / 上限+1）由 `test/unit/audio-validation.test.ts` 覆盖 |
| 12 | 密钥/参数/字节不进日志 | 8 类敏感值逐个断言不出现在日志里 |
| 13 | 一条语音失败不影响别的消息 | 同批次 `[voice(缺密钥), text, voice(正常)]` → `processed=3`，三者状态各自正确 |
| 14 | `content_json` 无音频字节 | 冒烟脚本直接查 SQLite：6 条消息中 0 条含音频字节或协议参数；测试层额外断言消息 JSON 不含 base64 |
| 15 | `AudioPart` 水合后 `available` | 入站测试断言 `status=available` + 落库是可用 WAV |
| 16 | 只在协议真的提供时才保留元数据 | 故意注入 `voice_size/duration/sample_rate/codec` → 断言**全部被忽略**（真实字节与真实解码时长胜出） |

**既有测试没有减弱**：D1/D2 只改了 3 处幂等键**期望值**（`:audio:0` → `:voice:0`），断言强度与数量未变；其余测试文件零改动。

---

## 8. typecheck / build 结果

```text
pnpm typecheck → exit 0
pnpm build     → exit 0（tsc --noEmit）
```

---

## 9. 架构守卫结果

```text
ARCH-1 … ARCH-8 → 8 / 8 通过（fail 0）
  ARCH-1 Core 无平台字样
  ARCH-2 Core 只依赖 core/util
  ARCH-3 只有 bootstrap 依赖具体渠道
  ARCH-4 channels/ 之外无渠道专有标识
  ARCH-5 依赖清单无 openclaw / 渠道 SDK
  ARCH-6 Core 零第三方运行时依赖
  ARCH-7 物理删除 channels/weixin 后仍能类型检查
  ARCH-8 渠道目录与注册一致
```

Core 改动 = 0（本阶段未触碰 `core/` 下任何文件）。

---

## 10. 真实微信验证结果

```text
Real Weixin verification: NOT VERIFIED
Reason: no real Weixin account/environment available
```

- 本轮**没有**可用的真实微信账号/环境：所有验证都在本地 mock 微信后端（`test/helpers/mock-weixin-server.ts`）与 mock CDN 上完成；
- 因此以下两点**未被证明**：
  1. 真实服务端接受我们的 `voice_item` 载荷并转发；
  2. 真实语音的采样率/参数与我们的固定 24 kHz 假设一致。
- 已经证明的是：协议字段与线上形状、加解密与上传下载、幂等与重试、失败隔离、大小/MIME 策略、SQLite 无音频字节——全部在真实进程/真实 HTTP/真实 SQLite/真实文件系统 + 真实 silk-wasm 上跑通（对面是 mock）。

如果之后拿到真实账号，建议按这个顺序验收（本阶段未执行，因为没有账号）：

```text
1) 真机发一条语音给 bot      → 观察 inbound: type=3 被识别、SILK 下载并解码、AudioPart=available、媒体文件可播放
2) bot 发一条语音给真机      → 观察客户端是否显示为语音气泡、是否可播放、时长是否合理
3) 若真机不渲染语音气泡      → 记录确切现象（气泡类型/是否可点/是否报错），按第 12 节走文件降级
```

---

## 11. 原生语音渲染结果

```text
Native Weixin outbound voice: NOT VERIFIED
Reason: 无法在真机上观察客户端渲染；API 接受载荷 ≠ 客户端渲染成原生语音气泡
```

我们**没有**任何证据表明真机会把我们的消息渲染成可播放的原生语音气泡。为此本实现刻意做了两件事：

1. 只发送**确认过的字段**（`type` + `voice_item.media`），不靠"猜字段"去迎合客户端；
2. 明确把"真机渲染"列为未验证项，而不是用"API 返回 ret=0"来代替结论。

---

## 12. 降级路径及其限制

- **存在一条可用的降级路径**：同一份音频可以直接走既有的**文件**通道发送（`FilePart` → `media_type=3` → `file_item` → `sendmessage`）。D2 测试与冒烟都验证了它：`item.type=4`、`client_id=…:file:0`、CDN 上的字节与源音频**逐字节一致**（不做 SILK 转码）。
- **限制（必须明确）**：
  1. 这条路径是**人工/策略选择**，不是自动回退。系统**无法**检测"客户端静默不渲染/不播放"——那发生在对方设备上，服务端拿不到可判定的错误信号；
  2. 本阶段**没有**实现任何自动开关（不做"发两条试错"、不做客户端探测）；
  3. 只有当我们真的从协议/API 拿到**可检测的错误**（例如服务端明确拒绝 `voice_item`）时，才应该考虑自动降级——目前没有这种证据，所以不做；
  4. 原生语音仍是**首选**路径；文件降级是"确认真机有问题之后"的兜底，不是默认行为；
  5. 降级不改变任何 Core 语义（仍然是 `FilePart` + `MediaStorage`，没有新的媒体系统）。
---

## 13. 已知限制

1. **真实微信未验证**（第 10 节）；**原生语音渲染未验证**（第 11 节）。
2. **出站语音字段集合存在不确定性**：参考实现的发送链路从未发过语音，我们只发确认过的 `media`。若真机要求额外字段（例如大小/时长/封面），需要拿到真实证据后再加——本阶段刻意不猜。
3. **采样率固定 24 kHz / 单声道 / 16bit**：来自 Phase 0 研究；若真实语音是 8k/16k，解码参数需要可配置化（当前 payload 里的 `sample_rate` 被忽略，属于"按项目约定处理"而不是"按对方声称处理"）。
4. **不支持通用音频容器出站**：MP3/AAC/FLAC/OGG 会被明确拒绝（没有通用解码器）。未来 TTS 若直接产出 MP3，需要额外转码步骤才能发语音。
5. **SILK 有损**：解码结果与原始 PCM 不逐字节一致（用帧量化容差 + 确定性解码两个不变量覆盖）。
6. **不生成转写**：`AudioPart.transcript` 在本阶段永远缺席（D3 才是 ASR）。
7. **无入站大小闸门**：协议没有语音大小字段，只能下载后按实际字节判断（下载仍受 `maxBytes` 保护，不会无界下载）。
8. **`secretMaterial` 未持久化**：每次出站重新上传（C1 起的既有约束）。
9. **整块内存传输**：受 `MEDIA_LIMITS.maxMediaBytes`（25 MiB）限制，未做流式。
10. **`WEIXIN_CAPABILITIES.media.audio` 仍为 `false`**：Phase 4 遗留的静态声明（只用于展示，不参与门控），与前几个阶段保持一致，未在本阶段改动。
11. **Web 端没有录音/播放 UI**：本阶段前端未改动。

---

## 14. D3 ASR 明确未实现

**Phase 4.5-D3（ASR / 语音转文字）没有实现，一行代码都没写。** 本阶段（D2）严格只做：

- 微信语音消息的**协议正确性**（字段、类型码、幂等键、不发明字段）；
- **真实兼容性结论**（如实报告 NOT VERIFIED）；
- **降级路径的验证与限制说明**（文件通道，人工选择，非自动检测）。

明确没有做：语音识别、Whisper、转写文本生成、语音合成（TTS）、语音克隆、变声、声纹识别、语音情绪识别、
降噪/语音增强、音频 embedding/RAG、OCR、Vision、Live2D、Browser、Agent、Phase 5。

---

## 附：本阶段命令与结果一览

```text
pnpm test        → 287 / 287 通过（D1: 276 → +11）
pnpm typecheck   → exit 0
pnpm build       → exit 0
pnpm guard       → ARCH-1..8 全通过（8/8）
smoke:phase4     → PHASE 4 SMOKE OK
smoke:phase45b   → PHASE 4.5-B SMOKE OK
smoke:phase45c1  → PHASE 4.5-C1 SMOKE OK
smoke:phase45c2  → PHASE 4.5-C2 SMOKE OK
smoke:phase45c3  → PHASE 4.5-C3 SMOKE OK
smoke:phase45d1  → PHASE 4.5-D1 SMOKE OK
smoke:phase45d2  → PHASE 4.5-D2 SMOKE OK

Real Weixin verification:      NOT VERIFIED（无真实账号/环境）
Native Weixin outbound voice:  NOT VERIFIED（无法观察真机渲染）
```

Phase 4.5-D2 到此结束。下一步（未开始）：**D3 — ASR（语音转文字）**。

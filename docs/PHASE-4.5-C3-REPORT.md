# Phase 4.5-C3 报告：微信视频消息的收发

> 阶段目标：在 C1（图片）与 C2（文件）之上，让微信通道真正**收发视频**，同时保持 Core 平台无关。
> 范围严格限定为视频；语音（4.5-D）与后续阶段不在本阶段。

说明：本阶段的指令文本在"二进制完整性（`12）"之后被**截断**，没有收到 13 节之后的要求。处理方式：沿用 C1/C2 已确认的结构（同样的测试方式、同样的冒烟方式、同样的报告章节 1–11 与 STRICT STOP），没有自行扩大范围。

验证强度（诚实说明）：

```text
Real Weixin video integration: NOT VERIFIED
Mock integration: PASS
```

"Mock integration: PASS"：真实协议代码（AES-128-ECB/PKCS#7、getuploadurl、CDN 上传/下载、video_item 构造、长轮询入站映射、本地媒体存储）在真实进程、真实 HTTP、真实 SQLite、真实文件系统上跑通，对面是本地 mock 微信后端与 mock CDN。
"NOT VERIFIED"：没有用真实微信账号与真实 CDN 域名验证过。

---

## 1. 改动文件

新增：

| 文件 | 作用 |
| --- | --- |
| `backend/src/channels/weixin/media/video-validation.ts` | 视频校验：大小、MIME 语法、容器家族嗅探（只读文件头）、声明与内容一致性；**不解码、不转码、不做缩略图** |
| `backend/test/unit/video-validation.test.ts` | 视频校验单元测试（6 个用例） |
| `backend/test/integration/weixin-video-messages.test.ts` | 视频收发集成测试（7 个用例，真实协议代码 + mock 后端/CDN） |
| `backend/scripts/phase45c3-smoke.ts` | 端到端冒烟：入站视频落库、出站视频端到端可解密 |

修改（渠道层，允许认识微信）：

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `backend/src/channels/weixin/protocol/media-types.ts` | 新增 `WeixinVideoItem`（`media` / `thumb_media` / `video_size` / `url`） | 协议类型 |
| `backend/src/channels/weixin/protocol/types.ts` | `MessageItem` 增加 `video_item` | 新增字段 |
| `backend/src/channels/weixin/receiver/inbound-mapper.ts` | 加入 `kind: "video"`：候选类型联合扩展、视频部件与候选的收集、新增 `mediaPart()` 显式分派、`ITEM_TYPE_VOICE` 之外不再算"不支持" | 三种媒体走同一条收集路径，避免复制映射逻辑 |
| `backend/src/channels/weixin/channel.ts` | `LABELS` 中文种类名；`validateInboundMedia` 增加视频分支；`prepareOutboundMedia` 支持 `VideoPart`；`send()` 增加视频分派；**下载前大小闸门扩展到"按密文长度推导明文下界"**（图片/视频都受益） | 复用既有 hydrate / prepare / send 三条路径，只做分派 |
| `backend/src/channels/weixin/sender/sender.ts` | 新增 `SendVideoInput` 与 `sendVideo()`，内部复用既有 `sendItem` | 协议 item 形状不同，发送语义完全一致 |
| `backend/test/helpers/mock-weixin-server.ts` | 新增 `inboundVideoMessage()` 构造器 | 测试入站视频 |
| `backend/package.json` | 增加 `smoke:phase45c3` | 冒烟入口 |
| `README.md` | 进度、命令、测试数量更新 | 交付记录 |

**没有修改**：`core/` 下任何文件（`media.ts`、`message.ts`、`ports/*`、`services/*` 全部未动）、`storage/media/local-media-storage.ts`、`channels/weixin/media/media-transport.ts`（直接复用）、`receiver/long-poll.ts`（与媒体类型无关）、记忆 / 关系 / 情绪 / 调度 / 主动 / model-router / 前端 / Phase 4 / 4.5-B / C1 / C2 的既有行为。

---

## 2. 入站架构

```text
微信 video 消息（item_list[].type = 5）
  ↓ inbound-mapper.collectParts
  video_item.media.encrypt_query_param / full_url  → 下载引用（不进入 Core）
  video_item.media.aes_key                         → 密钥（不进入 Core；视频没有 aeskey 字段）
  video_item.video_size                            → 密文字节数（诊断 + 下载前大小闸门）
  video_item.thumb_media                           → **忽略**（不下载、不生成缩略图）
  ↓ 部件：VideoPart{ media: {origin:"channel", status:"pending", width:null, height:null, durationMs:null} }
  ↓ 去重认领 + context_token 落加密存储（Phase 4 既有逻辑，未改动）
  ↓ hydrateMedia(candidates)（C1 引入的钩子，本次只是支持 kind="video"）
      0. 声明大小闸门（见第 6 节）超限 → 直接 failed（**零 CDN 请求**）
      1. decodeWireMediaKey(aesKey)
      2. MediaTransport.download(...)   ← CDN 下载密文 + AES-128-ECB/PKCS#7 解密
      3. validateVideo(bytes)           ← 大小 + MIME 语法 + 容器一致性（只读文件头）
      4. MediaStorage.put(bytes, mimeType)
      5. sanitizeMediaReference({ mediaId, mimeType, sizeBytes, width:null, height:null, durationMs:null, status:"available" })
  ↓ applyMediaReferences / markMediaFailed（失败只标这一个部件）
  ↓ Core：消息落库，二进制只在 MediaStorage 里
```

没有为视频新建第二条 hydration 流水线：复用 C1 建立的 `hydrateMedia` 钩子与 C2 扩展出的"按 kind 分派校验"。

---

## 3. 出站架构

```text
Core（InternalResponse.parts: [{kind:"video", media:{mediaId}}]）
  ↓ WeixinChannel.send()
      1. 文字先发（若有）：sendText(..., idempotencyKey = response.idempotencyKey)
      2. 逐条媒体（按 parts 出现顺序，一次 sendmessage 一个 item）：
         prepareOutboundMedia(accountId, conversationRef, part)
           a. mediaId === null → DomainError(invalid_input)
              （url.kind === "external" 时明确报错：不抓外部地址，SSRF 防护）
           b. MediaStorage.get(mediaId) → 不存在 → DomainError(not_found)
           c. validateVideo(bytes, declaredMime, maxBytes)
              → 空 / 超限 / MIME 语法非法 / 声明与容器矛盾 → DomainError(invalid_input)
           d. MediaTransport.upload({kind:"video"}) → 明文加密 → CDN 上传
              → { encryptQueryParam, aesKeyProtocolBase64, ciphertextSizeBytes }
         sender.sendVideo({ ...ciphertextSizeBytes, idempotencyKey })
           → video_item{ media, video_size }
  ↓ sendmessage（沿用既有重试 / 幂等 / context_token / -14 处理）
```

顺序与幂等策略完全沿用 C1/C2：先文字后媒体、按 parts 顺序、每类媒体各自计数 `<key>:video:0` / `<key>:video:1`（确定性，可重放）。

---

## 4. 协议映射（实际使用的字段）

### 4.1 出站 video item

| 字段 | 值 | 来源 |
| --- | --- | --- |
| `getuploadurl.media_type` | `2`（`UPLOAD_MEDIA_TYPE_VIDEO`） | 既有 `uploadMediaTypeFor("video")`（4.5-B 已实现，本次未改） |
| `getuploadurl.rawsize` | 明文字节数 | `MediaStorage` 读回的字节 |
| `getuploadurl.filesize` | `ceil((n+1)/16)*16` | 既有 `encryptedSize` |
| `getuploadurl.rawfilemd5` | 明文 MD5（hex） | 既有 `plaintextMd5Hex` |
| `getuploadurl.no_need_thumb` | `true` | 本阶段不做缩略图 |
| `item.type` | `5`（`ITEM_TYPE_VIDEO`） | 协议常量 |
| `item.video_item.media.encrypt_query_param` | CDN 响应头 `x-encrypted-param` | `MediaTransport.upload().secretMaterial` |
| `item.video_item.media.aes_key` | `base64("32 位 hex 十六进制字符串")` | 既有 `mediaKeyToProtocolBase64` |
| `item.video_item.media.encrypt_type` | `1`（`CDN_ENCRYPT_TYPE_PACKED`） | 协议常量 |
| `item.video_item.video_size` | **密文**字节数 | `MediaHandle.transferredSizeBytes`（与图片 `mid_size` 同类） |
| `item.video_item.thumb_media` | **不发送** | 本阶段不做缩略图 |

协议**没有**视频的明文大小、宽高、时长、MIME 字段 → 这些值一律不发送。

### 4.2 入站 video item

| 线上字段 | 处理 |
| --- | --- |
| `item_list[].type === 5` | 映射为 `VideoPart` |
| `video_item.media.encrypt_query_param` | 交给 `MediaTransport.download`（不落消息） |
| `video_item.media.full_url` | 同上（下载地址备选） |
| `video_item.media.aes_key` | 唯一的密钥来源（视频没有 `aeskey` 字段）；两种 base64 形态都支持（沿用 `decodeWireMediaKey`） |
| `video_item.video_size` | 密文字节数：用于日志诊断与"下载前大小闸门"；不作明文大小使用 |
| `video_item.thumb_media` | 忽略（有测试断言缩略图参数从未被下载） |
| 缺下载引用或缺密钥 | 该部件直接 `status:"failed"`，不尝试下载 |

**无法从项目已有资料确定、因而没有实现的字段**：视频宽高、时长、封面图的落库。协议研究（`3.6）里只列出了 `media / video_size`；我没有猜测任何"可能存在"的字段，也没有为了拿到这些值去解析视频。

---

## 5. Core 与平台边界

Core 只看到 `VideoPart` 与 `MediaReference`（`mediaId / mimeType / sizeBytes / width / height / durationMs / origin / status / url`）。
Core 里没有出现任何 `weixin / media_type / filekey / video_size / encrypt_query_param / aes_key / CDN` 概念——ARCH-1 与 ARCH-7（物理删除 `channels/weixin` 后 `src` 仍能类型检查）都是绿的。

`video_item` 这些字段只存在于 `channels/weixin/protocol/media-types.ts` 与渠道内部代码里。

---

## 6. 大小 / MIME 策略

**大小（复用 `MEDIA_LIMITS`，没有第二套配置）**

| 场景 | 行为 |
| --- | --- |
| 0 字节 | 拒绝（`empty`）——与图片/文件一致 |
| 正好等于上限（25 MiB） | 通过 |
| 超过上限 | 拒绝（`too_large`） |
| 入站声明**明文**大小（文件 `len`）超限 | 下载前拒绝 |
| 入站声明**密文**大小（图片 `mid_size` / 视频 `video_size`） | 用 PKCS#7 的可证下界判断：密文 = `16·ceil((n+1)/16)` ⇒ `n ≥ 密文 − 16`。若 `密文 − 16 > maxBytes`，明文必然超限 → **下载前拒绝**（不会误伤合法媒体：恰好 25 MiB 的明文对应密文 25 MiB+16，下界正好等于上限，仍然放行） |
| 出站超限 | `MediaStorage.get` 后的 `validateVideo` 直接拒绝，**零上传请求** |

**MIME（不做白名单）**

| 输入 | 行为 |
| --- | --- |
| `video/mp4` / `video/webm` / `video/quicktime` / `video/x-msvideo` | 通过（`COMMON_VIDEO_MIME_TYPES`，用于一致性检查） |
| `video/x-matroska`、`video/mpeg`、`video/3gpp`、`video/x-flv`、`video/ogg`、`video/av1` 等未知但合法类型 | **通过**（不做白名单；未知类型不做一致性检查） |
| `VIDEO/MP4; codecs=avc1` | 通过并规范化为 `video/mp4` |
| 协议未提供 MIME（入站视频的真实情况） | 通过，安全兜底 `application/octet-stream` |
| 语法非法（`"not a mime"`、`video/`、`/mp4`、`video//mp4`、非字符串、超长） | 拒绝 `invalid_mime` |
| 声明了常见类型但内容容器相反（例如声明 `video/mp4` 实际是 AVI） | 拒绝 `mime_mismatch` |
| 声明了常见类型但内容认不出来 | **放行**（只读文件头，绝不猜） |

容器嗅探范围：ISO BMFF（偏移 4 的 `ftyp`，MP4 与 MOV 同族）、Matroska/WebM（EBML `1A45DFA3`）、RIFF/AVI。不做解码、不做转码、不看帧、不生成缩略图。

---

## 7. 安全

| 资产/风险 | 处理 |
| --- | --- |
| `botToken` | 只在加密凭证存储里；出站走既有 `senderFor`（每账号独立 HTTP 客户端）；日志里没有 token（有断言） |
| `context_token` | 渠道内部使用，只进加密存储；不进入 Core |
| AES 密钥 / `secretMaterial` | 只在内存里流转：`decodeWireMediaKey` → 加解密 → 直接写进协议字段；与可公开的 `MediaHandle` 严格分离 |
| `encrypted_param` | 不落消息、不落日志、不落 API 响应（有断言） |
| 视频字节 | 只进 `MediaStorage`；消息表只有 `mediaId` + 元数据。冒烟直接查 `messages.content_json` 断言无明文 base64、无协议参数 |
| SSRF | `url.kind === "external"` 永不自动下载；出站"只有外部 URL、无 mediaId"直接拒绝，且断言零网络调用 |
| 缩略图引用 | 入站 `thumb_media` 被显式忽略（测试断言该参数从未被下载），避免"顺手抓一个额外 URL" |
| 媒体不是视频 | 不做内容解码，但会用容器家族识别"声明与内容矛盾"；认不出来就放行（不误杀合法容器） |
| 日志卫生 | 只记录 `mediaId`、大小、MIME、HTTP 状态、拒绝原因等安全元数据 |

---

## 8. 测试与真实结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **251 / 251 通过**（0 失败；较 C2 的 238 增加 13：视频集成 7 + 视频校验单元 6） |
| `pnpm typecheck` | 通过（退出码 0） |
| `pnpm build` | 通过（退出码 0） |
| `pnpm guard` | ARCH-1 … ARCH-8 **全部通过**（含 ARCH-7 删除 `channels/weixin` 后仍可类型检查） |
| `pnpm smoke:phase4` | PASS（PHASE 4 SMOKE OK） |
| `pnpm smoke:phase45b` | PASS（PHASE 4.5-B SMOKE OK） |
| `pnpm smoke:phase45c1` | PASS（PHASE 4.5-C1 SMOKE OK） |
| `pnpm smoke:phase45c2` | PASS（PHASE 4.5-C2 SMOKE OK） |
| `pnpm smoke:phase45c3` | PASS（PHASE 4.5-C3 SMOKE OK） |

覆盖点：

1. **入站映射 + 落库**：`type=5` → `VideoPart`；`status=available`、`mediaId` 合法、`mimeType=application/octet-stream`（协议无 MIME）、`sizeBytes` 为真实字节数、`width/height/durationMs` 全为 `null`（不为拿这些值去解码）、`MediaStorage.get` 读回字节 **Buffer.compare === 0**、`thumb_media` 未被下载。
2. **入站失败隔离**：缺密钥 / CDN 404 / 密钥错误 / 声明超限 四种全部 `failed` 且 `mediaId=null`；正常视频仍 `available`；`outcome.processed = 5`（一条不丢）；声明超限的那个**没有发生下载**。
3. **出站协议载荷**：`media_type=2`、`rawsize`/`filesize`、`item.type=5`、`video_item.media.encrypt_type=1`、`video_item.video_size = filesize`（密文长度）；用消息里的 `aes_key` 解 CDN 密文得到原视频。
4. **二进制完整性**：测试数据固定含 `0x00 / 0xFF / 0x01 / 0x80` 与随机字节（视频样本 4 KiB–256 KiB），两个方向都用 `Buffer.compare` 断言完全一致，绝不按 UTF-8/JSON/base64 处理（base64 只出现在协议本身要求的 `aes_key` 编码上）。
5. **顺序与幂等**：`text + video + file + video` 的发文顺序为 `idem-mix`、`idem-mix:video:0`、`idem-mix:file:0`、`idem-mix:video:1`，item 类型依次为视频/文件/视频。
6. **拒绝路径（零网络）**：外部 URL、无 mediaId、存储未命中（含非法 id 形状）、空视频、MIME 语法非法、声明与容器矛盾 → 六种 `DomainError`；`getuploadurl`/`sendmessage` 调用数为 0、CDN 上传数为 0。
7. **重试与 -14**：第一次 503 后重试成功（2 次 sendmessage、复用同一 `client_id`）；`errcode -14` 不重试、`health=degraded`。
8. **日志泄漏**：入站 + 出站全链路日志不含 token、媒体密钥（hex/base64）、下载参数、视频字节的 base64/hex。
9. **校验单元测试**：容器嗅探（ftyp/ebml/riff-avi/认不出→null）、常见与未知视频 MIME、缺省兜底、声明与内容矛盾与"认不出则放行"、MIME 语法非法、精确上限/上限+1、以及"校验层是纯函数"（无 console、无 fetch、无视频库、不生成缩略图）。

冒烟 `smoke:phase45c3` 真实输出（节选，无密钥/参数）：

```text
INBOUND: mock CDN 上是 262160 字节密文（明文 262144 字节）
REPLY -> WEIXIN: "（角色）视频看到了，我待会儿看完跟你说。"
CORE VIDEO PART: status=available mediaId=9bdc86b6... mime=application/octet-stream size=262144 宽高=nullxnull 时长=null
CONTEXT RENDER: "[视频]"（占位符，无 [object Object]：true）
MEDIA STORAGE: 落库字节与原始视频完全一致=true / checksum=457bbc91524d...
THUMBNAIL CHECK: 缩略图引用被忽略（未下载）=true
DB CHECK: content_json 里没有视频字节、也没有协议参数=true
GETUPLOADURL: media_type=2 rawsize=131072 filesize=131088 no_need_thumb=true
SENT ITEM: type=5（视频=5）video_size=131088（= filesize 131088）encrypt_type=1 client_id=smoke-video-out-1:video:0
CDN 密文用消息里的 aes_key 可解回出站视频=true / 密钥 16 字节 / receipt=srv-2
PHASE 4.5-C3 SMOKE OK（入站视频落库，出站视频端到端可解密）
```

---

## 9. 真实服务验证

```text
Real Weixin video integration: NOT VERIFIED
Mock integration: PASS
```

所有验证都使用本地 mock 微信后端与 mock CDN。**没有**真实微信账号、真实 `ilinkai.weixin.qq.com`、真实 `novac2c.cdn.weixin.qq.com` 的联调。

- 已验证：字段命名、item 形状、编码方式、加解密、重试/幂等/`-14` 语义、失败隔离、大小与 MIME 策略、日志卫生；
- 未验证：真实服务端是否对 `video_item` 有额外要求（例如是否需要缩略图、是否存在宽高/时长字段）、真实 CDN 对视频的额外限制（大小/时长/编码）、真实客户端对无缩略图视频的展示行为。

---

## 10. 已知限制

1. **真实微信未验证**（见第 9 节）。
2. **视频宽高/时长永远是 `null`**：项目现有协议资料里没有这些字段，我们也不为了拿到它们去解码视频。若将来确认协议提供，可在渠道层补齐（不改 Core）。
3. **不生成缩略图**：`no_need_thumb: true`，入站 `thumb_media` 被忽略。
4. **不做任何视频处理**：不解码、不转码、不抽帧、不生成封面、不做内容理解；视频也不自动成为记忆。
5. **`secretMaterial` 未持久化**：每次出站都要重新上传（C1 起就存在的限制，本阶段未扩大范围）。
6. **整块内存传输**：受 `MEDIA_LIMITS.maxMediaBytes`（25 MiB）限制，未做流式；超过上限直接拒绝。**这意味着当前实现不适合长视频**（多数聊天场景的视频会超限）。
7. **入站视频 MIME 固定兜底为 `application/octet-stream`**（协议不提供 MIME，且我们不做内容嗅探来决定类型；容器嗅探只用于一致性检查）。
8. **`WEIXIN_CAPABILITIES.media` 仍是全 `false`**：这是 Phase 4 遗留的静态声明（仅用于 `/api/channels` 与健康信息展示，**不参与任何能力门控**），本次刻意不改，以免在本阶段改动无关断言；建议后续阶段单独做一次"能力声明与实际能力对齐"的清理。
9. **Web 端没有视频上传/播放 UI**：本阶段前端未改动；HTTP API 出站消息仍是纯文本。
10. **一次 sendmessage 只带一个 item**：多视频 = 多条消息（协议硬约束）。

---

## 11. 后续阶段（本阶段**未**实现）

明确**没有**实现，也不在本阶段范围内：

```text
Phase 4.5-D — 语音 / Silk
Audio / ASR / TTS
OCR
Vision
视频解码 / 转码 / 抽帧 / 封面生成
文件内容解析（PDF/DOCX/压缩包/文本抽取/document RAG/embeddings）
Browser
Agent
Live2D
Phase 5
```

Phase 4.5-C3 到此结束。未经确认不会自动进入 4.5-D 或 Phase 5，也不会做与视频无关的重构。

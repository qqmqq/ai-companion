# Phase 4.5-C2 报告：微信文件消息的收发

> 阶段目标：在 Phase 4.5-C1（图片）之上，让微信通道真正**收发文件**，同时保持 Core 平台无关。
> 范围严格限定为文件；视频（4.5-C3）与语音（4.5-D）不在本阶段。

验证强度（诚实说明）：

```text
Real Weixin file integration: NOT VERIFIED
Mock integration: PASS
```

"Mock integration: PASS"：真实协议代码（AES-128-ECB/PKCS#7、getuploadurl、CDN 上传/下载、file_item 构造、长轮询入站映射、本地媒体存储）在真实进程、真实 HTTP、真实 SQLite、真实文件系统上跑通，对面是本地 mock 微信后端与 mock CDN。
"NOT VERIFIED"：没有用真实微信账号与真实 CDN 域名验证过。

---

## 1. 改动文件

新增：

| 文件 | 作用 |
| --- | --- |
| `backend/src/channels/weixin/media/file-validation.ts` | 文件校验：文件名净化、MIME 规范化、声明大小解析、大小上限（复用 Core 的 MEDIA_LIMITS） |
| `backend/test/unit/file-validation.test.ts` | 文件名 / MIME / 大小 / 路径收容 的单元测试（6 个用例） |
| `backend/test/integration/weixin-file-messages.test.ts` | 文件收发集成测试（9 个用例，真实协议代码 + mock 后端/CDN） |
| `backend/scripts/phase45c2-smoke.ts` | 端到端冒烟：入站文件落库、出站文件端到端可解密 |

修改（渠道层，允许认识微信）：

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `backend/src/channels/weixin/protocol/media-types.ts` | 新增 `WeixinFileItem`（`media` / `file_name` / `len`） | 协议类型 |
| `backend/src/channels/weixin/protocol/types.ts` | `MessageItem` 增加 `file_item`；把原来夹在文件中间的 media-types 类型 import 移到文件顶部 | 新增字段必须引用该类型；import 位置顺手归位（行为不变） |
| `backend/src/channels/weixin/receiver/inbound-mapper.ts` | 图片/文件共用收集逻辑；`InboundMediaCandidate` 增加 `kind: "image" \| "file"`、`declaredSizeBytes`、`filename`；`applyMediaReferences` / `markMediaFailed` 改为对**所有媒体 part** 生效 | 文件与图片走同一条入站路径，避免复制一份映射逻辑 |
| `backend/src/channels/weixin/channel.ts` | 新增 `validateInboundMedia`（按 kind 分派校验）；`hydrateInboundMedia` 支持文件 + 下载前大小闸门；`prepareOutboundImage` → `prepareOutboundMedia`；`send()` 支持 `FilePart` | 图片/文件共用 hydrate 与出站准备，只有"校验规则"不同 |
| `backend/src/channels/weixin/sender/sender.ts` | 新增 `SendFileInput` 与 `sendFile()`，内部复用既有 `sendItem`（重试/幂等/`-14` 只有一份） | 协议 item 形状不同，但发送语义完全一致 |
| `backend/test/helpers/mock-weixin-server.ts` | 新增 `inboundFileMessage()` 构造器 | 测试入站文件 |
| `backend/test/helpers/weixin-media-stack.ts` | 暴露 `dataDir` | 断言"文件必须落在媒体根目录内" |
| `backend/package.json` | 增加 `smoke:phase45c2` | 冒烟入口 |
| `README.md` | 进度、验证命令、测试数量更新 | 交付记录 |

**没有修改**：`core/` 下任何文件（`media.ts`、`message.ts`、`ports/*`、`services/*` 全部未动）、`storage/media/local-media-storage.ts`、`receiver/long-poll.ts`（它本来就与媒体类型无关）、记忆 / 关系 / 情绪 / 调度 / 主动 / model-router / 前端 / Phase 4 / 4.5-B / 4.5-C1。

关于 `docs/protocol.md`：本仓库**没有**这个文件。协议依据是 Phase 0 研究报告 `docs/AI-COMPANION-ARCHITECTURE-REPORT.md` `3.6（消息发送）与 `3.7（媒体/CDN），以及既有实现里已经验证过的字段命名。本阶段没有自行发明字段。

---

## 2. 入站架构

```text
微信 file 消息（item_list[].type = 4）
  ↓ inbound-mapper.collectParts
  file_item.media.encrypt_query_param / full_url   → 下载引用（不进入 Core）
  file_item.media.aes_key                          → 密钥（不进入 Core）
  file_item.file_name                              → sanitizeAttachmentFilename()
  file_item.len                                    → parseDeclaredSize()（明文大小，十进制字符串）
  ↓ 部件：FilePart{ media: {origin:"channel", filename, sizeBytes, status:"pending"} }
  ↓ 去重认领 + context_token 落加密存储（Phase 4 既有逻辑，未改动）
  ↓ hydrateMedia(candidates)（渠道注入，C1 引入的钩子，本次只是支持 kind="file"）
      0. 声明大小 > maxMediaBytes → 直接 failed（**零 CDN 请求**）
      1. decodeWireMediaKey(aesKey)
      2. MediaTransport.download(...)  ← CDN 下载密文 + AES-128-ECB/PKCS#7 解密
      3. validateFile(bytes, filename) ← 大小 + MIME 语法 + 文件名净化（不看内容）
      4. MediaStorage.put(bytes, mimeType, filename)  ← 只返回 mediaId
      5. sanitizeMediaReference({ mediaId, mimeType, filename, sizeBytes, status:"available", width/height: null })
  ↓ applyMediaReferences / markMediaFailed（失败只标这一个部件）
  ↓ Core：消息落库，二进制只在 MediaStorage 里
```

失败隔离与游标语义沿用 C1，没有任何改动：一个文件失败只把该 `FilePart` 标成 `failed`（并保留净化后的文件名，便于展示"哪个文件失败了"），消息照常投递、批次照常提交。

---

## 3. 出站架构

```text
Core（InternalResponse.parts: [{kind:"file", media:{mediaId}}]）
  ↓ WeixinChannel.send()
      1. 文字先发（若有）：sendText(..., idempotencyKey = response.idempotencyKey)
      2. 逐条媒体（按 parts 出现顺序，一次 sendmessage 一个 item）：
         prepareOutboundMedia(accountId, conversationRef, part)
           a. mediaId === null → DomainError(invalid_input)
              （url.kind === "external" 时明确报错：不抓外部地址，SSRF 防护）
           b. MediaStorage.get(mediaId) → 不存在 → DomainError(not_found)
           c. validateFile(bytes, declaredMime, filename)
              → 空文件 / 超限 / MIME 语法非法 → DomainError(invalid_input)
           d. MediaTransport.upload({kind:"file"}) → 明文加密 → CDN 上传
              → { encryptQueryParam, aesKeyProtocolBase64, ciphertextSizeBytes, plaintextSizeBytes, filename }
         sender.sendFile({ ..., fileName, plaintextSizeBytes, idempotencyKey })
           → file_item{ media, file_name, len }
  ↓ sendmessage（沿用既有重试 / 幂等 / context_token / -14 处理）
```

顺序策略：沿用 C1 已确立的"先文字、再媒体，按 parts 顺序"，没有重新设计出站管线。多文件时幂等键按类型各自计数：`<key>:file:0`、`<key>:file:1`、`<key>:image:0`（确定性、可重放），不是随机值。

---

## 4. 协议映射（实际使用的字段）

### 4.1 出站 file item

| 字段 | 值 | 来源 |
| --- | --- | --- |
| `getuploadurl.media_type` | `3`（`UPLOAD_MEDIA_TYPE_FILE`） | 既有 `uploadMediaTypeFor("file")`（4.5-B 已实现，本次未改） |
| `getuploadurl.rawsize` | 明文字节数 | `MediaStorage` 读回的字节 |
| `getuploadurl.filesize` | `ceil((n+1)/16)*16` | 既有 `encryptedSize` |
| `getuploadurl.rawfilemd5` | 明文 MD5（hex） | 既有 `plaintextMd5Hex` |
| `getuploadurl.no_need_thumb` | `true` | 本阶段不做缩略图 |
| `item.type` | `4`（`ITEM_TYPE_FILE`） | 协议常量 |
| `item.file_item.media.encrypt_query_param` | CDN 响应头 `x-encrypted-param` | `MediaTransport.upload().secretMaterial` |
| `item.file_item.media.aes_key` | `base64("32 位 hex 十六进制字符串")` | 既有 `mediaKeyToProtocolBase64` |
| `item.file_item.media.encrypt_type` | `1`（`CDN_ENCRYPT_TYPE_PACKED`） | 协议常量 |
| `item.file_item.file_name` | 净化后的纯文件名 | `sanitizeAttachmentFilename` |
| `item.file_item.len` | **明文字节数的十进制字符串**（`String(n)`） | 协议要求；同时避免任何整数精度问题 |

注意：文件的 `len` 是**明文**大小，与图片的 `mid_size`（**密文**大小）语义不同——两者都按各自协议字段发送，没有互相混用。

### 4.2 入站 file item

| 线上字段 | 处理 |
| --- | --- |
| `item_list[].type === 4` | 映射为 `FilePart` |
| `file_item.media.encrypt_query_param` | 交给 `MediaTransport.download`（不落消息） |
| `file_item.media.full_url` | 同上（下载地址备选） |
| `file_item.media.aes_key` | 唯一的密钥来源（文件没有 `aeskey` 字段）；接受 `base64(16 原始字节)` 与 `base64(32 位 hex)` 两种形态（沿用 `decodeWireMediaKey`） |
| `file_item.file_name` | 净化后作为 `FilePart.media.filename`；不参与任何路径 |
| `file_item.len` | 只用于"下载前的大小闸门"与初始元数据；解析失败视为未知，不影响后续按真实字节判断 |
| 缺下载引用或缺密钥 | 该部件直接 `status:"failed"`，不尝试下载 |

---

## 5. 文件名的安全处理

文件名是不可信输入，处理顺序是"先净化、再使用"：

1. 复用 Core 的 `sanitizeFilename`：去掉控制字符（含 `\u0000`）与首尾空白、限制长度（`MEDIA_LIMITS.maxFilenameLength = 200`）、按 `/` 与 `\` 切分后**只保留最后一段**；
2. 再拒绝"没有实际名字"的值：`.`、`..`、`...` → `null`；
3. 结果只作为**元数据**使用：
   - 入站：写进 `FilePart.media.filename` 与媒体 sidecar，绝不参与路径拼接；
   - 出站：写进 `file_item.file_name`，绝不参与任何文件系统操作。
4. 存储路径与文件名**完全无关**：`LocalMediaStorage` 只按 `mediaId`（`^[0-9a-f]{32}$`）拼路径（`<dataDir>/media/<前两位>/<id>.bin|.json`），非法 id 的读路径直接当"不存在"，写路径抛 `DomainError`。

测试覆盖的恶意名字：`../../secret.txt`、`..\..\secret.txt`、`C:\secret.txt`、`\\server\share\secret.txt`、`/etc/passwd`、`../`、`..`、`.`、空串、只有空白、`\u0000`、`evil\r\nname.txt`、`ANSI 转义`、500 字符超长名。断言：结果里没有路径分隔符、没有盘符冒号、没有控制字符、长度受限；并且**遍历真实的媒体数据目录**，确认所有落盘文件都在 `<dataDir>/media/` 之内、文件名只能是 `mediaId`、没有任何文件叫 `secret.txt`。

不信任扩展名：文件**不做内容嗅探**、也不看后缀，`.txt` 里装 ELF 也只是普通字节（有测试断言）。

---

## 6. 大小 / MIME 策略

**大小（复用既有策略，没有第二套限制）**

| 场景 | 行为 |
| --- | --- |
| 空（0 字节） | 拒绝（`empty`）——与图片保持同一套语义：没有内容的媒体不入库、不发送 |
| 1 字节 / 小文件 | 通过 |
| 正好等于 `MEDIA_LIMITS.maxMediaBytes`（25 MiB） | 通过（边界包含） |
| 超过上限（含上限 + 1） | 拒绝（`too_large`） |
| 入站声明大小（`file_item.len`）已超限 | **下载之前**就拒绝，零 CDN 请求（测试断言 CDN 上没有该参数的下载记录） |
| 入站实际大小未知 | 下载仍受 `MediaTransport` 的 `maxBytes` 保护，不会无界下载（4.5-B 已实现） |

**MIME（不做白名单）**

| 输入 | 行为 |
| --- | --- |
| `application/pdf` / `application/zip` / `application/json` / `text/plain` / `application/octet-stream` / `application/vnd.openxmlformats-…` | 通过，规范化为小写 `type/subtype` |
| `text/plain; charset=utf-8` | 通过，参数被去掉 → `text/plain` |
| 协议未提供类型（`null`/`undefined`/空串） | 通过，使用 `application/octet-stream` |
| 语法非法（`"not a mime"`、`text/`、`/plain`、`text//plain`、非字符串、超长） | 拒绝 `invalid_mime` |
| 未知但语法合法（`application/x-something-weird`） | **放行**（不做 MIME 数据库） |

---

## 7. 安全

| 资产/风险 | 处理 |
| --- | --- |
| `botToken` | 只在加密凭证存储里；出站走既有 `senderFor`（每账号独立 HTTP 客户端），不写日志（有测试断言日志里没有 `token-media-A`） |
| `context_token` | 渠道内部使用，只进加密存储；不进入 `InternalMessage`/Core，不出现在协议载荷以外的任何地方 |
| 媒体密钥（aes_key） | 只在内存里作为 `secretMaterial` 流转：`decodeWireMediaKey` → 加解密 → 直接写进协议字段；日志只有"大小/状态/原因" |
| `secretMaterial` | 与 `MediaHandle`（可公开的引用）严格分离（4.5-B 既有设计，本次沿用） |
| `encrypted_param` | 不落消息、不落日志、不落 API 响应（测试断言含 `encrypt_query_param` 与 `encrypted_param` 相关值均不在日志里） |
| 文件字节 | 只进 `MediaStorage`；消息表里只有 `mediaId` + 元数据。冒烟脚本直接查 `messages.content_json` 断言既没有明文 base64、也没有协议参数 |
| 路径穿越 | 文件名净化 + `mediaId` 白名单路径（见第 5 节），并用真实目录遍历做收容断言 |
| SSRF | `url.kind === "external"` 永不自动下载；出站遇到"只有外部 URL、没有 mediaId"直接 `DomainError(invalid_input)`，且断言零网络调用 |
| 可执行文件 | 只是字节：不执行、不解压、不解析、不索引（明确禁止项） |
| 日志卫生 | 只允许安全元数据：`mediaId`、大小、MIME、净化后的文件名、HTTP 状态、拒绝原因 |

---

## 8. 测试与真实结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **238 / 238 通过**（0 失败；较 C1 的 223 增加 15：文件集成 9 + 文件校验单元 6） |
| `pnpm typecheck` | 通过（退出码 0） |
| `pnpm build` | 通过（退出码 0） |
| `pnpm guard` | ARCH-1 … ARCH-8 **全部通过**（含 ARCH-7：物理删除 `channels/weixin` 后 `src` 仍能类型检查） |
| `pnpm smoke:phase4` | PASS（PHASE 4 SMOKE OK） |
| `pnpm smoke:phase45b` | PASS（PHASE 4.5-B SMOKE OK） |
| `pnpm smoke:phase45c1` | PASS（PHASE 4.5-C1 SMOKE OK） |
| `pnpm smoke:phase45c2` | PASS（PHASE 4.5-C2 SMOKE OK） |

覆盖点（对应要求逐条）：

1. **入站映射 + 落库**：`type=4` → `FilePart`；`filename` 被净化（`../../secrets/../secret.txt` → `secret.txt`）、`mimeType=application/octet-stream`、`sizeBytes` 为真实字节数、`width/height` 为 `null`、`status=available`、`mediaId` 合法、`MediaStorage.get` 读回字节与原文 **Buffer.compare === 0**。
2. **入站失败隔离**：缺密钥 / CDN 404 / 声明超限 三种全部 `failed` 且 `mediaId=null`；正常文件仍 `available`；`outcome.processed = 4`（一条不丢）；声明超限的那个**没有发生下载**。
3. **出站协议载荷**：`media_type=3`、`rawsize`/`filesize`、`item.type=4`、`file_item.media.encrypt_type=1`、`file_item.file_name`、`file_item.len` 是**字符串**且等于明文字节数；用消息里的 `aes_key` 解 CDN 密文得到原文件。
4. **二进制完整性**：测试数据固定包含 `0x00 / 0xFF / 0x01 / 0x80` 与随机字节，绝不按字符串处理；两个方向都用 `Buffer.compare` 断言完全一致。
5. **顺序与幂等**：`text + file + image + file` 的发文顺序为 `idem-mix`、`idem-mix:file:0`、`idem-mix:image:0`、`idem-mix:file:1`，item 类型依次为文件/图片/文件。
6. **拒绝路径（零网络）**：外部 URL、无 mediaId、存储未命中（含 `../../etc/passwd` 这种非法 id 形状）、存储里 MIME 语法非法、空文件 → 五种 `DomainError`；`getuploadurl`/`sendmessage` 调用数为 0、CDN 上传数为 0。
7. **出站文件名净化**：存储里是 `..\..\..\Windows\System32\evil.txt`，线上发出去的是 `evil.txt`（无任何路径分隔符）。
8. **重试与 -14**：第一次 503 后重试成功（2 次 sendmessage、复用同一 `client_id`）；`errcode -14` 不重试、`health=degraded`。
9. **日志泄漏**：入站 + 出站全链路日志不含 token、媒体密钥（hex/base64 两种编码）、下载参数、文件字节的 base64/hex。
10. **单元测试**：文件名 18 种输入、MIME 允许/缺省/非法/未知、声明大小解析（含超安全整数）、大小边界（0 / 1 / 精确上限 / 上限+1）、以及"恶意文件名无法决定落盘位置"的真实目录收容测试。

冒烟 `smoke:phase45c2` 真实输出（节选，无密钥/参数）：

```text
INBOUND: mock CDN 上是 8208 字节密文（明文 8192 字节）
REPLY -> WEIXIN: "（角色）文件收到了，我看看。"
CORE FILE PART: status=available mediaId=8e7e274e... mime=application/octet-stream filename=passwd size=8192 width=null
CONTEXT RENDER: "[文件: passwd]"（占位符，无 [object Object]：true）
MEDIA STORAGE: 落库字节与原始文件完全一致=true / checksum=6a65578421f0...
DB CHECK: content_json 里没有文件字节、也没有协议参数=true
GETUPLOADURL: media_type=3 rawsize=4096 filesize=4112 no_need_thumb=true
SENT ITEM: type=4（文件=4）file_name=报告.pdf len=4096（类型 string）encrypt_type=1 client_id=smoke-file-out-1:file:0
CDN 密文用消息里的 aes_key 可解回出站文件=true / 密钥 16 字节 / receipt=srv-2
PHASE 4.5-C2 SMOKE OK（入站文件落库，出站文件端到端可解密）
```

---

## 9. 真实服务验证

```text
Real Weixin file integration: NOT VERIFIED
Mock integration: PASS
```

本阶段所有验证都使用本地 mock 微信后端（`test/helpers/mock-weixin-server.ts`）与 mock CDN（`test/helpers/mock-weixin-cdn.ts`）。**没有**真实微信账号、真实 `ilinkai.weixin.qq.com`、真实 `novac2c.cdn.weixin.qq.com` 的联调记录。因此：

- 已验证：字段命名、编码方式、item 形状、加解密、重试/幂等/`-14` 语义、失败隔离、路径安全；
- 未验证：真实服务端是否对 `file_item` 有额外要求（例如是否也接受/要求 `md5` 之类的补充字段）、真实 CDN 对文件类型/大小的额外限制、真实客户端展示行为。

---

## 10. 已知限制

1. **真实微信未验证**（见第 9 节）。
2. **`secretMaterial` 未持久化**：出站每次发送都重新上传，同一文件重复发送会产生多份 CDN 对象（C1 起就存在的限制，本阶段未扩大范围）。
3. **整块内存传输**：受 `MEDIA_LIMITS.maxMediaBytes`（25 MiB）限制，未做流式；超大文件直接拒绝。
4. **无缩略图 / 无 `md5` 补充字段**：`no_need_thumb: true`；`file_item` 只发送协议研究明确列出的字段。
5. **0 字节文件被拒绝**（`empty`）：与图片策略一致；如未来需要"空文件也能传"，需要单独讨论并同步改图片/视频策略。
6. **文件名缺失时出站使用占位名 `file`**（无扩展名）。协议要求 `file_name` 存在，我们不做"按 MIME 猜扩展名"的推断。
7. **文件内容不解析**（明确的设计选择）：没有 PDF/DOCX/OCR/压缩包解析、没有文本抽取、没有 embedding、没有 RAG，也没有文件理解；文件也不自动成为记忆。
8. **入站文件 MIME 固定为 `application/octet-stream`**：协议未在 `file_item` 里提供 MIME，我们也不做内容嗅探（嗅探就等于解释内容）。
9. **Web 端没有文件上传/下载 UI**：本阶段前端未改动；HTTP API 出站消息仍是纯文本，文件只能由 Core/主动消息产生（与 C1 的图片一致）。
10. **一次 sendmessage 只带一个 item**：多文件 = 多条消息（协议硬约束），因此"多文件"不是单条消息里的多 item。

---

## 11. 后续阶段（本阶段**未**实现）

明确**没有**实现，也不在本阶段范围内：

```text
Phase 4.5-C3 — 视频消息
Phase 4.5-D  — 语音 / Silk
ASR
TTS
OCR
Vision
文件内容解析（PDF/DOCX/压缩包/文本抽取/document RAG/embeddings）
Browser
Agent
Live2D
Phase 5
```

Phase 4.5-C2 到此结束。未经确认不会自动进入 4.5-C3 / 4.5-D / Phase 5，也不会做与文件无关的重构。

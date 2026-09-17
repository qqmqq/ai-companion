# Phase 4.5-C1 报告：微信图片消息的收发

> 阶段目标：让微信通道真正**收发图片**（入站下载 + 出站上传），同时保持 Core 平台无关。
> 范围严格限定为图片；文件/视频/语音（4.5-C2/C3/D）不在本阶段。

结论（诚实说明验证强度）：

```text
Real Weixin media integration: NOT VERIFIED
Mock integration: PASS
```

"Mock integration: PASS" 的含义是：真实的协议代码（AES-128-ECB、getuploadurl、CDN 上传/下载、image_item 构造、长轮询入站映射）在真实进程、真实 HTTP、真实 SQLite、真实文件系统上跑通了，但对面是本地 mock 微信后端与 mock CDN。"NOT VERIFIED" 的含义是：没有用真实微信账号、真实 CDN 域名验证过，真实 CDN 的行为差异（例如响应头、加密参数语义、图片转码）仍是未知数。

---

## 1. 本阶段改动文件

新增：

| 文件 | 作用 |
| --- | --- |
| `backend/src/channels/weixin/media/image-validation.ts` | 图片校验：魔数嗅探、尺寸读取（PNG/GIF/WEBP/JPEG 文件头）、MIME 白名单、大小上限 |
| `backend/test/unit/image-validation.test.ts` | 校验模块的单元测试（7 个用例） |
| `backend/test/integration/weixin-image-messages.test.ts` | 图片收发的集成测试（8 个用例，跑真实协议代码 + mock 后端/CDN） |
| `backend/scripts/phase45c1-smoke.ts` | 端到端冒烟：入站图片落库、出站图片端到端可解密 |

修改（渠道层，允许认识微信）：

| 文件 | 改动 |
| --- | --- |
| `backend/src/channels/weixin/protocol/media-types.ts` | 新增 `WeixinCdnMediaObject`、`WeixinImageItem`、`OutboundImageItem`、`CDN_ENCRYPT_TYPE_PACKED`（出站 `image_item.media` 结构） |
| `backend/src/channels/weixin/protocol/types.ts` | `MessageItem` 增加 `image_item` |
| `backend/src/channels/weixin/media/aes-media.ts` | 新增 `decodeWireMediaKey`：接受 `hex` / `base64(16 字节)` / `base64(32 位 hex)` 三种线上形态 |
| `backend/src/channels/weixin/media/media-transport.ts` | 复用（未改语义）：上传返回 `secretMaterial`（媒体密钥 + 下载参数）与 `handle.transferredSizeBytes`（密文长度 → `mid_size`） |
| `backend/src/channels/weixin/receiver/inbound-mapper.ts` | `collectParts` 支持图片：产出 `ImagePart`（`pending`/`failed`）+ `mediaCandidates`；导出 `applyMediaReferences` / `markMediaFailed` |
| `backend/src/channels/weixin/receiver/long-poll.ts` | 新增 `hydrateMedia` 钩子：去重认领后、游标提交前把 `pending` 引用替换成真实引用；失败只影响该图 |
| `backend/src/channels/weixin/sender/sender.ts` | 抽出共享 `sendItem`（重试/幂等/-14 语义只保留一份），新增 `sendImage` |
| `backend/src/channels/weixin/channel.ts` | 新增 `deps.mediaStorage`、`hydrateInboundMedia`、`prepareOutboundImage`；`send()` 支持"文字 + 图片" |

修改（平台无关层，只做端口透传，不认识微信）：

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/ports/channel-module.ts` | `ChannelModuleContext` 增加 `mediaStorage`（Core 端口，无平台字样） |
| `backend/src/channels/weixin/index.ts` | 把 `context.mediaStorage` 交给渠道 |
| `backend/src/app/bootstrap.ts` | 创建 `createLocalMediaStorage` 并注入容器与渠道上下文 |

测试与工具：

| 文件 | 改动 |
| --- | --- |
| `backend/test/helpers/mock-weixin-server.ts` | 记录 `sentMessages[].items`（断言图片 item）、新增 `sendOverride`（-14 注入）、新增 `inboundImageMessage()` |
| `backend/test/helpers/weixin-stack.ts` / `weixin-media-stack.ts` | 提供临时目录 + 真实 `LocalMediaStorage`，并在关闭时清理 |
| `backend/test/unit/weixin-aes-media.test.ts` | 增加"线上密钥三种形态"用例 |
| `backend/package.json` | 增加 `smoke:phase45c1` |

未改动：Core 模型与业务（`core/model`、记忆、关系、情绪、调度、主动、model-router）、前端、Phase 4 / 4.5-B 的既有实现。

---

## 2. 入站架构：微信发来一张图片

链路（每一步都在渠道内部，Core 只看得到 `MediaReference`）：

```text
getupdates → 长轮询批次
  → inbound-mapper：item_list 里的 type=2 → ImagePart{ media: {origin:"channel", status:"pending"} }
                    + mediaCandidates[{ partIndex, encryptQueryParam, fullUrl, aesKey, mid_size }]
  → 去重认领 + context_token 落加密存储（Phase 4 既有逻辑）
  → hydrateMedia(candidates)（渠道注入）：
        1. decodeWireMediaKey(aesKey)            ← 统一三种线上形态
        2. MediaTransport.download(...)          ← CDN 下载密文 + AES-128-ECB/PKCS#7 解密
        3. validateImage(bytes)                  ← 魔数 / 大小 / MIME 一致性 / 尺寸
        4. MediaStorage.put(bytes, mime)         ← 只返回 mediaId
        5. sanitizeMediaReference({ mediaId, mime, size, width, height, status:"available" })
  → applyMediaReferences(parts, refs) / markMediaFailed(parts, indices)
  → inbound → Core（消息落库，媒体只留 mediaId）
```

关键性质：

- **Core 完全不知道微信**：消息里只有 `mediaId / mimeType / sizeBytes / width / height / status`，没有 `encrypt_query_param`、`aes_key`、`mid_size`、`mid_size` 之类的协议字段。
- **失败隔离**：任何一步失败（缺密钥、404、解密失败、不是图片、存储失败）都只把该 part 标成 `status:"failed"`，消息照常投递；`long-poll` 的 `hydrateMedia` 调用被 try/catch 包住，抛异常时该批图片全部标 failed 而不丢消息。
- **游标安全**：media hydration 发生在游标提交之前，且不影响 `committed` 语义（冒烟与集成测试都断言 `outcome.committed === true`）。
- **不做无源抓取**：整条入站链路只走 `MediaTransport`，没有任何 `fetch` 直接打 CDN。

---

## 3. 出站架构：Core 的 ImagePart 变成微信图片消息

链路：

```text
Core（InternalResponse.parts: [{kind:"image", media:{mediaId}}]）
  → WeixinChannel.send()
       1. 文字先发（若有）：sendText(..., idempotencyKey = response.idempotencyKey)
       2. 逐张图片：
          prepareOutboundImage(accountId, conversationRef, part)
            a. mediaId === null → DomainError(invalid_input)
               （url.kind === "external" 时明确报错：不抓外部地址，SSRF 防护）
            b. MediaStorage.get(mediaId) → 不存在 → DomainError(not_found)
            c. validateImage(bytes, declaredMime) → 不合格 → DomainError(invalid_input)
            d. MediaTransport.upload(...) → { handle, secretMaterial }
          sender.sendImage({ encryptQueryParam, aesKeyProtocolBase64, ciphertextSizeBytes, idempotencyKey })
  → sendmessage（每条消息一个 item）
```

设计要点：

- **每条媒体一个幂等键**：`<idempotencyKey>:image:<index>`，重试复用同一个 `client_id`，重发同一 Core 响应不会重复上传/重复发送。
- **文字先于图片**：图片上传失败时，文字已经送达，不会回滚已成功的部分；错误按 `DomainError` 上抛（`invalid_input` / `not_found` / `channel_unavailable`），错误信息里不含任何密钥或参数。
- **只有一套重试/幂等/session 语义**：图片与文字共用 `sendItem`，没有为图片发明第二套重试；`-14` 依旧走 `markCredentialInvalid`（有测试断言 `health.state === "degraded"`）。
- **不新增 Core 字段**：出站图片就是用 Phase 4.5-A 已有的 `ImagePart.media.mediaId`；`OutboundPart` 未扩展。

---

## 4. 协议映射（字段级）

### 4.1 出站

| 我们构造的字段 | 值 | 来源 |
| --- | --- | --- |
| `getuploadurl.media_type` | `1` | `uploadMediaTypeFor("image")`（Phase 4.5-B） |
| `getuploadurl.rawsize` | 明文字节数 | `MediaStorage` 读回的字节 |
| `getuploadurl.filesize` | `ceil((n+1)/16)*16` | `encryptedSize` |
| `getuploadurl.rawfilemd5` | 明文 MD5（hex） | `plaintextMd5Hex` |
| `getuploadurl.aeskey` | 32 位 hex | 本次上传随机生成的 16 字节密钥 |
| `getuploadurl.no_need_thumb` | `true` | 本阶段不做缩略图 |
| `item.type` | `2`（`ITEM_TYPE_IMAGE`） | 协议常量 |
| `item.image_item.media.encrypt_query_param` | CDN 上传响应头 `x-encrypted-param` | `MediaTransport.upload().secretMaterial` |
| `item.image_item.media.aes_key` | `base64("32 位 hex 字符串")` | `mediaKeyToProtocolBase64` |
| `item.image_item.media.encrypt_type` | `1`（`CDN_ENCRYPT_TYPE_PACKED`） | 协议常量 |
| `item.image_item.mid_size` | 密文字节数 | `MediaHandle.transferredSizeBytes` |
| `item.image_item.aeskey` | **不发送**（该 hex 字段只用于入站） | — |

### 4.2 入站

| 线上字段 | 处理 |
| --- | --- |
| `item.type === 2` | 映射为 `ImagePart` |
| `image_item.media.encrypt_query_param` | 交给 `MediaTransport.download`（不落消息） |
| `image_item.media.full_url` | 同上（作为下载地址备选） |
| `image_item.aeskey`（hex） | 优先使用 |
| `image_item.media.aes_key`（base64） | 次选；两种 base64 形态都支持（16 字节原始 / 32 位 hex 字符串） |
| `image_item.mid_size` | 仅作为 `handle.sizeBytes` 的诊断值，不参与解密 |
| 缺 `encrypt_query_param`/`full_url` 或缺密钥 | part 直接置 `status:"failed"`，不尝试下载 |

---

## 5. 媒体生命周期

```text
入站：  pending ──(下载+解密+校验+落库成功)──> available
           └────(任何一步失败)───────────────> failed
出站：  available ──(校验+上传成功)──> 发出 image_item
           └────(mediaId 缺失 / 存储未命中 / 不是图片)──> 明确报错，不发消息
```

- **存储位置**：`<dataDir>/media/<前两位>/<mediaId>.bin` + 同名 `.json` sidecar；`mediaId` 是我们自己的 32 位 hex，写入用临时文件 + `rename` 原子替换，权限 0600。
- **幂等**：`mediaId` 由 `sha256` 校验和与元数据描述；读取路径遇到非法 id 返回"不存在"而不是抛异常。
- **不做的传播**：图片**不会**自动进入记忆、不会生成 embedding、不会进上下文快照原文；上下文里只有占位符 `[图片]`（集成测试断言渲染结果不含 `[object Object]`）。
- **重复上传**：本阶段 `secretMaterial` 仍未持久化（见第 8 节），每次出站发送都会重新上传并拿到新的 CDN 参数。

---

## 6. 安全

| 风险 | 本阶段的处理 |
| --- | --- |
| SSRF | Core/渠道都不会因为 `url.kind === "external"` 去请求网络；出站遇到"只有外部 URL、没有 mediaId"直接 `DomainError(invalid_input)`（有测试断言零网络调用） |
| 二进制进数据库/日志 | 字节只进 `MediaStorage`；`messages.content_json` 里只有 `mediaId` 与元数据。冒烟脚本直接查 `content_json` 断言不含明文 base64、也不含协议参数 |
| 密钥泄漏 | 媒体密钥/下载参数只以 `secretMaterial` 形态在内存中流转，不进 `handle`、不进消息、不进日志（集成测试对 8 类敏感值做"日志不得包含"断言） |
| 路径穿越 | `mediaId` 必须匹配 `^[0-9a-f]{32}$`，非法 id 的读路径直接当"不存在" |
| 伪装的媒体 | MIME 以魔数为准，不信任文件名与 `declaredMime`；声明与内容矛盾 → `mime_mismatch`，直接拒绝 |
| 错误页被当成图片 | CDN 下载沿用 4.5-B 的策略：`text/html`、`application/json` 等一律拒绝；只有 `application/octet-stream`/缺省或匹配的真实媒体类型可通过 |
| 资源耗尽 | 单文件上限 `MEDIA_LIMITS.maxMediaBytes`（25 MiB），下载与上传都在网络调用之前先检查大小（4.5-B 的测试覆盖） |
| 凭证失效 | `-14` 立刻停止重试并标记 `requiresRelogin`（沿用 Phase 4 的粘性语义） |

---

## 7. 测试与真实结果

命令与真实结果（Windows / Node 24.15.0 / 本机 mock）：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **223 / 223 通过**（0 失败；含本阶段新增 8 个集成用例、7 个校验用例、1 个密钥形态用例） |
| `pnpm typecheck` | 通过（`tsc --noEmit`，退出码 0） |
| `pnpm build` | 通过（退出码 0） |
| `pnpm guard` | ARCH-1 … ARCH-8 **全部通过**（含 ARCH-7：物理删除 `channels/weixin` 后整个 `src` 仍能类型检查） |
| `pnpm smoke:phase4` | PASS（PHASE 4 SMOKE OK） |
| `pnpm smoke:phase45b` | PASS（PHASE 4.5-B SMOKE OK） |
| `pnpm smoke:phase45c1` | PASS（PHASE 4.5-C1 SMOKE OK） |

新增测试覆盖的内容：

1. **出站往返（集成）**：`getuploadurl.media_type=1`、`rawsize`/`filesize`/`no_need_thumb` 正确；CDN 上只有密文；`item.type=2`、`encrypt_type=1`、`mid_size=` 密文长度；用消息里的 `aes_key` 解 CDN 密文得到原图（`Buffer.compare === 0`）。
2. **文字 + 图片共存**：先文字后图片，`client_id` 分别为 `idem-mix` / `idem-mix:image:0` / `idem-mix:image:1`，两张图各上传一次。
3. **入站完整链路**：下载 → 解密 → 校验 → 落库；`status="available"`、`mediaId` 合法、`mimeType="image/png"`、`width/height` 来自文件头；`MediaStorage.get` 读回字节与原图完全一致；上下文渲染为 `[图片]`。
4. **入站密钥形态**：`image_item.aeskey`（hex）与 `media.aes_key`（base64）两种都能收。
5. **失败隔离**：缺密钥 / CDN 404 / 内容不是图片 / 密钥错误 四种情况全部 `failed`，且 `outcome.processed === 5`（一条都没丢），对照的正常图片仍为 `available`。
6. **出站拒绝路径**：外部 URL、无 mediaId、存储未命中、存储里不是图片 → 四种 `DomainError`，且 `getuploadurl`/`sendmessage` 调用数为 0、CDN 上传数为 0。
7. **发送失败与 -14**：第一次 503 后重试成功（2 次 sendmessage）；`errcode -14` 不重试并让 `health` 变成 `degraded`。
8. **日志安全**：入站 + 出站全链路日志里不含 token、媒体密钥（hex 与 base64 两种编码）、下载参数、明文 base64/hex。
9. **校验模块单元测试**：四种格式的魔数与尺寸、文件名说谎被拒、声明与内容矛盾被拒、空/超限被拒、边界值（正好等于上限）通过、模块保持纯净（无 console、无 fetch、无图像库依赖）。

冒烟脚本 `smoke:phase45c1` 的真实输出（节选，未含任何密钥/参数）：

```text
INBOUND: mock CDN 上是 144 字节密文（明文 129 字节）
REPLY -> WEIXIN: "（角色）图片我看到了，拍得不错。"
CORE IMAGE PART: status=available mediaId=dac93289... mime=image/png size=129 尺寸=64x48
CONTEXT RENDER: "[图片]"（占位符，无 [object Object]：true）
MEDIA STORAGE: 落库字节与原始图片完全一致=true / checksum=f5ef2c8b4f7f...
DB CHECK: content_json 里没有图片字节、也没有协议参数=true
GETUPLOADURL: media_type=1 rawsize=129 filesize=144 no_need_thumb=true
SENT ITEM: type=2（图片=2）mid_size=144 encrypt_type=1 client_id=smoke-out-1:image:0
CDN 密文用消息里的 aes_key 可解回出站图片=true / 密钥 16 字节 / receipt=srv-2
PHASE 4.5-C1 SMOKE OK（入站图片落库，出站图片端到端可解密）
```

---

## 8. 已知限制

1. **真实微信未验证**：所有测试与冒烟都跑在本地 mock 后端与 mock CDN 上（`Real Weixin media integration: NOT VERIFIED`）。真实 CDN 的响应头、加密参数语义、可能的图片转码/压缩都会影响 `mid_size` 与缩略图行为。
2. **`secretMaterial` 未持久化**：出站每次发送都重新上传，同一张图重复发送会产生多份 CDN 对象与不同的 `encrypt_query_param`（因此也解释了 `mid_size` 每次可能不同）。持久化需要加密凭证存储的扩展，属于后续阶段。
3. **下载/上传是整块内存**：受 `maxMediaBytes`（25 MiB）限制，未做流式，超大文件不在本阶段范围。
4. **没有缩略图**：`no_need_thumb: true`，入站也不处理 `thumb_media`。
5. **入站图片不写入文件名**：`filename = null`（协议里没有可靠的文件名），尺寸与 mime 来自内容嗅探。
6. **没有图片理解**：不做 OCR / Vision / 反查，Core 只看到 `[图片]` 占位符；图片也不会自动成为记忆。
7. **格式白名单有限**：只接受 `image/jpeg | image/png | image/gif | image/webp`；其它真实图片格式（如 HEIC/BMP）会被拒绝并标记 `failed`（消息仍投递）。
8. **Web 前端不提供图片上传入口**：本阶段前端只做占位符渲染（Phase 4.5-A 已实现），HTTP API 的出站消息仍是纯文本（`src/app/outbound.ts` 未改）。
9. **上一轮全量测试出现过一次与图片无关的偶发失败**：`test/integration/phase2-api.test.ts` 的端到端用例在整包并发下曾返回 502，单独运行与本次全量重跑均为通过；判断为本地 mock 模型服务在负载下的偶发抖动，与本次改动无关（本次未触碰 provider/context 代码）。

---

## 9. 后续阶段

| 阶段 | 内容 | 与 C1 的关系 |
| --- | --- | --- |
| 4.5-C2 | 文件消息（`UploadMediaType.FILE=3` / `item.type=4`） | 复用本阶段的 `MediaTransport` + `MediaStorage` + 校验/落库骨架，只需新增文件名与 `file_item` 映射 |
| 4.5-C3 | 视频消息（`type=5`，可能带时长/缩略图） | 同上，需要额外的元数据与 thumb 处理 |
| 4.5-D | 语音（Silk 编码转换、转写） | 需要新增解码器，不复用本阶段的 AES 链路之外的逻辑 |
| 4.5-E（建议） | 媒体密钥持久化 + 缩略图 + 流式传输 | 解决第 8 节的限制 2/3/4 |
| Phase 5 | Agent / 工具 / 浏览器 / TTS / Live2D | 与本阶段正交 |

本阶段到此为止：不做 4.5-C2/C3、4.5-D、Phase 5，也不改写 Phase 4 / 4.5-B 的既有实现。

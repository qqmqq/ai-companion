# Phase 4.5-B 开发报告：微信媒体传输基础设施（CDN + AES）

> 状态：**已完成**。只做传输基础设施 —— 微信媒体 CDN、`getuploadurl`、上传/下载、AES-128-ECB/PKCS#7、平台无关的 MediaStorage/MediaTransport 抽象。
> **未接入消息收发**：图片/语音/视频/文件消息的 inbound/outbound 一律留给 Phase 4.5-C / 4.5-D；未触碰 Silk / ASR / TTS / OCR / Vision / 前端媒体 UI。

## 1. 修改文件

### 新增：Core（平台无关）
| 文件 | 作用 |
| --- | --- |
| `backend/src/core/ports/media-storage.ts` | 媒体存储端口：`put / get / stat / has / remove`，只谈 `mediaId` 与元数据 |
| `backend/src/core/ports/media-transport.ts` | 媒体传输端口：`upload / download`，并把 `handle`（可公开）与 `secretMaterial`（只能进凭证存储）分开 |
| `backend/src/storage/media/local-media-storage.ts` | 文件系统实现：临时文件 + rename 原子写、sha256 校验、大小/元数据上限、非法 id 不触盘 |

### 新增：微信渠道（协议与实现）
| 文件 | 作用 |
| --- | --- |
| `channels/weixin/media/aes-media.ts` | AES-128-ECB + 手写 PKCS#7、密钥严格校验、`encryptedSize`、密钥编码（hex / base64-of-hex）、明文 md5；**纯函数、零日志、零网络** |
| `channels/weixin/protocol/media-types.ts` | `getUploadUrl` 请求/响应、`CdnMediaReference`、`media_type` 码（1 图 / 2 视频 / 3 文件 / 4 语音） |
| `channels/weixin/media/cdn-client.ts` | CDN 上传/下载：URL 构造（`upload_full_url` 优先）、200 + `x-encrypted-param` 成功判据、4xx 立即放弃、`x-error-message` 诊断、内容类型策略 |
| `channels/weixin/media/media-transport.ts` | 实现 Core `MediaTransport`：校验大小 → 生成密钥 → `getuploadurl` → 加密 → 上传 →（下载 → 解密）；有限重试；错误分类 |

### 新增：测试与脚本
`backend/test/helpers/mock-weixin-cdn.ts`、`backend/test/helpers/weixin-media-stack.ts`、`backend/test/unit/weixin-aes-media.test.ts`、`backend/test/unit/local-media-storage.test.ts`、`backend/test/integration/weixin-media-transport.test.ts`、`backend/scripts/phase45b-smoke.ts`。

### 修改（逐条说明原因）
| 文件 | 原因 | 修改内容 |
| --- | --- | --- |
| `core/model/media.ts` | 需要统一的字节上限，避免出现多个互相冲突的限制 | 新增 `maxMediaBytes`(25 MiB)、`maxMediaMetadataBytes`、`isWithinMediaSizeLimit` |
| `channels/weixin/protocol/errors.ts` | 复用既有错误体系（不新建重复 Error 类） | `WeixinErrorKind` 增加 `protocol_error / encryption_error / decryption_error / size_limit`；只有传输类错误可重试 |
| `channels/weixin/protocol/endpoints.ts` | `getuploadurl` 端点缺失 | 增加 `getUploadUrl` 路径常量 |
| `channels/weixin/protocol/http-client.ts` | CDN 需要字节级请求 | 增加 `postBytes/getBytes`（复用同一套超时/中止/错误分类；CDN 请求**不带微信鉴权头**）；响应体支持 `maxBytes` 上限 |
| `channels/weixin/channel.ts` | 让媒体基础设施可被上层取用（但**不接入消息流**） | 新增 `createMediaTransport(accountId)` 与 `mediaOptions` 注入点 |
| `app/bootstrap.ts` | Core 需要平台无关的媒体存储 | 装配 `LocalMediaStorage` 并暴露为 `container.mediaStorage` |
| `test/helpers/mock-weixin-server.ts` | 需要模拟 `getuploadurl` | 增加该端点、`cdnBaseUrl`、`uploadUrlResponse` 与 `uploadUrlFailures` 注入 |
| `channels/weixin/receiver/long-poll.ts` | **冒烟测试暴露的真实缺陷** | 详见第 7 节：`-14`/无凭证时循环必须退出，否则是饿死事件循环的忙等 |

## 2. MediaStorage / MediaTransport 最终接口

```
// core/ports/media-storage.ts
export interface MediaPutInput {
  bytes: Uint8Array;
  mimeType: string | null;
  filename: string | null;
  origin: MediaOrigin;                 // channel | generated | external
}

export interface MediaAsset {
  mediaId: string;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number;
  checksum: string;                    // sha256 hex（不可逆，不泄漏内容）
  origin: MediaOrigin;
  createdAt: string;
}

export interface MediaReadResult extends MediaAsset { bytes: Uint8Array }

export interface MediaStorage {
  readonly kind: string;
  put(input: MediaPutInput): Promise<MediaAsset>;
  get(mediaId: string): Promise<MediaReadResult | null>;
  stat(mediaId: string): Promise<MediaAsset | null>;
  has(mediaId: string): Promise<boolean>;
  remove(mediaId: string): Promise<boolean>;
}
```

```
// core/ports/media-transport.ts
export interface MediaUploadRequest {
  accountId: string;
  conversationRef: string;
  kind: MediaKind;                     // image | audio | video | file
  bytes: Uint8Array;
  mimeType: string | null;
  filename: string | null;
  signal?: AbortSignal;
}

export interface MediaHandle {          // 可公开：可进日志/快照/消息
  provider: string;
  mediaId: string | null;               // Core 侧 mediaId（与渠道 CDN 标识分离）
  sizeBytes: number;
  transferredSizeBytes: number;         // 渠道侧加密后大小
  mimeType: string | null;
  filename: string | null;
  uploadedAt: string;
}

export interface MediaUploadResult {
  handle: MediaHandle;
  /** 只能写入加密凭证存储；不得进日志/消息/快照/API */
  secretMaterial: Record<string, string>;
}

export interface MediaDownloadRequest {
  accountId: string;
  handle: MediaHandle;
  secretMaterial: Record<string, string>;
  expectedMimeType?: string | null;
  signal?: AbortSignal;
}

export interface MediaDownloadResult { bytes: Uint8Array; mimeType: string | null; sizeBytes: number }

export interface MediaTransport {
  readonly kind: string;
  upload(request: MediaUploadRequest): Promise<MediaUploadResult>;
  download(request: MediaDownloadRequest): Promise<MediaDownloadResult>;
}
```

**id 分层**（需求 §16）：`Core mediaId`（我们自己的存储，32 位十六进制）↔ `MediaHandle.provider + transferredSizeBytes`（渠道侧引用，可公开）↔ `secretMaterial`（密钥与下载参数，仅凭证存储）。**微信 CDN 的标识不会被当成 Core 的永久 mediaId。**

## 3. 微信 CDN 协议实现

```
上传
 media bytes
   → 大小校验（≤25 MiB）
   → 生成 16 字节 key + 16 字节 filekey
   → 计算 rawsize / rawfilemd5(明文 md5) / filesize(encryptedSize)
   → POST ilink/bot/getuploadurl  {filekey, media_type, to_user_id, rawsize, rawfilemd5,
                                   filesize, no_need_thumb:true, aeskey:<hex>, base_info}
   → 取 upload_full_url（优先）否则 upload_param + filekey 拼 <cdn>/upload?...
   → AES-128-ECB/PKCS#7 加密
   → POST 密文（Content-Type: application/octet-stream）
   → 成功判据：HTTP 200 且响应头 x-encrypted-param 非空（错误详情读 x-error-message）
   → 产出 MediaHandle + secretMaterial{mediaKey(base64-of-hex), encryptQueryParam}

下载
 secretMaterial → 取 full_url（优先）否则 <cdn>/download?encrypted_query_param=...
   → GET 密文（Content-Length / 实际字节数都受 maxBytes 约束）
   → AES-128-ECB 解密 + PKCS#7 校验
   → 原始 bytes（与上传前必须二进制一致）
```

- 缩略图：本阶段**不**上传缩略图（`no_need_thumb: true`），与 Phase 0 记录的行为一致。
- `media_type` 映射：image=1 / video=2 / file=3 / audio=4（有测试逐个断言）。
- 内容类型策略（**实现中发现并修正的设计错误**）：CDN 上放的是密文，因此 `application/octet-stream`（或缺省）是**正常**回答；`text/html|text/plain|application/json|xml` 判为"疑似错误页"直接拒绝；只有 CDN 明确声明的**真实媒体类型**与期望不一致时才报 Media-Type 不匹配。
- 重试：复用 Phase 4 的 `computeBackoffMs` + 可中止 sleep（**没有第二套 backoff**）；4xx 与"缺少 x-encrypted-param"以外的协议错误、加密/解密/大小错误都不重试。

## 4. AES

- 算法：`AES-128-ECB`，密钥固定 **16 字节**；`node:crypto` 的 `createCipheriv/createDecipheriv("aes-128-ecb", key, null)`，并关闭自动填充（`setAutoPadding(false)`）后**手工**做 PKCS#7，便于严格校验与测试。
- 密钥处理：`assertMediaKey` 严格校验长度；**15/17 字节直接拒绝**，既不截断也不补齐；非 `Uint8Array` 拒绝；错误信息里不含密钥内容。
- `encryptedSize(n) = ceil((n + 1) / 16) * 16`，与 PKCS#7 填充长度**在测试里逐值对照**（0→16、1→16、15→16、16→32、17→32、31→32、32→48、33→48）。
- 解密：`invalid padding`（空、非块对齐、pad=0、pad>16、字节不一致）一律抛 `decryption_error` 且 `retryable=false`，**绝不返回可疑明文**；密钥不匹配时可能表现为解密失败或 padding 非法，两者都显式报错。
- 编码：`getuploadurl.aeskey` 用 **hex**；媒体消息里的 `aes_key` 用 **base64(hex 字符串)**；两者都有往返测试，绝不自行发明编码。

## 5. 安全

| 敏感物 | 处理方式 | 验证 |
| --- | --- | --- |
| 微信 token | 仍在 Phase 1 的 CredentialStore（密文）；媒体传输只从机密里取 baseUrl/token | 冒烟 + 传输测试断言日志无 token |
| AES key | 只存在于 `secretMaterial`；handle 与日志都不含 | 测试断言 `JSON.stringify(handle)` 不含密钥；日志断言不含密钥（hex 与 base64 两种形态） |
| encrypted_param（下载参数） | 同上；上传响应头只进 `secretMaterial`，日志只记字节数/状态 | 同上 |
| 媒体 bytes | 加密模块**完全不打日志**（源码级断言：无 `console.*`、无 logger、无 fetch）；HTTP 层只记长度与状态；MediaStorage 只记 id/尺寸 | 传输测试与存储测试各自断言日志不含明文的 base64/hex |
| 二进制不进数据库 | 消息表只留 `MediaReference`；字节落在 `<dataDir>/media/...`（0600） | 存储测试断言元数据里没有 `bytes` 字段 |
| 超大响应/超大媒体 | `maxBytes`（25 MiB）在传输前与读取响应时双重约束；超限抛 `size_limit`（不重试） | 测试断言超限时**零网络调用** |
| 非法 mediaId | 读路径视为"不存在"（不抛错、不触盘），写路径报错 | 存储测试覆盖 `../../etc/passwd` 等 |

## 6. 测试结果（实际运行）

```
pnpm test       → tests 207 / pass 207 / fail 0     (Phase 4.5-A 为 182，本阶段 +25)
pnpm typecheck  → 后端 + 前端 全通过
pnpm build      → 前端构建成功（291.89 kB / gzip 91.88 kB）
pnpm guard      → ARCH-1..8 全部通过

smoke:phase4    → PHASE 4 SMOKE OK（登录 / 收消息 / 回复 / 主动消息 / -14 停止轮询，无回归）
smoke:phase45b  → PHASE 4.5-B SMOKE OK（二进制完全一致）
```

`smoke:phase45b` 真实输出（真实进程 + 真实文件系统 + mock 微信后端 + mock CDN）：

```
LOGIN: phase=logged_in account=wx-media-account
MEDIA STORAGE: mediaId=a20c4bdd… size=3000 checksum=95943b8c3d8e… bytes-equal=true
GETUPLOADURL: media_type=1 rawsize=3000 filesize=3008 (= encryptedSize 3008) no_need_thumb=true
CDN UPLOAD: ciphertext=3008 字节 / 明文=3000 字节 / 与明文不同=true
DOWNLOAD+DECRYPT: 3000 字节 / Buffer.equals(原始) = true
SECRET SPLIT: handle 里含密钥=false / 密钥长度=16 字节 / 下载参数下发到 handle=false
TAMPERED CIPHERTEXT: 拒绝=true reason="invalid padding: padding 长度非法（253）"
OVERSIZE REJECTED: 媒体超过大小上限（26214401 > 26214400 字节）
PHASE 4.5-B SMOKE OK（二进制完全一致）
```

新增测试明细：
- **AES/PKCS#7**（9 项）：`encryptedSize` 全边界并与填充长度对照；填充往返（含 16 字节整块补满块）；非法 padding 五种形态；0/1/15/16/17/32/33/1K/64K 与随机二进制往返（`Buffer.equals`/`Buffer.compare`）；密钥 16 通过 / 15、17、0、32 拒绝 / 非 Buffer 拒绝；错密钥与篡改密文拒绝；密钥编码往返；明文 md5；**源码级断言：加密模块无 console、无 logger、无 fetch**。
- **MediaStorage**（4 项）：put/get/stat/has/remove 与二进制一致；元数据不含 bytes；上限与非法 id（读返回 null、写抛错）；日志只含 id/尺寸不含内容。
- **MediaTransport**（9 项）：完整往返（随机 4096 字节，`Buffer.compare === 0`）；`media_type` 四类映射；超限/空媒体在**零网络调用**下被拒；上传失败重试（2 次失败后成功）与 4xx 不重试；缺 `x-encrypted-param` 重试后放弃；`getuploadurl` 的 `-14`/缺地址/瞬时失败三种分支；下载 404 不重试、500 重试后成功、超时（`aborted`）、Media-Type 不匹配、错误页内容类型拒绝、octet-stream 正常接受；篡改密文/缺密钥/错密钥 → `decryption_error` 且不重试；日志不含密钥、参数、明文的 base64/hex。
- **渠道回归**：新增"失效后循环必须停下、不得空转"（第 7 节缺陷的回归测试）。

## 7. 过程中发现并修复的真实缺陷

1. **忙等饿死事件循环（严重）**：`runOnce` 在"凭证失效/没有凭证"时立即返回（不请求后端、也不等待网络）。轮询循环原先无条件继续，于是变成一个**没有任何 await 让出点**的微任务忙等——`smoke:phase4` 因此在 `-14` 之后**挂死**（进程不再响应 HTTP）。已修复为：这两种情况直接退出循环，等待重新登录（`reloginAccount` 会重新拉起），并加了回归测试（断言失效后后端调用数不再增长）。
2. **CDN 内容类型策略错误**：最初把 CDN 的 `Content-Type` 与媒体 MIME 直接比较，导致 `application/octet-stream`（密文的正常响应）被误判失败。已改为"密文容器类型可接受、文本类判为错误页、只有明确声明的真实媒体类型不符才报错"。
3. **读路径不该抛异常**：`MediaStorage.get` 遇到非法 id 原先抛 `DomainError`；对外部 id 更安全、更好用的语义是"视为不存在"，已改为读返回 `null`、写仍抛错。

## 8. 已知问题

| # | 问题 | 影响 | 计划 |
| --- | --- | --- | --- |
| B-1 | 媒体传输未接入消息收发 | 还不能真的收发图片/文件 | Phase 4.5-C |
| B-2 | 未实现缩略图（`no_need_thumb: true`） | 部分客户端预览可能不显示缩略图 | 视需要 |
| B-3 | `secretMaterial` 的持久化尚未接线（本阶段只产出） | 重启后无法用旧引用下载 | Phase 4.5-C（写进 CredentialStore 或专门的加密媒体凭证） |
| B-4 | 下载仍是"整块读进内存" | 受 25 MiB 上限约束，暂可接受 | 需要更大媒体时再考虑流式 |
| B-5 | 上传只做整文件加密，未做分片 | 大文件内存占用高 | 同 B-4 |
| B-6 | 未做媒体传输的速率限制/并发控制 | 批量上传可能打满带宽 | 后续 |
| B-7 | Voice 的 `media_type=4` 已支持，但没有 Silk 编码（微信语音要求） | 语音消息暂时发不出去 | Phase 4.5-D |
| B-8 | 未在真实微信 CDN 上验证（只有 mock） | 协议细节仍可能有出入（如 `x-encrypted-param` 行为） | 需要真实账号实测 |
| B-9 | `md5` 仅用于协议字段，不是安全哈希 | — | 仅按协议使用 |

## 9. 未完成事项（明确保留）

- **Phase 4.5-C**：微信**图片 / 文件 / 视频**真正收发（inbound 映射、outbound 附件、引用媒体还原、前端展示）
- **Phase 4.5-D**：**语音 / Silk** 编解码
- 更远：ASR、TTS、OCR、Vision、缩略图/转码/压缩、媒体预览、Browser/Agent、Live2D
- 横切：本地口令鉴权、数据导出/删除（沿用既有清单）

## 10. 完成清单

```
[x] 平台无关的 MediaStorage / MediaTransport 抽象（Core 不含 CDN/AES/encrypted_param 概念）
[x] 微信 getuploadurl 协议层（字段严格按 Phase 0 研究，未发明字段）
[x] CDN 上传（200 + x-encrypted-param；4xx 立即放弃；重试有上限）
[x] CDN 下载（状态码/长度/类型/上限/超时/中止/错误标准化；失败不返回半截数据）
[x] AES-128-ECB + PKCS#7（严格密钥校验、非法 padding 显式拒绝）
[x] encryptedSize 与填充长度一致（边界全测）
[x] 密钥统一二进制处理 + 协议编码（hex / base64-of-hex）
[x] 大小上限复用统一常量（maxMediaBytes = 25 MiB）
[x] 重试复用 Phase 4 backoff + jitter（无第二套实现）
[x] 错误分类复用既有 WeixinTransportError
[x] 敏感信息不进日志/消息/快照/API（含源码级与运行时断言）
[x] ARCH-1..8 全通过；删除 channels/weixin 后仍可 typecheck/build/test
[x] pnpm test / typecheck / build / guard 实跑通过
[x] smoke:phase4 无回归；smoke:phase45b 二进制完全一致
```

---

**Phase 4.5-B 完成。**
停止。
不要进入 Phase 4.5-C / 4.5-D / Phase 5。

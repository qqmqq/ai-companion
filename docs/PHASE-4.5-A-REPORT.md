# Phase 4.5-A 开发报告：统一媒体数据模型

> 状态：**已完成**。只做"通用媒体抽象与数据模型"，未实现任何媒体传输/编解码/理解能力，未修改 `channels/weixin` 的协议实现，未进入 Phase 4.5-B。

## 0. 先看现状再动手（避免重复建模）

动手前先核查了既有结构：

| 既有资产 | 结论 |
| --- | --- |
| `core/model/message.ts` 的 `MessagePart` | Phase 1 已有 6 个变体：text / image / audio / video / file / quote，但媒体字段是**扁平的 `fileId`+`mime`**，缺 filename/size/status/origin，也没有引用与数据分离 |
| `OutboundPart` | 同样的扁平结构，且缺 video |
| `messages.content_json` | 已经是 **JSON 列**（结构化 parts），不需要新建 `message_parts` 表 |
| `ChannelAdapter` / `InternalMessage` / `InternalResponse` | 已经是 `parts: ...[]` 多部件模型，**无需改动接口形态** |
| 媒体变体的实际使用情况 | 全仓库只有 text / quote 被真正构造（微信 Phase 4 只做文字）→ **现在改模型代价最小** |
| `partsToText` | 已存在且媒体只输出占位符，方向正确，予以复用而不是另造 |

因此本阶段的选择是：**扩展现有模型**（不是新建平行模型），**不做数据库迁移**（方案 A：JSON 已足够）。

## 1. 新增文件

| 文件 | 作用 |
| --- | --- |
| `backend/src/core/model/media.ts` | 通用媒体模型：`MediaReference`、`MediaKind`、`MediaStatus`、`MediaOrigin`、`MediaUrl`、字段上限常量、净化/截断函数、`describeMedia`、`isExternalMedia` |
| `backend/test/unit/media-model.test.ts` | 媒体模型测试（13 项，覆盖第 6 节全部要求） |
| `frontend/src/lib/parts.ts` | 媒体占位符渲染辅助（未知类型安全降级为"[未知内容]"） |

## 2. 修改文件与原因

| 文件 | 原因 |
| --- | --- |
| `backend/src/core/model/message.ts` | 把 `MessagePart` 从扁平媒体字段升级为"引用 + 元数据"模型；新增 `TextPart/QuotePart/ImagePart/AudioPart/VideoPart/FilePart` 具名类型与 `normalizeMessageParts` 兼容层；`OutboundPart` 与之对齐（并补上 video） |
| `backend/src/storage/repositories/messages.ts` | 在**读取边界**规范化 parts（老行兼容），写入前也规范化，保证 Core 只见到当前模型 |
| `backend/src/core/services/messaging-pipeline.ts` | 出站映射改为复用同一套媒体模型（`toOutboundParts`）：媒体不再被替换成一句"[不支持的内容类型]"文本，而是以数据形式交给渠道，由渠道能力决定能否发送 |
| `backend/src/channels/web/channel.ts` | Web 渠道对媒体部件从"静默丢弃"改为显式 debug 日志（本阶段不实现 Web 媒体渲染，但不装作没发生） |
| `frontend/src/lib/types.ts` | 与 Core 对齐的 `MediaReferenceDto` / `MessagePartDto`，`MessageDto` 增加可选 `parts` |
| `frontend/src/pages/chat.tsx` | 消息下方显示媒体占位符（[图片]/[语音]/[视频]/[文件：x.pdf]），**未实现上传下载** |

**未修改**（刻意）：`channels/weixin/**`（协议实现）、memory / relationship / emotion / scheduler / proactive / model-router / provider、数据库迁移。

## 3. MessagePart 最终结构

```ts
// backend/src/core/model/message.ts
export interface TextPart { kind: "text"; text: string }
export interface QuotePart { kind: "quote"; ref: MessageReference }

export interface ImagePart { kind: "image"; media: MediaReference; caption?: string }
export interface AudioPart { kind: "audio"; media: MediaReference; transcript?: string; caption?: string }
export interface VideoPart { kind: "video"; media: MediaReference; caption?: string }
export interface FilePart  { kind: "file";  media: MediaReference; caption?: string }

export type MediaMessagePart = ImagePart | AudioPart | VideoPart | FilePart;
export type MessagePart = TextPart | QuotePart | MediaMessagePart;

export interface MessageReference {
  providerMessageId: string;
  text: string | null;
  status: "inline" | "resolved" | "unresolved" | "expired";
  mediaFileId: string | null;   // 被引用消息的媒体引用
}

export type OutboundPart =
  | { kind: "text"; text: string }
  | { kind: "image"; media: MediaReference; caption?: string }
  | { kind: "audio"; media: MediaReference; caption?: string }
  | { kind: "video"; media: MediaReference; caption?: string }
  | { kind: "file";  media: MediaReference; caption?: string }
  | { kind: "typing"; state: "start" | "stop" };
```

```ts
// backend/src/core/model/media.ts —— 媒体引用（只有引用与元数据，没有二进制）
export type MediaKind = "image" | "audio" | "video" | "file";
export type MediaStatus = "pending" | "available" | "failed" | "expired";
export type MediaOrigin = "channel" | "generated" | "external";

export interface MediaUrl {
  kind: "internal" | "external";   // 明确区分内部存储地址与外部地址
  value: string;
}

export interface MediaReference {
  mediaId: string | null;      // 指向未来的 MediaStorage；Phase 4.5-B 之前可能为 null
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  origin: MediaOrigin;
  status: MediaStatus;
  url: MediaUrl | null;
}

export const MEDIA_LIMITS = {
  maxMediaIdLength: 120,
  maxMimeTypeLength: 120,
  maxFilenameLength: 200,
  maxUrlLength: 2000,
  maxPartsPerMessage: 32,
  maxTextPartLength: 20_000,
} as const;
```

**与需求示例的两处有意偏离（并说明理由）**

1. 判别字段沿用项目既有的 `kind`，而不是示例里的 `type`。Phase 1–4 全仓库（含前端、测试、渠道）都用 `kind`；改名只会制造大范围重命名，不带来任何模型收益。
2. 媒体字段收进嵌套的 `media: MediaReference`，而不是平铺在 part 上。这正是需求 §六 要求的"引用与实际媒体数据分离"，也让"元数据净化"只有一个入口。

## 4. 数据库变化

**无迁移。** 采用需求中的**方案 A**：

- `messages.content_json` 本就是结构化 JSON 列，直接保存 `MessagePart[]`；
- 没有为媒体新建 `media` / `message_parts` 表 —— 当前没有任何"需要按媒体维度查询/关联"的需求，提前建表就是过度设计；
- 二进制永不进 `messages`：消息里只有 `mediaId` 与元数据，实际文件将来由 MediaStorage 管理（Phase 4.5-B）。

数据库可表达的能力（已验证）：Text / Image / Audio / Video / File 五种部件混合存储，且旧文字消息完全不受影响。

## 5. 兼容策略

三层保证，任何一层单独都能让旧数据继续工作：

1. **读取边界规范化**：`messages` 仓储读 `content_json` 时调用 `normalizeMessageParts`，老结构在进入 Core 之前就被升级。
2. **旧扁平媒体片段升级**：`{kind:"image", fileId, mime, name, size, width, height, durationMs}` → `{kind:"image", media:{mediaId, mimeType, filename, sizeBytes, ...}}`（有专门测试）。
3. **写入前规范化**：insert（含流式更新、编辑）都过一遍规范化，库里不会再产生旧结构。

另外：
- **旧文字消息**：`[{kind:"text", text}]` 结构未变，读取与 `textRender` 完全一致（有直接写旧行再读回的测试）。
- **未知类型**：`kind:"unknown"` 之类 → 丢弃该片段并记录 `rejected: unknown_kind`，**其余片段与整条消息照常存活**，绝不抛异常、绝不让未知类型破坏消息系统。
- **空消息** `[]`：合法，`textRender` 为空串，`inferMessageType` 返回 `system`。
- **无迁移的启动安全**：因为不改 schema，Phase 1–4 的数据库可直接启动；测试套件中的历史行测试覆盖了这一点。

## 6. 测试结果（实际运行）

新增 `test/unit/media-model.test.ts`（13 项）：

```text
✔ every part kind round-trips through normalization
✔ a mixed message keeps order and survives a database round-trip      ← [Text, Image, Text, File] 序与字段
✔ empty and structurally invalid inputs degrade safely instead of throwing
✔ unknown part kinds are rejected but the rest of the message survives
✔ legacy flat media parts are upgraded to the unified model
✔ a legacy text-only row in the database still reads correctly
✔ MIME handling accepts real types and rejects junk                    ← png/jpeg/wav/mp4/pdf + 非法
✔ oversized fields are clamped and never enter Core unbounded          ← filename/mime/url/text/parts 数
✔ filenames never carry path components and control characters are stripped
✔ media urls are labelled by origin and never treated as instructions
✔ context text representation uses placeholders only, never object dumps
✔ outbound mapping forwards media as data instead of a placeholder string
✔ the media model itself never performs network access                 ← 源码级断言：无 fetch/http
```

全量验证（真实输出）：

```text
pnpm test       → tests 182 / pass 182 / fail 0     (Phase 4 为 169，本阶段 +13)
pnpm typecheck  → 后端 + 前端 全通过
pnpm build      → 前端构建成功（291.89 kB / gzip 91.88 kB）
pnpm guard      → ARCH-1..8 全部通过
```

回归验证：Phase 4 冒烟 `smoke:phase4` 重跑通过（微信登录 → 收消息 → 回复 → 主动消息 → `-14` 停止轮询，输出与 Phase 4 一致）。

**架构守卫**：ARCH-1..8 全绿；ARCH-7 依然执行真实操作（复制 src → 物理删除 `channels/weixin` → 真实 `tsc`），证明媒体模型没有把 Core 与微信绑在一起。

## 7. 安全相关的落地

| 要求 | 落地方式 |
| --- | --- |
| 二进制/Base64 不进日志与快照 | 模型里**根本没有**存放二进制的字段；`partsToText` 只输出占位符 |
| 不 stringify 元数据进上下文 | 有测试断言输出中不含 `[object`、`mediaId`、内部 id |
| 任意 URL 不自动请求 | 模型纯数据、无网络调用（源码级断言无 `fetch(`、无 http 客户端依赖）；`MediaUrl.kind` 显式标注 internal/external |
| 超大字段 | 全部字段有上限并截断；单条消息 parts 上限 32；文本片段上限 20k（并记录 `text_truncated`） |
| 文件名路径穿越 | 只保留 basename，且剥离控制字符（`../../etc/passwd` → `passwd`） |
| token / API Key 泄漏 | 媒体模型里没有任何凭据字段；渠道凭据仍在 Phase 1 的 CredentialStore 中 |

## 8. 已知问题

| # | 问题 | 影响 | 计划 |
| --- | --- | --- | --- |
| A-1 | `mediaId` 目前只是占位引用，没有 MediaStorage 实现 | 媒体无法真正落盘/读取 | Phase 4.5-B |
| A-2 | `status` 字段已定义但还没有任何流程会推进它 | 现阶段语义固定为 `pending`/`available` | Phase 4.5-B |
| A-3 | Web 端只显示占位符，不能渲染/播放媒体 | 用户看不到内容 | 后续阶段 |
| A-4 | 出站媒体部件会被渠道拒绝（微信只支持文字） | 角色发媒体会得到 `channel_unavailable` | Phase 4.5-B |
| A-5 | `MessageReference.mediaFileId` 仍是旧命名（语义是 mediaId） | 命名不一致 | 后续统一（会改动微信引用映射，本阶段刻意不动） |
| A-6 | 未做 MIME 白名单（只做格式合法性校验） | 任意合法 MIME 都能进来 | 需要时在渠道/工具层加白名单 |
| A-7 | 没有媒体大小/配额策略（只有元数据字段） | 无法阻止超大媒体进入存储 | Phase 4.5-B 与 MediaStorage 一起做 |

## 9. 未完成事项（本阶段明确不做）

- 微信 CDN、AES-128-ECB、PKCS#7、`getuploadurl`、加密上传/下载
- Silk 编解码（语音转码）
- 实际媒体上传/下载（微信、Web 都一样）
- 图片压缩、视频转码、缩略图、媒体预览
- ASR（语音转文字）、TTS（文字转语音）
- OCR、图片理解、视频理解、文件解析、视觉模型
- Browser 工具、Agent、Live2D
- 微信媒体 API 与 `channels/weixin` 的协议改动

---

**Phase 4.5-A 完成。**
停止。
不要进入 Phase 4.5-B / 4.5-C / 4.5-D / Phase 5。

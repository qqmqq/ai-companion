# Phase 1 开发报告

> 状态：**已完成**。遵循 `docs/AI-COMPANION-ARCHITECTURE-REPORT.md`，未重新设计核心架构。
> 交付物：可运行的 TypeScript/Node 22 + Fastify + SQLite(WAL) 骨架，含 Channel 抽象、Web 渠道、Core 骨架、角色卡导入、凭据加密、测试体系与架构硬守卫。

## 1. 修改了哪些文件

Phase 1 之前仓库中只有 `docs/AI-COMPANION-ARCHITECTURE-REPORT.md`。除该文件外，本轮**没有修改任何既有文件**，全部为新增。

唯一被"改写"的是 Phase 1 过程中自己写的初稿（见第 4 节"过程中的架构修正"）：`src/security/redact.ts`、`src/channels/web/channel.ts`、`src/app/bootstrap.ts`、`src/api/routes/{characters,conversations}.ts`、`src/storage/repositories/*`、`src/core/model/channel.ts`。

## 2. 新增了哪些文件 / 每个文件的作用

### 根目录（6）
| 文件 | 作用 |
| --- | --- |
| `package.json` | pnpm workspace 根脚本：dev / typecheck / test / build / guard |
| `pnpm-workspace.yaml` | 工作区成员：backend、frontend |
| `tsconfig.base.json` | 共享编译选项（strict、erasableSyntaxOnly、allowImportingTsExtensions） |
| `.env.example` | 全部环境变量示例（host/port/data dir/key provider/log level） |
| `LICENSE` / `NOTICE` | 本项目 MIT；第三方声明（明确只参考 Tencent/openclaw-weixin 的公开协议，未复制代码、无 OpenClaw 依赖） |
| `README.md` | 快速开始、验证命令、架构守卫说明、目录、Phase 1 范围 |
| `.gitignore` | 忽略 node_modules/dist/data/.guard-*/.env |
| `scripts/dev.ts` | 一键同时起后端与前端 |

### backend/src/app（组合根，6）
| 文件 | 作用 |
| --- | --- |
| `config.ts` | 环境变量解析 + zod 校验；派生 dataDir / databasePath / keyProvider / logLevel；env 模式缺 key 直接启动失败 |
| `logger.ts` | 结构化 JSON 行日志，**在 logger 内部强制脱敏**（不依赖调用点自觉） |
| `events.ts` | 进程内领域事件总线（订阅/发布，单订阅者异常不影响他人） |
| `bootstrap.ts` | **唯一装配点**：DB→迁移→仓储→密钥→凭据→Provider→Core 服务→渠道→管线；导出 Container |
| `http-server.ts` | Fastify 实例、统一错误映射、路由注册、自带 logger 关闭（走我们的脱敏 logger） |
| `main.ts` | 启动、监听、SIGINT/SIGTERM 优雅停机 |

### backend/src/api（6）
| 文件 | 作用 |
| --- | --- |
| `validation.ts` | 统一的 zod 校验器（`z.output` 推断，失败转 400 + issue 列表） |
| `errors.ts` | 领域错误 → HTTP 状态与统一错误体 |
| `dto/mappers.ts` | 领域对象 → DTO（**永不含凭据字段**） |
| `routes/health.ts` | /api/system/health、/api/system/info |
| `routes/characters.ts` | 角色 CRUD、角色卡导入、版本列表、运行时状态读写 |
| `routes/conversations.ts` | 会话 CRUD、消息列表、发消息（走渠道→Core 管线）、归档 |
| `routes/messages.ts` | 编辑、重新生成、删除 |
| `routes/channels.ts` | 渠道能力与健康 |
| `routes/events.ts` | SSE 事件流（含心跳与断连清理） |

### backend/src/core（Core，15）
- `model/`：`ids`、`errors`（DomainError + 状态码映射）、`character`（定义/运行时状态/角色书）、`conversation`、`message`（统一 parts、引用、InternalMessage/InternalResponse）、`channel`（**ChannelKind 是不透明字符串**）、`user`
- `ports/`：`channel`（ChannelAdapter）、`channel-registry`、`llm-provider`、`credential-store`、`events`、`logger`、`clock`、`repositories`（**仓储端口全部搬进 Core**）
- `services/`：`character-service`（创建/导入/改卡即新版本/状态更新）、`conversation-service`（会话、消息、回复生成、重生成、编辑）、`messaging-pipeline`（入站统一管线：归属会话→持久化→生成→经原渠道回发）、`character-card/tavern`（V1/V2 解析）、`character-card/png`（PNG tEXt/iTXt chara 提取）

### backend/src/channels（渠道层，3）
- `manager.ts`：ChannelManager，注册/启停/健康/入站处理器分发，**按 kind 查找未知渠道返回 undefined 而非抛错**
- `web/channel.ts`：WebChannel 实现 ChannelAdapter；自己声明 `WEB_CHANNEL_KIND`；`deliverInbound` 把浏览器消息送入 Core 统一入口
- `web/sse-hub.ts`：SSE 客户端管理与广播，失败客户端自动剔除

### backend/src/providers（1）
- `llm/echo-provider.ts`：离线占位 Provider，使整条链路在无 API Key、无网络时可跑通与可测试（回复中明确标注是占位实现）

### backend/src/security（4）
- `crypto.ts`：AES-256-GCM 封装、密钥解析（hex/base64）、定长比较
- `key-provider.ts`：KeyProvider 抽象（file 0600 / env / 内存），`defaultKeyPath`
- `credential-store.ts`：SQLite 凭据存储实现 CredentialStore（只落密文；对外只暴露 accountId/updatedAt）
- `redact.ts` / `untrusted.ts`：脱敏（键名 + 内联文本双层）、不可信内容包装（工具/网页内容预处理）

### backend/src/storage（11）
- `db.ts`：DatabaseSync 打开、WAL、busy_timeout、foreign_keys、事务助手、安全 JSON 解析
- `migrations.ts`：前向迁移执行器（独立事务、失败回滚中止、schema_migrations 记录）
- `migrations/001_init.sql`：Phase 1 schema（详见第 3 节）
- `repositories/`：8 个仓储实现（users/characters/conversations/messages/channels/credentials/settings/audit），实现 Core 的仓储端口

### backend/src/util（2）
- `ids.ts`：UUIDv7（时间有序，适合做主键）+ 随机令牌
- `time.ts`：ISO 时间助手

### backend/test（16）
- `unit/`：toolchain、ids、crypto、redact、untrusted、logger、migrations、repositories、character-card、credential-store、web-channel（含 SSE hub 与 ChannelManager）
- `integration/`：api（健康/导入/改卡不丢状态/聊天/编辑重生成删除/错误形状/渠道）、sse（真实 HTTP + fetch 流式读取，端到端验证事件投递）
- `arch/`：architecture（ARCH-1..6、8）、deletion-guard（ARCH-7）
- `helpers/`：db、container、files
- `fixtures/`：character-v1.json、character-v2.json

### frontend（8）
React 19 + Vite 6：`main.tsx`、`app.tsx`（角色页：粘贴角色卡导入 + 角色列表；聊天页：会话列表 + 消息 + 发送；SSE 订阅自动刷新）、`lib/api.ts`（类型化客户端 + EventSource 封装）、`lib/types.ts`、`styles.css`、`vite.config.ts`（/api 代理到 8787）、`index.html`、`tsconfig.json`。

## 3. 数据库结构（Phase 1 子集）

存储：SQLite，WAL + synchronous=NORMAL + busy_timeout=5000 + foreign_keys=ON。id 全部 UUIDv7 文本；微信等渠道的 uint64 一律文本。

| 表 | 关键列 | 索引 |
| --- | --- | --- |
| `schema_migrations` | id PK, applied_at | — |
| `users` | id PK, display_name, locale, timezone, created_at | — |
| `characters` | id PK, user_id FK→users, name, slug, avatar_media_id, current_version_id, created_at, updated_at | UNIQUE(user_id, slug) |
| `character_versions` | id PK, character_id FK, spec_version, definition_json, imported_from, created_at | (character_id, created_at) |
| `character_states` | character_id PK FK, user_id, state_json, updated_at | — |
| `conversations` | id PK, user_id FK, character_id FK, channel, account_id, conversation_ref, title, parent_conversation_id, status, created_at, last_message_at | UNIQUE(channel, conversation_ref, character_id)；(user_id, character_id, last_message_at DESC) |
| `messages` | id PK, conversation_id FK, role, content_json(parts), text_render, reply_to_id, provider_message_id, token_count, created_at, edited_at, branch_of_id | (conversation_id, created_at)；(provider_message_id) |
| `channels` | kind PK, enabled, config_json | — |
| `channel_accounts` | id PK, channel_kind FK, external_account_id, display_name, status, bound_user_id, last_seen_at, created_at | UNIQUE(channel_kind, external_account_id) |
| `channel_cursors` | (account_id, conversation_ref) PK, cursor, pending_cursor, committed_at | — （**为 Phase 4 的两阶段游标预留**） |
| `credentials` | account_id PK, ciphertext, nonce, tag, key_ref, updated_at | — （只存密文） |
| `settings` | key PK, value_json, updated_at | — |
| `audit_log` | id PK, actor, action, target_type, target_id, detail_json, created_at | (created_at DESC) |

设计要点：
1. **定义与运行时分离**：`character_versions.definition_json` 是角色卡快照；`character_states` 是运行时状态。改卡 = 新增版本 + 切 current_version_id，状态表完全不动（有测试断言）。
2. **凭据只存密文**：`credentials` 四列 (ciphertext, nonce, tag, key_ref)，AES-256-GCM；有测试断言数据库行里不出现明文 canary。
3. 记忆/关系/情绪/事件/任务/调度等表**故意不建**，留到 Phase 2/3 增量迁移，避免投机性建模。

## 4. Channel 接口

```ts
interface ChannelAdapter {
  readonly kind: ChannelKind;              // 不透明字符串
  readonly capabilities: ChannelCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelHealth>;
  listAccounts(): Promise<ChannelAccountInfo[]>;
  removeAccount(accountId: string): Promise<void>;
  onInbound(handler: InboundHandler): void;             // 推模式，渠道内部自决 long-poll/WS
  send(response: InternalResponse): Promise<SendReceipt>;
}
```

相对 Phase 0 报告的落地方式：
- 统一 `send(InternalResponse{ parts })` 而不是 `send_image/send_audio/...`；能力由 `capabilities` 声明（Web 渠道在 Phase 1 明确声明 `media.image=false`，不宣称未实现的能力）。
- `InternalResponse.idempotencyKey` 已落地（Phase 4 对应微信 `client_id`）。
- `ChannelRegistry` 让 Core 按 kind 找渠道；未知 kind 返回 `undefined`，管线记 warning 但不崩。
- **入站只有一条路**：HTTP 路由 → `WebChannel.deliverInbound` → `onInbound` → `messaging-pipeline` →（生成回复）→ `ChannelAdapter.send`。路由不直接调 Core 服务。

## 5. Core 结构

```text
core/model   领域数据：InternalMessage/InternalResponse/MessagePart、Character(定义|状态)、Conversation、DomainError
core/ports   ChannelAdapter / ChannelRegistry / LLMProvider / CredentialStore / DomainEventPublisher / Logger / Clock / 仓储端口
core/services CharacterService(导入·版本·状态) · ConversationService(会话·消息·生成·重生成) · MessagingPipeline(入站统一管线)
```

依赖方向（由架构守卫机械保证）：
```text
api/channels/providers/storage/security  →  core/ports  ←  实现
                                    ↑
                          app/bootstrap 装配一切
core  →  只依赖 core/ 与纯 util/
```

Phase 1 的上下文策略是**明确的最小实现**（角色定义 + 最近 30 条历史），并在代码注释里标注 `ContextEngine 在 Phase 2 取代它`——不做假装的 RAG。

## 6. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/system/health | 状态、DB、渠道健康、SSE 客户端数、Provider 列表 |
| GET | /api/system/info | 渠道能力与 Provider |
| GET | /api/characters | 角色列表（含定义与运行时状态） |
| POST | /api/characters | 用内联定义创建角色 |
| POST | /api/characters/import | 导入角色卡（content 文本 或 base64；JSON 或 PNG） |
| GET/PATCH/DELETE | /api/characters/:id | 详情 / 改卡（生成新版本）/ 删除 |
| GET | /api/characters/:id/versions | 版本历史 |
| GET/PATCH | /api/characters/:id/state | 运行时状态（energy/autonomy/plan/location/activity） |
| GET/POST | /api/conversations | 列表 / 创建 |
| GET | /api/conversations/:id | 详情 |
| GET/POST | /api/conversations/:id/messages | 历史 / 发消息（经渠道管线，返回本轮新增消息） |
| POST | /api/conversations/:id/archive | 归档 |
| PATCH/DELETE | /api/messages/:id | 编辑 / 删除 |
| POST | /api/messages/:id/regenerate | 重新生成（记录 branchOfId） |
| GET | /api/channels | 渠道能力 + 健康 |
| GET | /api/channels/:kind/accounts | 渠道账号（Phase 1 仅 Web 本地账号） |
| GET | /api/events/stream | SSE：message.new / message.delta / conversation.updated / character.created / channel.status |

错误统一为 `{ error: { code, message, details } }`（code ∈ not_found/invalid_input/conflict/unauthorized/channel_unavailable/provider_error/internal）。

## 7. 测试结果

`pnpm test`（Node 22+ 内置 `node:test`，零测试框架依赖）：

```text
ℹ tests 57
ℹ pass  57
ℹ fail   0
ℹ duration_ms ~5.0s
```

覆盖：
- 单元：UUIDv7 时间有序、AES-256-GCM 往返/篡改拒绝/错钥拒绝、脱敏（键名 + 内联 + URL）、不可信包装、logger 级别与强制脱敏、迁移幂等与表结构、仓储往返与约束、角色卡 V1/V2/PNG 解析、凭据存储（含明文 canary 断言）、Web 渠道与 SSE hub 与 ChannelManager。
- 集成（`app.inject`）：健康、角色导入→列表→详情、改卡生成新版本且不重置状态、完整聊天链路（用户消息 + 角色回复均落库）、消息编辑/重生成/删除、统一错误形状、渠道端点。
- 端到端 SSE：真实 `listen` + `fetch` 流式读取，确认首包 `: connected`、发消息后收到领域事件、hub 客户端数 > 0。

## 8. 架构硬守卫测试结果

`pnpm guard`：

```text
✔ ARCH-1 Core 源码不含任何具体平台字样
✔ ARCH-2 Core 只依赖 core/ 与纯 util/，不 import 任何基础设施实现
✔ ARCH-3 只有组合根 bootstrap.ts 可以依赖具体渠道实现
✔ ARCH-4 channels/ 之外不得出现渠道专有标识（以 weixin 为例）
✔ ARCH-5 依赖清单中不得出现 openclaw 或任何渠道 SDK
✔ ARCH-6 Core 不依赖任何运行时依赖（零外部包）
✔ ARCH-7 删除 channels/weixin 后整个 src 仍能通过类型检查（构建不破）
✔ ARCH-8 渠道目录只包含已注册的渠道（新渠道必须显式注册）
ℹ pass 8 / fail 0
```

**ARCH-7 的实现方式（重点）**：不是"字符串扫描"，而是把 `src` 完整复制到临时目录、物理 `rm -rf src/channels/weixin`（当前不存在则为 no-op），再用等价的 tsconfig 对副本执行**真实 tsc 类型检查**，退出码必须为 0。Phase 4 加入微信渠道后，这个测试会自动变成"删除微信渠道 → 构建仍通过"的真实验证。

为通过 ARCH-1/ARCH-2/ARCH-6，Phase 1 过程中做了两处**架构修正**（详见第 10 节）。

## 9. 如何启动 / 如何验证

启动：
```bash
pnpm install
cp .env.example .env        # 可选
pnpm dev                    # 后端 :8787，前端 :5173
```
打开 http://127.0.0.1:5173 → 「角色」页粘贴 Tavern 角色卡 JSON → 导入 → 「开始聊天」→ 发消息。
（未配置真实模型时由 echo 占位 Provider 回复，链路完整可跑。）

验证：
```bash
pnpm typecheck              # 后端 + 前端
pnpm test                   # 57 项
pnpm guard                  # 8 项架构守卫
pnpm build                  # 前端产物构建 + 后端类型检查
curl http://127.0.0.1:8787/api/system/health
```

已实测的冒烟结果（真实进程 + 真实 HTTP）：
```text
HEALTH: status=ok db=ok channels=web
CHARACTER: Aria slug=aria emotion=neutral
CONVERSATION: 01a08c5d-... channel=web
REPLY-COUNT: 2
  [user] 今天有点累，陪我说说话
  [character] （echo）我收到了：今天有点累，陪我说说话
HISTORY: 2 messages persisted
DATA: backend/data/smoke2/companion.db(+WAL)  keys/master.key 44B
```

## 10. 过程中的架构修正（记录在案）

1. **脱敏漏洞（真实缺陷）**：单元测试发现嵌套字符串值里的 `token=...` 会绕过键名匹配进入日志。修在共享层 `redactValue`：所有字符串值统一过内联清洗，而不是在调用点补。
2. **SSE 双投递风险**：初版 Web 渠道既直接写 hub、又发布领域事件（bootstrap 还会把事件转发到 hub）→ 同一事件可能投递两次。已重构为**单一投递路径**：渠道只发布领域事件，应用层订阅后统一转发到 hub。测试同步改为按 bootstrap 的接线方式断言。
3. **Core 分层违规**：初版 Core 服务直接 import `storage/repositories/*`。按报告"core 只能依赖 core/ports"的要求，把 8 个仓储**端口搬进 `core/ports/repositories.ts`**，storage 侧改为实现端口。
4. **类型耦合**：初版 `ChannelKind` 是 `"web" | "weixin" | ...` 字面量联合，等于让 Core 认识平台。已改为不透明 `string`，由各渠道自declare自己的 kind（`WEB_CHANNEL_KIND`）——这才是 ARCH-1 能成立的前提。

## 11. 当前已知问题

| # | 问题 | 影响 | 计划 |
| --- | --- | --- | --- |
| K1 | 只有 echo Provider；未接入真实 LLM，无流式落库 | 无法真正对话 | Phase 2（OpenAI 兼容 / Ollama + ModelRouter） |
| K2 | 上下文 = 角色定义 + 最近 30 条消息 | 长期记忆未生效 | Phase 2（ContextEngine + Memory） |
| K3 | `regenerate` 生成新消息并记 branchOfId，但不替换原消息 | UI 需自行处理分支展示 | Phase 2（会话树与分支视图） |
| K4 | 无鉴权：仅监听 127.0.0.1，任意本机 HTTP 客户端可访问 | 本机多人环境有风险 | Phase 2（首次启动设口令 + 会话 Cookie） |
| K5 | 主密钥只支持 file/env，未接 OS keyring | 部署便利性一般 | Phase 2/4 |
| K6 | 媒体（图片/语音）未实现：Web 与渠道都声明不支持 | 无法收发媒体 | Phase 4 / 4.5 |
| K7 | 无备份/导出/删除数据 API | 数据可移植性缺失 | Phase 2 |
| K8 | 前端只有两个页面，无 PWA、无移动端优化 | 体验粗糙 | Phase 2+ |
| K9 | 没有 e2e（Playwright）浏览器测试，SSE 用 fetch 流验证 | 前端交互回归无自动覆盖 | Phase 2 |
| K10 | `/api/conversations/:id/messages` 返回最后 3 条而不是本轮两条 | 语义略糙 | Phase 2 改为按 idempotency/批次返回 |
| K11 | 未做 prompt 注入防护的**实际调用**（`wrapUntrusted` 已实现但无调用方） | 目前无外部内容入口，风险未激活 | Phase 5（Browser/Tool 接入时必须先接线） |
| K12 | 迁移只有前向；无 down 脚本 | 回滚需手工 | Phase 2 |

## 12. Phase 2 准备事项

1. **迁移 002**：`memories` / `memory_links` / `conversation_summaries` / `context_snapshots` / `model_usage` / `model_providers`（列定义见报告 §22）。
2. **Provider 实现**：OpenAI 兼容 + Ollama，统一走 `LLMProvider`；流式必须落库（配合 K1/K10）。
3. **ModelRouter**：按 taskType 分档（chat / memory_extract / summarize）+ 用量记录 + 预算上限；越早越好，否则记忆抽取一上线成本就失控。
4. **ContextEngine**：预算分配、优先级、压缩、去重，并写 `context_snapshots` 审计（这是排查"角色失忆"的唯一手段）。
5. **Memory**：抽取（结构化输出 + 校验）、去重合并、重要性打分、检索（先用 SQLite FTS5，向量化留接口）。
6. **安全补 K4/K7**：本地口令 + 会话 Cookie、数据导出/删除。
7. **前端**：上下文预览页（展示本轮用了哪些记忆）、记忆管理页、Provider 设置页。
8. **测试**：Playwright e2e 接入 CI；记忆召回黄金用例（200 轮后仍能召回早期事实）。

---

**Phase 1 结束。** 按约定停止，等待确认后再进入 Phase 2。

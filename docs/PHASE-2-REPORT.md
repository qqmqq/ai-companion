# Phase 2 开发报告

> 状态：**已完成**。遵循 `docs/AI-COMPANION-ARCHITECTURE-REPORT.md`（§8/§9/§17/§18/§30）与 `docs/PHASE-1-REPORT.md`，未重新设计既有架构，未引入 OpenClaw，未提前实现微信渠道。
> 目标链路已真实跑通：**用户消息 → Conversation → Memory Retrieval → ContextEngine → ModelRouter → LLM Provider → Assistant Response → 落库 → Memory Extraction**。

## 1. 修改/新增文件列表

### 新增（backend/src）
| 文件 | 作用 |
| --- | --- |
| `core/model/task.ts` | TaskType / TaskTier：模型选择的唯一判据 |
| `core/model/provider-error.ts` | ProviderError：所有上游错误归一化（timeout/401/403/429/5xx/network/invalid_response/model_unavailable/aborted） |
| `core/model/memory.ts` | Memory / MemoryCandidate / MemoryLink / MemoryQuery / MemoryHit |
| `core/model/context.ts` | ContextSection / ContextBundle / ContextSnapshotRecord |
| `core/model/usage.ts` | ModelUsageRecord / ProviderConfig / ModelRoute |
| `core/ports/task-llm.ts` | TaskLLM：Core 调用模型的唯一入口 |
| `core/ports/model-router.ts` | ModelRouter 端口 |
| `core/ports/model-config.ts` | ModelConfigStore 端口（provider 清单 + 任务路由） |
| `core/ports/memory-retriever.ts` | MemoryRetriever 端口（FTS5 实现 / 未来向量实现） |
| `core/ports/repositories.phase2.ts` | Memory / Summary / Snapshot / Usage / ProviderConfig 仓储端口 |
| `core/ports/runs.ts` | RunRegistry 端口（流式任务登记与中止） |
| `core/memory/extractor.ts` | 抽取提示词、JSON 容错解析、校验、寒暄预筛（纯函数） |
| `core/memory/memory-service.ts` | 抽取闸门、合并/强化、检索编排、衰减、增删改 |
| `core/memory/scoring.ts` | 记忆打分与半衰期策略（fts 名次 + 重要度 + 新鲜度 + 强化） |
| `core/context/tokens.ts` | token 估算（CJK 与拉丁分口径） |
| `core/context/context-engine.ts` | 上下文装配：优先级、预算、去重、呈现顺序、快照落库 |
| `core/services/summary-service.ts` | 摘要规划与生成（保存摘要，永不删原文） |
| `providers/http.ts` | 统一 HTTP：超时、外部中止、网络错误、状态码 → ProviderError |
| `providers/llm/openai-compatible.ts` | OpenAI 兼容 Provider（chat / SSE 流式 / usage / 错误） |
| `providers/llm/ollama.ts` | Ollama Provider（NDJSON 流式 / usage / 可配置 base URL） |
| `providers/llm/registry.ts` | 可变 Provider 注册表（按数据库配置构造，密钥来自 CredentialStore） |
| `providers/model-router.ts` | 任务 → provider/model 决策（显式路由 → 档位 → 兜底，带 reason） |
| `providers/task-llm.ts` | 路由 + 计时 + 用量记账 + 错误归一化 + 运行中任务登记 |
| `storage/migrations/002_memory_context_usage.sql` | migration 002（见第 3 节） |
| `storage/repositories/memories.ts` | 记忆仓储 + FTS 维护 + 链接 + 保护类记忆 |
| `storage/repositories/summaries.ts` | 会话摘要仓储 |
| `storage/repositories/context-snapshots.ts` | 上下文快照仓储 |
| `storage/repositories/model-usage.ts` | 用量仓储 + 按任务聚合 |
| `storage/repositories/model-config.ts` | provider 配置 + 任务路由仓储 |
| `storage/search/cjk.ts` | 中文逐字切分 + FTS 查询构造 |
| `storage/search/fts-memory-retriever.ts` | FTS5 检索器（名次归一化 → 打分 → 排序） |
| `api/routes/providers.ts` | provider CRUD / 凭据写入（只进不出）/ 连通性测试 / 路由 / 用量 |
| `api/routes/memories.ts` | 记忆列表 / 检索 / 详情（含来源消息）/ 重要度 / 删除 / 衰减 |
| `api/routes/context.ts` | 上下文预览 / 快照查询 / 运行中任务 / 中止 |
| `scripts/phase2-smoke.ts` | 真实进程 + 真实 HTTP 冒烟脚本 |
| `test/helpers/chat-stack.ts` | 测试用对话栈（脚本化 Provider / 真实仓储 / 真实上下文引擎） |
| `test/helpers/mock-openai-server.ts` | 本地 OpenAI 兼容 mock 服务（鉴权 / 非流式 / SSE / usage） |
| `test/unit/{context-engine,conversation-streaming,summary,memory,provider-openai,provider-ollama,model-router,sqlite-features}.test.ts` | Phase 2 单元与端到端测试 |
| `test/integration/phase2-api.test.ts` | Phase 2 API 端到端（真实 HTTP provider + SSE） |

### 修改（关键项）
| 文件 | 变更 |
| --- | --- |
| `app/bootstrap.ts` | 装配 Phase 2：仓储、检索器、记忆、上下文、路由、TaskLLM、摘要、运行注册表；`createContainer` 改为 async |
| `app/http-server.ts` | 注册 Phase 2 路由；**空 JSON body 视为 `{}`**（无参数 POST 不再 500） |
| `core/model/message.ts` | Message 增加 `status`（partial/completed/failed）与 `errorText` |
| `core/ports/repositories.ts` | MessageRepository 增加 `countByRole` 与 `updateStreaming` |
| `core/ports/llm-provider.ts` | usage 允许 null；请求带 `signal`；ChatDelta 可携带 usage；**模型价格允许 null** |
| `core/services/conversation-service.ts` | 改为 ContextEngine + TaskLLM；新增 `streamReply`（单条消息 partial→completed/failed） |
| `core/services/messaging-pipeline.ts` | 抽出记忆抽取阶段（background/sync/off）；新增 `handleInboundStreaming` |
| `channels/web/channel.ts` | 新增 `deliverInboundStreaming` / `onInboundStreaming` |
| `providers/llm/{openai-compatible,ollama,echo-provider}.ts` | 流式 usage、未知价格 null、chat 路径补传中止信号 |
| `api/routes/conversations.ts` | 支持 `stream: true`（202 + runId）；新增摘要接口 |
| `frontend/**` | 拆分为 pages（characters/chat/memories/settings），新增流式显示与上下文预览 |
| `README.md` | Phase 2 使用与验证说明 |

## 2. 每个模块职责

- **providers/**（基础设施）把"用什么模型"与"怎么调用"收口：HTTP 细节、重试/超时/中止、SSE/NDJSON 解析、错误归一化，全部在 Core 之外。
- **core/ports/** 是防腐层：Core 只用 `TaskLLM`、`ModelRouter`、`MemoryRetriever`、`ModelConfigStore`、`RunRegistry` 与仓储端口。
- **core/context/** 决定"模型看到什么"：优先级（谁被丢弃）与呈现顺序（消息长什么样）分离，并落快照以供事后追查。
- **core/memory/** 决定"记住什么、何时记、怎么想起来"：闸门控成本、抽取与写库解耦、合并强化、检索打分、衰减归档。
- **core/services/** 编排业务流程：会话与消息、流式落库、摘要；`messaging-pipeline` 是渠道无关的入站统一管线。
- **channels/** 只做协议与传输，Web 渠道额外提供 SSE 出站与流式入站入口。

## 3. migration 002 数据库结构

文件：`backend/src/storage/migrations/002_memory_context_usage.sql`

**messages（ALTER）**：`status TEXT NOT NULL DEFAULT 'completed'`、`error_text TEXT`。

**memories**：id PK、scope、type、content、content_hash、importance、confidence、user_id、character_id→characters、conversation_id→conversations、source_message_id、tags_json、reinforcement、access_count、last_accessed_at、embedding_json（预留，Phase 2 为 NULL）、superseded_by、status、occurred_at、created_at、updated_at。
索引：(scope,status,character_id,user_id)、(importance DESC,updated_at DESC)、(content_hash)、(conversation_id,created_at DESC)、(source_message_id)。

**memories_fts**：FTS5 影子表（`search_text` + `memory_id UNINDEXED`，unicode61）。写入时由仓储把 content+tags 做中文逐字切分后同步，删除/更新同步维护。

**memory_links**：id、from_memory_id、relation（same_event/same_subject/causes/contradicts/supersedes/derived_from）、target_type（memory/message/character/user/conversation）、target_id、weight、created_at。索引：(from_memory_id,relation)、(target_type,target_id)。→ 未来可扩展为记忆关系网络。

**conversation_summaries**：id、conversation_id→conversations、from_message_id、to_message_id、summary、token_estimate、model、provider_id、created_at。索引：(conversation_id, created_at DESC)。

**context_snapshots**：id、conversation_id、character_id、message_id、task_type、provider_id、model、total_tokens、budget_tokens、sections_json、memory_ids_json、dropped_json、created_at。索引：(conversation_id,created_at DESC)、(message_id)。**不含任何密钥**。

**model_usage**：id、provider_id、model、task_type、conversation_id、message_id、input_tokens、output_tokens、total_tokens、estimated_cost、latency_ms、success、error_kind、created_at。token 与成本**可为 NULL**（provider 未返回就是不返回）。索引：(created_at DESC)、(task_type,created_at DESC)、(conversation_id,created_at DESC)。

**model_providers**：id PK、kind、display_name、base_url、default_model、**credential_ref（只是 CredentialStore 的引用，不含密钥）**、requires_credential、timeout_ms、enabled、created_at、updated_at。

**model_routes**：task_type PK、provider_id、model、updated_at。

## 4. Provider 架构

```text
Core ──依赖──▶ LLMProvider（端口：listModels / chat / stream）
                     ▲
        ┌────────────┴─────────────┐
 OpenAICompatibleProvider      OllamaProvider      EchoProvider(占位)
 (OpenAI / OpenRouter /        (本地 11434 可配)
  llama.cpp / vLLM / LM Studio)
```

- 统一数据结构：`ChatRequest`（含 `signal`）、`ChatResponse`（text/model/usage/finishReason）、`ChatDelta`（text/done/可选 usage）、`ModelInfo.capabilities`（tools/vision/jsonMode/streaming/contextWindow/**costPer1kInput|Output: number|null**）。
- 错误：所有 HTTP/SDK 异常经 `providers/http.ts` 转成 `ProviderError`（kind、upstreamStatus、retryable），Core 与 API 只看到这一种。
- 密钥：只从 CredentialStore 解密到内存中的 provider 实例，**任何 API 响应、日志、快照都不含明文**；无密钥的本地服务不发送 Authorization。
- 诚实性：上游未声明价格 → 成本记 NULL；上游未返回 usage → token 记 NULL；本地模型成本确为 0 才记 0。

## 5. ModelRouter 架构

```text
TaskType ──▶ ModelRouter ──▶ (providerId, model) ──▶ TaskLLM ──▶ Provider
```

解析顺序：① `model_routes` 显式路由（可指向 disabled 时告警并回退）→ ② 任务档位默认（chat=standard、memory_extraction/summarization/context_compression=cheap、reasoning/agent=advanced，其余 cheap）→ ③ 第一个可用 provider。
配置来自数据库（`model_providers` / `model_routes`），可在 UI 修改并即时生效（注册表可变，无需重启）。
业务代码**不允许**自行选择模型：全部经由 `TaskLLM.chat|stream(task, …)`。

## 6. ContextEngine 架构

装配分区与优先级（报告 §9.2）：

| 优先级 | 分区 |
| --- | --- |
| P0 | current_message（当前用户消息） |
| P1 | character_definition（角色定义，超预算时截断但绝不丢弃） |
| P2 | recent_conversation（最近 N 条，时间序） |
| P3 | runtime_state（情绪/活动/地点/能量/计划） |
| P4 | memories（检索命中，附 sourceIds） |
| P5 | conversation_summary（更早对话的压缩） |
| P6 | background（预留） |

关键设计（与 Phase 1 的差别）：
- **优先级 ≠ 呈现顺序**。优先级只决定"预算不足时谁被丢弃"；呈现顺序固定为 系统设定 → 历史对话 → 当前消息，保证 system 在最前、用户消息在最后。
- 预算：`context.budgetTokens`（默认 6000），超预算按优先级从低到高丢弃并记录 `dropped{reason: over_budget|duplicate}`。
- 去重：同 kind + 同内容前缀视为重复；当前消息与历史重复时保留当前消息。
- 每次真实调用前写 `context_snapshots`（分区、token、命中记忆 id、丢弃项、provider、model）。

## 7. Memory 架构

```text
一轮对话结束 ─▶ 闸门（开关 / 长度预筛 / 每 N 条 / 最小间隔）
             ─▶ 抽取（task=memory_extraction，廉价档）→ 容错 JSON 解析 + 校验
             ─▶ 候选（纯数据、不碰数据库）
             ─▶ 写库（content_hash 去重 → 合并强化 或 新增）
             ─▶ 链接（message / character / user / conversation）
检索：MemoryRetriever(FTS5) ─▶ 名次归一化 + 重要度 + 时间衰减 + 强化 ─▶ 保护类记忆（identity/promise）并入 ─▶ 记录访问
衰减：identity/promise 永不衰减；重要度 <0.6 且新鲜度 <0.15 → archived（不物理删除）
```

- 作用域：user / character / conversation / event / world / global；类型：fact / preference / identity / event / promise / emotion_peak / summary。
- **抽取与 INSERT 解耦**：`parseCandidates` 是纯函数，写库由 `MemoryService.promote` 负责。
- 成本三闸：默认每 2 条用户消息才抽取一次；短消息与纯寒暄直接跳过；抽取走廉价档模型。

## 8. Conversation Summary

- 触发：消息数 ≥ `summary.triggerMessages`（默认 40）且"未被上一条摘要覆盖"的部分 ≥ `summary.minBatch`（默认 10），最近 `summary.keepRecent`（默认 10）条永远保留原文。
- 生成：`task=summarization`（廉价档）走 ModelRouter，写入 `conversation_summaries`（含 from/to message id、token、model）。
- **原始消息永不删除**；摘要与原文同时在库，ContextEngine 在 P5 注入摘要。

## 9. Streaming 实现

- 链路：`LLM SSE/NDJSON → TaskLLM.stream → ConversationService.streamReply → 领域事件 message.delta → Web SSE → 前端实时拼接`。
- **落库粒度**：整段回复始终只有一条 assistant 消息；先以 `status='partial'` 落库（保证"模型已回复但库里没有"不会发生），过程中节流更新（150ms），结束后置为 `completed`。
- 失败/中断：`status='failed'` + `errorText`，**保留已生成的部分内容**（不丢、也不伪造完整回复）。
- 中止传播：`POST /api/conversations/:id/messages {stream:true}` 返回 runId，`POST /api/runs/:runId/abort` 触发 AbortController → 传入 provider 的 `fetch` signal；单元测试覆盖"请求第 N 个 chunk 后抛错"与"开始即中止"两种路径。
- 用量：流式调用的 usage 在 `finally` 中记账（消费方提前 break 也不会丢账）。

## 10. 前端新增功能

| 页面 | 功能 |
| --- | --- |
| 模型设置 | Provider 增删改（类型/名称/Base URL/默认模型/超时）、API Key 只写不读（`type=password`，永不回显）、测试连接、任务→模型路由切换；**高级**折叠区显示用量与成本表 |
| 聊天 | 流式增量实时显示（一条"正在输入"消息）、停止生成、**查看上下文**（分区、token、丢弃项、模型） |
| 记忆 | 列表、搜索（可展开打分细节：关键词/重要度/新鲜度/强化）、来源消息、调整重要度、删除 |
| 角色 | 角色卡导入与列表（沿用 Phase 1） |

普通用户界面不出现 RAG/Embedding/Vector DB 等术语，技术细节收进"高级"折叠区。

## 11. 测试数量与结果

`pnpm test`：

```text
ℹ tests 108
ℹ pass  108
ℹ fail    0
ℹ duration_ms ~8.7s
```

Phase 2 新增覆盖：
- **Provider**：OpenAI 兼容（chat/流式/usage/未知价格 null/401↔403↔429↔404↔5xx↔400 映射/超时与中止区分/非法 JSON/缺 content/无密钥不带 Authorization）、Ollama（默认与自定义 base URL、chat、NDJSON 流式、in-stream error、done 帧 usage）。
- **ModelRouter**：显式路由、档位回退、禁用 provider 安全降级、档位偏好、无可用 provider 硬失败。
- **ContextEngine**：分区齐备与优先级序、按角色合并的消息顺序（system 在前 / 用户消息在最后）、预算丢弃、重复内容去重、快照落库与 sourceIds、token 估算口径。
- **Memory**：解析容错（代码块/垃圾文本/非法字段）、闸门（开关/长度/每 N 条）、落库与链接、重复合并强化、检索命中与保护类记忆、评分单调性、衰减归档保留承诺、删除级联。
- **Conversation / Streaming**：用户消息先落库、流式 chunk→单条消息、中途失败保留部分内容、中止即 failed、快照与用量。
- **Summary**：规划（触发/覆盖/保留窗口）、生成落库、原文不删、后续进入上下文、走 summarization 路由。
- **端到端（真实 HTTP）**：见第 15 节。

## 12. typecheck

`pnpm typecheck`：后端（NodeNext + erasableSyntaxOnly，含测试文件）与前端（bundler + React JSX）**双双通过，无错误**。

## 13. build

`pnpm build`：后端类型检查通过；前端产物构建成功（`dist/index.html` + CSS 3.74 kB + JS 242.46 kB，gzip 75.38 kB）。

## 14. guard

`pnpm guard`：**8/8 通过**（ARCH-1…ARCH-8，输出见 README 表）。Phase 2 期间 ARCH-2 曾真实拦下一次违规：`core/services/messaging-pipeline.ts` import 了 `app/bootstrap.ts` 的 `RunRegistry` 类型 → 已改为 `core/ports/runs.ts` 端口，随后恢复全绿。ARCH-6 也持续保证 Core 零第三方运行时依赖（zod 只在 API 层）。

## 15. 真实 HTTP / UI 冒烟测试

`pnpm --filter @companion/backend smoke`（真实进程 + 真实 SQLite 文件 + 真实 HTTP + 本地 OpenAI 兼容 mock 服务）：

```text
DATA DIR: <tmp>/companion-smoke-*
HEALTH: ok / db=ok / channels=web:healthy
PROVIDER TEST: ok=true models=mock-chat,mock-cheap
CREDENTIAL LEAK CHECK: no secret in API response
CHARACTER: Aria (<uuid>)
CONVERSATION: <uuid>
CHAT #1: [user] 我只喝深烘豆，别的喝不惯，另外我生日是 3 月 14 日 | [character] （mock 模型）我记得你只喝深烘豆，今天也给你留了一杯。
STREAM: runId=run:xvAo4vGEktQ deltas=5 → "（mock 模型）我记得你只喝深烘豆，今天也给你留了一杯。…"
MESSAGES IN DB: 4（user=2, character=2）
MEMORIES: 2 条 → 用户的生日是 3 月 14 日(0.95); 用户只喝深烘咖啡豆(0.85)
RETRIEVAL: 用户只喝深烘咖啡豆 [0.905]
CONTEXT PREVIEW: model=smoke-openai tokens=214/6000 sections=character_definition(86),runtime_state(30),memories(36),recent_conversation(22),recent_conversation(23),recent_conversation(8),current_message(9)
SNAPSHOTS: 3 条，最近一条 model=mock-chat
USAGE: chat: 2次 in=84 out=34 cost=— | memory_extraction: 1次 in=42 out=17 cost=—
SMOKE OK
```

UI：前端已构建通过，路由代理配置为 `http://127.0.0.1:8787`；交互流程（模型设置 → 角色导入 → 流式聊天 → 上下文预览 → 记忆页）由 API 端到端测试与上述冒烟覆盖。**尚无浏览器自动化（Playwright）**，见第 19 节。

## 16. Model Usage 记录验证

- 单元：`memory extraction` 调用后 `model_usage` 出现 `task_type=memory_extraction`，tokens 与 `estimatedCost` 按 provider 能力估算（`0.00014`）。
- 端到端：两轮聊天后 `chat` 聚合 `calls=2, input=84, output=34`（非流式 42/17 + 流式 42/17 —— 流式 usage 已记账）。
- 诚实性：provider 通过 `/v1/models` 声明模型时未给价格 → `estimated_cost` 为 **NULL**（界面显示 "—"），不是 0；`echo` 占位模型 token 为 NULL。
- 索引与聚合接口：`GET /api/usage?days=7` 返回按任务聚合（调用数/失败数/输入输出 token/平均延迟）。

## 17. Context Snapshot 验证

- `context_snapshots` 在**每次真实模型调用前**写入；测试断言"聊天后有快照、快照含 character_definition、model 与路由一致、memoryIds 与命中一致"。
- 冒烟显示 3 条快照（2 次 chat + 1 次抽取），可回答"当时模型究竟看到了什么"。
- API：`POST /api/conversations/:id/context-preview`（不调用模型、不写历史）、`GET /api/conversations/:id/snapshots`、`GET /api/snapshots/:id`。
- 快照内只有分区文本与 id，**不含任何密钥**。

## 18. Memory Retrieval 验证

- 入库 → 检索：`POST /api/memories/search {text:"深烘豆"}` 命中 "用户只喝深烘咖啡豆"（score 0.905）。
- 排序：关键词名次（不是原始 bm25 数值）× 重要度 × 新鲜度 × 强化；identity/promise 无条件进入候选但仍按同一函数打分。
- 上下文注入：context-preview 中 `memories(36 tokens)` 分区内容确实包含该记忆。
- 来源可追溯：`GET /api/memories/:id` 返回来源消息原文与 `message/character` 链接。
- 生命周期：`POST /api/memories/decay` 归档低价值陈旧记忆、保留承诺类。

## 19. 已知问题

| # | 问题 | 影响 | 计划 |
| --- | --- | --- | --- |
| P2-1 | 无鉴权（仍只监听 127.0.0.1） | 本机多人环境有风险 | Phase 3 或单独安全阶段（本地口令 + 会话 Cookie） |
| P2-2 | 向量检索仅留端口，未实现 | 同义改写（"喝不惯别的"↔"只喝深烘"）召回弱 | 需要时实现 VectorMemoryRetriever / HybridRetriever，Core 不动 |
| P2-3 | 中文 FTS 用 OR 语义 | 长查询可能召回偏宽（靠打分收敛） | 引入停用词表与同义词典；或升级为混合检索 |
| P2-4 | 记忆抽取在后台异步进行 | 刚聊完立刻查"记忆页"可能还没出现（冒烟中需等待约 0.8s） | 提供"立即抽取"按钮（已有 API，前端未接）/ 抽取完成推 SSE |
| P2-5 | 摘要只在流式路径自动触发 | 非流式路径不会自动压缩 | 统一到管线的一个后处理阶段 |
| P2-6 | 流式中断不自动触发（客户端断开需手动调 abort） | 无人值守时可能继续消耗 token | SSE 断开自动 abort（需按会话追踪 SSE 订阅） |
| P2-7 | 无成本价格库 | 未知价格显示 "—" | 增加可选价格配置 / 内置常见模型价目表 |
| P2-8 | `context_compression` 任务类型已声明但未实现压缩器 | 超长上下文只能整块丢弃 | Phase 3 上下文压缩 |
| P2-9 | 无浏览器自动化测试 | 前端回归靠人工 | Phase 3 接 Playwright |
| P2-10 | 备份/导出/删除数据 API 仍缺失 | 数据可移植性 | Phase 3 |
| P2-11 | 记忆去重只用内容 hash（不含语义） | 同义不同字的记忆会并存 | 与 P2-2 一起做语义合并 |
| P2-12 | 单进程 SQLite，写并发靠 WAL + busy_timeout | 高并发后台任务时可能锁等待 | 需要时引入写队列/迁移 PostgreSQL |

## 20. Phase 3 准备事项

1. **关系 / 情绪 / 事件 / 调度 / 主动消息**（报告 §10–§13）：迁移 003（relationships、relationship_milestones、emotion_history、events、tasks、scheduled_jobs），与既有 `character_states` 打通。
2. **调度器**：tick 循环 + RuleEngine + 安静时段/每日上限；要求可假时钟测试（Phase 2 的 `Clock`/纯函数风格已为此铺路）。
3. **主动消息**：复用 `ModelRouter(task=proactive)`（档位已配置为 cheap）与 `TaskService`；发送走既有 `ChannelAdapter.send`。
4. **收口 Phase 2 未竟项**：P2-4（抽取完成推 SSE）、P2-5（摘要统一到管线）、P2-6（SSE 断开自动 abort）、P2-8（上下文压缩）。
5. **安全与数据**：本地口令鉴权、数据导出/删除、备份恢复（对应 P2-1 / P2-10）。
6. **可观测性**：增加"这一轮为什么用了这个模型"的路由 reason 暴露（router 已产出，仅未出 API）。
7. **前端**：记忆时间线视图、用量趋势图、Provider 多模型选择（当前用 defaultModel）。

---

**Phase 2 完成。**
停止。
不要进入 Phase 3。

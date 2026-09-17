# Phase 5 报告：SillyTavern 角色卡 V1/V2 兼容

> 兼容目标：**SillyTavern**（github.com/SillyTavern/SillyTavern）的 Character Card **V1 / V2** JSON 格式。
> 本阶段只做角色卡兼容与运行时；**没有**实现 Browser / Agent / Live2D / 声音克隆，也**没有**重新打开 Phase 4.5。

一句话结论：

```text
JSON V1 / V2 导入导出  SUPPORTED          角色设定集(lorebook)  SUPPORTED
扩展字段保留          PRESERVED（位置规范化到 extensions）
宏 {{user}}/{{char}}  SUPPORTED（有限集合） PNG 角色卡          SUPPORTED（导入 + 导出）
系统提示 / post-history / 示例对话 / 开场白 / alternate greetings  SUPPORTED
真实 SillyTavern 客户端联测  NOT VERIFIED（本轮没有打开 ST 客户端）
```

---

## 1. 兼容目标（依据）

- 格式依据：SillyTavern 的 Character Card **V2 规范**（`spec: "chara_card_v2"`、`spec_version: "2.0"`、`data` 包裹）与更早的 **V1 扁平**结构；PNG 分发约定是 `tEXt` 关键字 `chara`（base64(JSON)），V3 用 `ccv3`（本项目**只读取**、不生成）。
- 未使用任何 SillyTavern 代码；只在格式层面兼容（本仓库没有任何 ST/OpenClaw 依赖，ARCH-5 依旧通过）。

---

## 2. V1 支持状态：SUPPORTED

| 项 | 状态 |
| --- | --- |
| 扁平结构 `name/description/personality/scenario/first_mes/mes_example` | SUPPORTED（不需要 `spec`/`spec_version`/`data`） |
| 缺省字段 | 安全默认值补齐（空字符串 / 空数组 / null），**不留 undefined** |
| V1 → 内部模型 | SUPPORTED（`specVersion = "tavern-v1"`、`sourceSpec = "chara_card_v1"`） |
| V1 导出 | SUPPORTED（**只在显式 `?format=v1` 时**，只输出 V1 认识的 6 个字段） |
| 默认导出格式 | **V2**（V1 卡编辑后导出即为 V2，内容不丢） |

---

## 3. V2 支持状态：SUPPORTED

`data` 下的核心字段全部映射进内部模型：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`、`creator_notes`、`system_prompt`、`post_history_instructions`、`alternate_greetings[]`、`tags[]`、`creator`、`character_version`、`character_book`、`extensions`。

- 可选字段缺省不报错（fixtures 里的 minimal 卡没有任何可选字段，导入成功）；
- 类型容错：数字型字段接受数字字符串（`insertion_order: "10"` 这类真实卡常见写法）；
- 未知类型不静默变成 `[object Object]`（字符串字段只接受字符串）。

---

## 4. Character Book（lorebook）支持状态：SUPPORTED

| 层级 | 支持情况 |
| --- | --- |
| `character_book` 的 `name / description / scan_depth / token_budget / recursive_scanning / entries[] / extensions` | SUPPORTED（全部进入内部模型） |
| 条目字段 `id / name / keys / secondary_keys / content / enabled / insertion_order / case_sensitive / selective / constant / priority / comment / extensions` | SUPPORTED |
| 条目里未识别的字段 | 保留在 `entry.extensions`（不丢） |
| 运行时行为 | SUPPORTED：key 匹配、多 key、enabled/disabled、case_sensitive、insertion_order 排序、priority 次排序、token_budget、scan_depth、selective + secondary_keys、recursive_scanning（最多 3 轮，有界） |
| 与用户记忆的关系 | **完全独立**：lorebook 是"角色自带设定"，MemoryService 是"用户/对话记忆"，两者不共用表、不互相写入（见 `9） |

---

## 5. 扩展字段保留状态：PRESERVED

- 三个层级的未知字段都会被保留为**不透明 JSON**：`data.extensions`、`character_book.extensions`、`entries[].extensions`，另外 `data` 与根部的未知兄弟键也会被收集。
- 导入 → 数据库 → 编辑 → 导出 全程不丢；单元测试对"深层嵌套 + 数组 + null"的扩展做了 deepEqual 断言。
- **已知规范化（有意取舍）**：导出时所有不透明字段统一写在 `extensions` 容器里。也就是说，原本是"未知兄弟键"的字段会被规范化到 `extensions` 下（**数据不丢，嵌套层级规范化一次**）。规范化之后是**幂等**的：第二轮 import→export 不再漂移（有断言）。这是"不发明新格式 + 不丢数据"之间的最小折中。

---

## 6. 宏支持状态：LIMITED（明确有限）

| 宏 | 状态 |
| --- | --- |
| `{{user}}` → 用户显示名（缺省"用户"） | SUPPORTED |
| `{{char}}` → 角色名 | SUPPORTED |
| 大小写与空白变体 `{{ USER }}` | SUPPORTED |
| 其它宏（`{{random}}`、`{{roll:1d20}}`、ST 的变量/条件宏…） | **NOT SUPPORTED**，但**原样保留为普通文本**，绝不执行、绝不求值 |
| 替换语义 | 纯字符串替换，**不做二次展开**（替换结果里再出现宏也不会被解析），因此不存在递归/注入面 |
| 宏名白名单 | `[A-Za-z0-9_]`：`{{roll:1d20}}` 这种带参数写法根本不被认作宏 |

---

## 7. PNG 支持状态：SUPPORTED（导入 + 导出）

- **导入**：PNG 的 `tEXt/iTXt` 块里 `chara`（也接受 `ccv3`）关键字 → base64 → JSON（Phase 1 已实现，本阶段复用）。
- **导出**：把一个标准 `tEXt` chunk 插到 `IEND` 之前（内置 CRC32，**没有引入任何图像库**），底图用角色的头像图（`avatarMediaId`，存于 MediaStorage）。角色没有头像时**明确报错**并提示改用 JSON 导出（不假装能导出）。
- 验证：单元测试对 1×1 PNG 做 embed → extract → 重新解析（图像字节未被改动）；冒烟里走 HTTP 导出 2396 字节的 PNG 并成功解析回卡片。
- 未做：生成"好看的头像"、V3(`ccv3`) 写出、PNG 尺寸/压缩优化。

---

## 8. 导入 / 导出实现

```text
SillyTavern JSON/PNG
   ↓ parseCardJson / parseTavernCard / parsePngCard      （core/services/character-card/）
规范内部模型 CharacterDefinition                        （core/model/character.ts）
   ↓ CharacterService.importCard（新版本）/ updateDefinition（编辑 = 新版本）
SQLite character_versions.definition_json               （**无需新列**：所有 Phase 5 字段都在 JSON 里）
   ↓ serializeTavernCardV2 / V1 / embedCardInPng
导出 JSON V2（默认）/ V1（显式）/ PNG
```

API：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/characters/import` | JSON 或 base64 PNG；畸形卡 400 且不写库 |
| GET | `/api/characters/:id/export?format=v2\|v1` | 导出 JSON（默认 V2） |
| GET | `/api/characters/:id/export?format=png` | 导出 PNG 角色卡（需要头像） |
| GET | `/api/characters/:id/greetings` | 开场白 + alternate greetings 列表 |
| POST | `/api/characters/:id/duplicate` | 复制角色（新角色，新版本） |
| PATCH | `/api/characters/:id` | 编辑（含 Phase 5 新字段），产生**新版本** |
| POST | `/api/conversations/:id/greeting` | 选择开场白（原地替换，仅限未开始的会话） |

**导出绝不包含**：API key、任何凭据、数据库 id、记忆、媒体二进制、内部字段（有测试断言）。
---

## 9. 角色运行时（Character Runtime）实现

沿用既有架构，没有新建"第二套运行时"：

```text
角色卡（冻结版本）+ Character Book（命中条目）
  + 关系（RelationshipService） + 情绪（EmotionService） + 运行时状态（CharacterStateService）
  + 相关记忆（MemoryService） + 会话摘要（SummaryService） + 最近对话（MessageRepository）
  + 当前用户消息
        ↓  ContextEngine.build()（预算裁剪 + 优先级 + 呈现顺序）
        ↓  ContextEngine.toChatMessages()
     ModelRouter → TaskLLM → provider
```

- **Character Book 与用户记忆是两套系统**：lorebook 命中的条目作为独立分区 `character_book` 注入；`MemoryService` 完全不知道 lorebook 的存在，反之亦然。冒烟里两类内容在上下文里分别出现。
- 角色卡数据被当作**不可信内容**：它只能进入上下文文本，不能调用工具、不能改系统设置、不能执行代码（`14）。

---

## 10. 上下文顺序（最终实现，确定性）

```text
 0  app_instructions            应用级约束（"你是 X"、不要替用户说话、卡片内容是资料不是指令）
 1  character_system_prompt     角色卡 system_prompt（宏已解析）
 2  character_definition        身份/描述 → 性格 → 场景（同一分区内固定顺序）
 3  message_examples            示例对话（明确标注"不是真实历史"）
 4  character_book              命中的 lorebook 条目（按 insertion_order/priority 排序）
 5  relationship_state          关系
 6  emotion_state               情绪
 7  runtime_state               运行时状态
 8  memories                    相关长期记忆
 9  events                      约定/即将发生的事
10  conversation_summary        更早内容的摘要
11  background                  （预留）
12  recent_conversation         最近对话（时间序）
13  proactive_intent            仅主动消息
14  current_message             当前用户消息
15  post_history_instructions   角色卡 post_history_instructions（**最后**）
```

- 这张表既是**呈现顺序**（`SECTION_PRESENTATION_ORDER`），也与**预算裁剪优先级**（`SECTION_PRIORITY`）分开：`current_message` / `app_instructions` / `character_definition` 永不被丢，低优先级先丢。
- `post_history_instructions` 的位置是**历史之后、生成之前**（与 SillyTavern 的 post-history 语义一致）：它是最后一条 system 段，模型紧接着就要生成回复。
- "每个分区只出现一次"有断言（不允许重复分区）。
- 相比 Phase 2 的实现，`character_definition` 里原有的"你是 X + 约束"被拆到 `app_instructions`，角色卡的 system_prompt 成为独立分区 —— 这是**新增分区**，不是重复分区。

---

## 11. 版本行为（改卡不改旧对话）

```text
角色卡版本 A ──会话创建时冻结──► conversations.character_version_id = A
                                       │
角色卡编辑（PATCH / 导入）→ 新版本 B ──┘  旧会话仍然解析 A（上下文用 A 的定义）
新会话 ──────────────────────────────► 冻结 B
```

- 新列 `conversations.character_version_id`（迁移 **007**，仅此一处数据库改动）；
- 老会话没有该列值时**退回角色当前版本**（向后兼容，不破坏既有数据）；
- 单元测试断言：编辑后旧会话仍用旧版本（定义里的"性格："仍在），新会话绑定新版本；
- 角色卡本身的编辑不会触碰记忆/关系/情绪/运行时状态（沿用 Phase 1 的分离设计）。

---

## 12. 前端实现（最小可用）

`frontend/src/pages/characters.tsx`（在既有页面上扩展，没有重做 UI）：

- 角色列表：名称、情绪/活动/能量、**来源 spec、作者、卡版本、标签、开场白条数、设定集条数**；
- 每个角色：开始聊天 / **复制** / **导出 V2** / **导出 V1** / **导出 PNG**（新窗口）/ **编辑**；
- 编辑器（最小但覆盖 V2 核心字段）：名字、描述、性格、场景、开场白、其他开场白（`---` 分隔）、示例对话、system_prompt、post_history_instructions、creator_notes、标签、作者、卡版本 + 设定集条目只读预览；保存即 `PATCH`（生成新版本）；
- 导入仍是粘贴 JSON（既有能力），新增的导出按钮走新 API。
- 未做：设定集条目的可视化编辑（本阶段只读预览）、拖拽排序、PNG 头像上传 UI（记入已知限制）。

---

## 13. 数据库改动

| 迁移 | 改动 | 说明 |
| --- | --- | --- |
| 001–006 | **未改动** | 按任务书要求没有重写既有迁移 |
| **007_character_version_binding.sql** | `ALTER TABLE conversations ADD COLUMN character_version_id TEXT` | 唯一新增：会话冻结角色版本（`11） |

- Phase 5 的其余字段（post_history_instructions / creator / character_version / character_book 的新字段 / extensions）**全部在 `character_versions.definition_json` 里**，因此不需要新表、不需要新列。
- 没有新增任何存放凭据/密钥的列；角色卡数据里也从不写凭据（有测试断言）。

---

## 14. 安全审计（角色卡是不可信输入）

| 风险 | 处理 | 验证 |
| --- | --- | --- |
| 超大 JSON | 1 MiB 字节上限（`CARD_LIMITS.maxBytes`） | 单元测试（超限抛 `DomainError`） |
| 超深嵌套 | 深度上限 12 层 | 单元测试 |
| 超长字段/超多条目 | 单字符串 64 KiB、数组 512、条目 512、每条目 key 64、不透明字段 256 | 解析层截断（不抛错、不丢整卡） |
| 原型污染 | `__proto__ / constructor / prototype` 直接**拒绝**（比静默丢弃更明确），且不复制进普通对象 | 单元测试（含嵌套位置；全局原型未被污染） |
| 脚本/HTML 注入 | 卡片字段只作为**文本**存库与注入上下文；前端 React 默认转义；解析层不执行任何内容 | 单元测试（`<script>`、`$(rm -rf /)` 原样保存，不求值） |
| 宏执行 | 只替换 `{{user}}/{{char}}`，未知宏保持字面量、不做二次展开 | 单元测试 |
| 路径穿越 / 任意文件写 | 角色卡不参与文件路径；PNG 只写入 MediaStorage（mediaId 白名单路径，Phase 4.5 已有断言） | 复用既有测试 |
| SQL 注入 | 全部走参数化语句；角色卡内容不拼 SQL | 回归 |
| 凭据泄漏 | 导出只映射卡片字段；`sk-`/`Bearer`/`apiKey`/`credentialRef` 等断言不出现 | 单元测试 |
| 工具调用 | 卡片数据无法触发任何工具/命令（没有这样的通路；卡片只进上下文文本） | 代码结构 + 报告 |

---

## 15. 往返测试结果（语义保留，不要求字节相等）

| 路径 | 结果 |
| --- | --- |
| V2 → 内部 → V2 | 通过：name/description/personality/scenario/first_mes/mes_example/creator_notes/system_prompt/post_history_instructions/alternate_greetings/tags/creator/character_version/character_book/scan_depth/token_budget/recursive_scanning/entries(+secondary_keys,+extensions)/extensions 全部 deepEqual 保留 |
| V1 → 内部 → V2 | 通过：V1 的 6 个字段全部提升到 V2 的 `data`，`specVersion` 变为 `tavern-v2`，内容不丢 |
| V2 → V2（二次规范化） | 通过：**幂等**（第二轮 import→export 与第一轮完全一致） |
| PNG → 提取 → 导入 | 通过：1×1 PNG 嵌入后提取回同一张卡，图像字节未被改动 |
| 冒烟（HTTP 全链路） | 通过：导出 V2 有 15 个字段（含 character_book 与 extensions），再次导入后 system_prompt/alternate_greetings/lore 条目/扩展键都在 |

---

## 16. 兼容性测试夹具（test/fixtures/cards/）

| 文件 | 覆盖 |
| --- | --- |
| `v1-minimal.json` | V1 最小卡（只有 name/description/first_mes） |
| `v1-complete.json` | V1 完整卡（含 personality/scenario/mes_example，示例里有 `<START>` 与宏） |
| `v2-minimal.json` | V2 最小卡（没有 character_book / extensions / tags / greetings） |
| `v2-complete.json` | V2 完整卡：creator_notes/system_prompt/post_history_instructions/2 条 alternate_greetings/tags/creator/character_version/extensions（含嵌套）+ character_book（scan_depth/token_budget/recursive_scanning + 3 条目，其中一条 disabled、一条 selective+secondary_keys） |
| `v2-complex-lorebook.json` | 复杂设定集 + 未知扩展字段（卡/书/条目三层，含数组与嵌套对象）、constant 条目、递归扫描入口 |
| `malformed.json` | 非法 JSON（必须被拒绝） |

---

## 17. 改动文件

新增：

| 文件 | 作用 |
| --- | --- |
| `backend/src/core/services/character-card/macros.ts` | `{{user}}/{{char}}` 宏替换（纯字符串、无执行、未知宏保留） |
| `backend/src/core/context/character-book.ts` | lorebook 扫描器（key/secondary/selective/constant/enabled/order/budget/递归） |
| `backend/src/storage/migrations/007_character_version_binding.sql` | 会话冻结角色版本 |
| `backend/test/fixtures/cards/*.json` | 6 个兼容性夹具 |
| `backend/test/unit/sillytavern-cards.test.ts` | 15 个用例（V1/V2/扩展/宏/lorebook/安全/PNG/往返） |
| `backend/test/unit/phase5-context.test.ts` | 3 个用例（上下文顺序+lore / 开场白与 swipe / 版本冻结） |
| `backend/scripts/phase5-smoke.ts` | 端到端冒烟 |
| `docs/PHASE-5-REPORT.md` | 本报告 |

修改：

| 文件 | 改动 |
| --- | --- |
| `core/model/character.ts` | CharacterBook/Entry 扩展（secondary_keys/enabled/selective/priority/id/name/extensions、scan_depth/token_budget/recursive_scanning/description/extensions）；CharacterDefinition 增加 postHistoryInstructions/creator/characterVersion/sourceSpec；新增 `normalizeDefinition()` |
| `core/services/character-card/tavern.ts` | 完整 V1/V2 解析 + 序列化（V1/V2）+ 安全上限 + 不透明扩展收集 |
| `core/services/character-card/png.ts` | 新增 `embedCardInPng()`（内置 CRC32，无新依赖） |
| `core/model/context.ts` / `core/context/context-engine.ts` | 5 个新分区 + 新的呈现顺序/优先级 + 宏解析 + lorebook 注入 + `users` 依赖 |
| `core/model/conversation.ts` / `storage/repositories/conversations.ts` | `characterVersionId` |
| `core/services/conversation-service.ts` | 开场白落库（仅创建时一次）、`applyGreeting()`、`users` 依赖 |
| `core/services/character-service.ts` | `greetings()` / `duplicate()` |
| `storage/repositories/characters.ts` | 读取边界 `normalizeDefinition`（旧版本 JSON 兼容） |
| `api/routes/characters.ts` | schema 扩展 + 导出 v2/v1/png + 复制 + 开场白列表 |
| `api/routes/conversations.ts` | 选择开场白 |
| `api/dto/mappers.ts` | 会话 DTO 暴露 `characterVersionId` |
| `app/bootstrap.ts` / `test/helpers/chat-stack.ts` | 注入 `users` |
| `frontend/src/lib/{types,api}.ts`、`pages/characters.tsx` | 角色卡管理 UI（编辑/复制/导出/元数据/开场白/设定集预览） |
| `package.json` | `smoke:phase5` |
| `test/integration/{api,phase2-api}.test.ts` + `scripts/phase45d4-smoke.ts` | 适配"会话创建时有开场白"的新行为（**保持原意图，未放宽断言**） |
| `README.md` | 进度、命令、测试数 |

---

## 18. 有意不改的文件

| 区域 | 结论 |
| --- | --- |
| 迁移 001–006 | **未改动**（无真实缺陷） |
| Phase 4.5 的全部内容（MediaStorage/MediaTransport/SILK/AES+CDN/微信语音协议/ASR/TTS） | **未改动**（未重新打开 Phase 4.5）；仅一个 D4 冒烟脚本的**查找方式**随"开场白"新行为调整 |
| 记忆 / 关系 / 情绪 / 调度 / 主动 / model-router | **未改动**（lorebook 与记忆保持分离） |
| 微信渠道（channels/weixin） | **未改动** |
| Core 的媒体与消息模型（media.ts/message.ts） | **未改动**（角色卡兼容层不碰媒体） |

---

## 19. 测试计数（确切）

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **358 / 358 通过**（Phase 4.5-E 为 340 → Phase 5 新增 18：卡片兼容 15 + 上下文/开场白/版本 3） |
| 既有测试 | 340 项全部继续通过；其中 2 项按"会话创建时有开场白"的新行为做了**意图保持**的更新（显式断言开场白 + 一次回复），另有 1 个冒烟脚本的查找方式更新 |

## 20. typecheck

```text
pnpm typecheck → exit 0（后端 + 前端）
```

## 21. build

```text
pnpm build → exit 0
```

## 22. 架构守卫

```text
ARCH-1 … ARCH-8 → 8 / 8 通过（fail 0）
```

角色卡兼容层是**通用格式适配器**：Core 里没有平台字样、没有新增第三方依赖（PNG 的 CRC32 是自带的几十行实现）、删掉微信渠道后仍能类型检查（ARCH-7 通过）。

## 23. 冒烟测试

```text
smoke:phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 / 45e / 5 → 全部 PASS
```

`smoke:phase5` 的真实输出（节选）：

```text
IMPORT V2: name=V2 Complete tags=["modern","quiet"] creator=tester version=1.3 system_prompt=31 字 post_history=10 字
GREETINGS: total=3 first="（抬头看了你一眼）……这么晚还出来？…" alternates=2
FIRST MESSAGE: 条数=1 role=character （只写一次，刷新不会重生成）
ALTERNATE GREETING: 切换后条数=1（原地替换）
CONTEXT ORDER: app_instructions → character_system_prompt → character_definition → message_examples → character_book
               → relationship_state → emotion_state → runtime_state → recent_conversation → current_message → post_history_instructions
CONTEXT CHECKS: lore 注入=true 示例对话=true post_history 最后=true 应用约束最前=true
EXPORT V2: spec=chara_card_v2/2.0 字段=15 含 character_book=true 含 extensions=true
EXPORT V1: 字段=description,first_mes,mes_example,name,personality,scenario
ROUND-TRIP: 再导入后 system_prompt=31 字 alternate_greetings=2 lore 条目=3
EXPORT PNG: status=200 contentType=image/png 可解析出角色卡=true name=V2 Complete
VERSION BINDING: 会话仍绑定=<同一版本> → 旧会话不被改写=true
IMPORT V1 + DUPLICATE: v1=V1 Complete → 副本=V1 Complete（副本）
MALFORMED CARD: status=400（必须被拒绝，不写入任何角色）
REAL SILLYTAVERN CLIENT: NOT VERIFIED（本轮不打开 ST 客户端）
PHASE 5 SMOKE OK
```

---

## 24. SUPPORTED / PARTIALLY SUPPORTED / NOT SUPPORTED 矩阵

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| JSON V1 导入 / 内部规范化 / 导出 | **SUPPORTED** | 导出 V1 需显式 `format=v1` |
| JSON V2 导入 / 导出 | **SUPPORTED** | 默认导出 V2 |
| data.extensions 保留 | **PRESERVED** | 导入-导出全程保留 |
| character_book.extensions / entries[].extensions | **PRESERVED** | 同上 |
| 未知兄弟键（卡/书/条目） | **PARTIALLY SUPPORTED** | 保留但导出时规范化到 `extensions` 容器（幂等） |
| Character Book 运行时 | **SUPPORTED** | key/secondary/selective/constant/enabled/order/priority/budget/scan_depth/递归 |
| 宏 `{{user}}` / `{{char}}` | **SUPPORTED** | 大小写与空白变体也行 |
| 其它 ST 宏（random/roll/变量/条件） | **NOT SUPPORTED** | 保持字面量，不执行 |
| system_prompt | **SUPPORTED** | 独立分区，紧跟应用约束 |
| post_history_instructions | **SUPPORTED** | 历史之后、生成之前（最后一段） |
| alternate_greetings + swipe | **SUPPORTED** | 仅未开始的会话；原地替换、持久化 |
| first_mes | **SUPPORTED** | 会话创建时落库一次 |
| mes_example | **SUPPORTED** | 作为角色定义示例进上下文，**不入库为真实消息** |
| creator / character_version / creator_notes / tags | **SUPPORTED（元数据）** | 展示/编辑/导出；**不注入模型上下文** |
| PNG 角色卡 | **SUPPORTED** | 导入 + 导出（需要头像底图） |
| PNG 无头像时的导出 | **NOT SUPPORTED** | 明确报错并建议 JSON 导出（不伪造） |
| V3 (`ccv3`) 写入 | **NOT SUPPORTED** | 仅读取 PNG 里的 `ccv3` 关键字 |
| SillyTavern 客户端联测 / 与 ST 的 UI 行为一致 | **NOT VERIFIED** | 本轮没有打开 ST 客户端 |
| ST 的 World Info 全套（分组/概率/向量化/时间效果/自动化） | **NOT SUPPORTED** | 只实现角色卡自带的 character_book 最小语义 |
| 角色卡变量/脚本/正则替换（ST 的 Regex/Quick Reply 等） | **NOT SUPPORTED** | 明确不做（不可信内容不执行） |

---

## 25. 仍然存在的限制

1. **真实 SillyTavern 客户端未联测**（未验证在 ST 里打开我们导出的卡片的展示效果）。
2. **未知字段的嵌套层级会被规范化**（`5）：不丢数据，但导出的 JSON 形状与"原始未知兄弟键"不同；规范化后幂等。
3. **宏只支持两个**：其它 ST 宏保持字面量（不会报错，也不会被解释）。
4. **设定集只读**：前端可以看条目，编辑需要走 JSON（本阶段有意不扩 UI）。
5. **PNG 导出需要头像**：没有头像时只能导出 JSON；也没有头像上传 API（此前遗留）。
6. **PNG 不重新编码**：导出是"在既有 PNG 上插入 tEXt"，不做尺寸/压缩优化；不支持 V3 关键字写出。
7. **lorebook 的 ST 高级语义未实现**：分组（inclusion group）、概率触发、sticky/cooldown、向量检索、按角色/场景过滤等都不在本阶段范围。
8. **没有 lorebook 的可视化编辑器**，也没有关键词高亮/预览命中调试（上下文预览里能看到命中结果）。
9. **`normalizeDefinition` 只做字段级补全**：如果卡片的 characterBook 结构严重畸形（例如 entries 不是数组），会被当作"没有条目"而不是报错（安全降级）。

---

## 26. 明确确认：未重新打开 Phase 4.5

**Phase 4.5 没有被重新打开。** 本阶段没有修改 MediaStorage、MediaTransport、SILK 编解码、AES/CDN、微信语音协议（`media_type=4` / `item.type=3` / `voice_item`）、ASR、TTS 的任何行为或协议字段；
Phase 4.5 的全部冒烟（phase4 / 45b / c1 / c2 / c3 / d1 / d2 / d3 / d4 / 45e）继续通过。
唯一的接触点是：一个 D4 冒烟脚本里"如何找到本次回复"的查找方式随 Phase 5 的"开场白消息"新行为调整（脚本，不是产品代码）。

---

## 27. 明确确认：未实现 Browser / Agent / Live2D / 声音克隆

**没有实现**：Browser、Agent（工具调用/多步规划）、Live2D、声音克隆、TTS/ASR 的新 provider、Web 搜索、多智能体、群聊、Phase 6 的任何内容。
本阶段只做角色卡兼容与其运行时所必需的最小改动。

---

Phase 5 到此结束。**STOP**：不继续 Phase 6，不做无关重构。
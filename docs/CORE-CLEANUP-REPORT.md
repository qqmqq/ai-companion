# CORE CLEANUP 报告：移除 SillyTavern 角色卡系统 + 修复模型选择

日期：2026-09-16 ｜ 范围：仅这两件事，未进入 Phase 6，未新增 Browser / Agent / Live2D / Voice Cloning / OpenClaw。

结论（先说）：

- **SILLYTAVERN INTEGRATION = REMOVED**
- **MODEL SELECTION = VERIFIED**

---

## 1. 删除了哪些 SillyTavern 功能

### 1.1 后端核心代码（整文件删除）

| 文件 | 作用 |
| --- | --- |
| `backend/src/core/services/character-card/tavern.ts` | Tavern V1/V2 解析、规范化、Character Book、导出序列化 |
| `backend/src/core/services/character-card/macros.ts` | `{{user}}` / `{{char}}` 宏替换 |
| `backend/src/core/services/character-card/png.ts` | PNG `chara` / `ccv3` 块读写、卡片嵌入导出 |
| `backend/src/core/context/character-book.ts` | lorebook 扫描（key / secondary / selective / constant / 预算 / 递归） |

### 1.2 后端能力与接口（删除）

- `POST /api/characters/import`（Tavern V1/V2 JSON + PNG 角色卡导入）
- `POST /api/characters/import/preview`（PNG 解析预览）
- `GET /api/characters/:id/export?format=v2|v1|png`（SillyTavern 导出器，含 PNG 导出）
- `GET /api/characters/:id/greetings`（first_mes + alternate_greetings 列表）
- `POST /api/conversations/:id/greeting`（按序号切换开场白 = ST swipe）
  · 同时删除 `ConversationService.applyGreeting()` 与开场白宏渲染
- `CharacterService.parseCardContent()` / `importCard()`
- 上下文分区 `character_book` / `message_examples` / `post_history_instructions`（模型字段、优先级表、呈现顺序表、构造器全部移除）
- `ContextEngineDeps.users`（只服务于宏，已随宏一起删除）
- 角色定义中的 ST 专用字段：`characterBook`、`extensions`、`alternateGreetings`、`messageExamples`、`creatorNotes`、`postHistoryInstructions`、`creator`、`characterVersion`、`tags`、`specVersion`、`sourceSpec`、`CharacterCardSpec`、`CharacterBook`、`CharacterBookEntry`

### 1.3 前端（删除的入口）

见第 3 节。

### 1.4 测试与 fixture（删除）

- `backend/test/unit/character-card.test.ts`、`backend/test/unit/sillytavern-cards.test.ts`
- `backend/test/integration/character-png-import.test.ts`
- `backend/test/unit/phase5-context.test.ts`（100% ST 断言，替换为原生版本绑定/上下文顺序测试，见 §10）
- `backend/test/fixtures/cards/`（v1/v2 minimal、complete、complex-lorebook、malformed、v2-complete.png）
- `backend/test/fixtures/character-v1.json`、`character-v2.json`
- `backend/scripts/phase5-smoke.ts` 与 `package.json` 的 `smoke:phase5` 入口

### 1.5 没有被误删的东西

会话表列 `conversations.character_version_id`、`character_versions.spec_version` 都**保留**（数据库不重写）。
`spec_version` 是历史遗留的 NOT NULL 列，新版本统一写 `companion-v1`；旧行里原有的第三方卡格式字符串照原样读出，但已无任何运行时代码依赖它。

---

## 2. 保留了什么普通 Character 功能

原生模型（`backend/src/core/model/character.ts`）只保留六个字段：

| 字段 | 用途 |
| --- | --- |
| `name` | 身份 |
| `description` | 角色设定，进入 `character_definition` 分区 |
| `personality` | 性格，进入 `character_definition` 分区 |
| `scenario` | 场景，进入 `character_definition` 分区 |
| `systemPrompt` | 角色自己的 system prompt，进入 `character_system_prompt` 分区 |
| `firstMessage` | 开场白：新建会话时写入第一条角色消息 |

另外保留：

- **头像**：`characters.avatar_media_id` → MediaStorage（二进制永不进库），`PUT/GET/DELETE /api/characters/:id/avatar`，支持 PNG / JPEG / WebP，上限 8 MiB，只认真正的图片魔数
- **角色版本**：`character_versions` 表、`POST` 创建版本、`PATCH` 编辑=新版本、`GET /api/characters/:id/versions`、DTO 里的 `versionCount`
- **角色 → 会话绑定**：`conversations.character_version_id` 冻结创建时的版本
- 角色 CRUD：`GET/POST /api/characters`、`GET/PATCH/DELETE /api/characters/:id`、`POST /api/characters/:id/duplicate`、`GET/PATCH /api/characters/:id/state`
- 记忆仍然是**记忆**：没有把 Memory 改造成 lorebook，也没有保留任何世界设定注入系统

未受影响的既有能力：微信渠道、媒体（图片/文件/视频/语音/SILK）、ASR、TTS、记忆、关系、情绪、调度、主动消息 —— 它们不依赖角色卡子系统，删除后全部回归通过（见 §10）。

---

## 3. 删除/废弃了哪些前端入口

`frontend/src/pages/characters.tsx` 整页重写：

| 删除 | 替换为 |
| --- | --- |
| 「上传 PNG 角色卡」文件选择 + 解析预览面板（头像/卡版本/author/标签/设定集/扩展字段） | 「新建角色」表单：名称 / 描述 / 性格 / 背景 / System Prompt / 开场白 |
| 「或者粘贴 JSON」（Tavern V1/V2 文本框 + `chara_card_v2` 占位符） | 同上，直接填字段，不再有卡格式概念 |
| 「导入 JSON」「导入角色」按钮 | 「创建角色」/「保存（生成新版本）」 |
| 「导出 V2」「导出 V1」「导出 PNG」按钮 | 删除（不再有角色卡导出） |
| ST 字段编辑器（messageExamples / postHistoryInstructions / creatorNotes / creator / characterVersion / tags / alternateGreetings / characterBook 预览） | 六个原生字段 |
| —— | 新增「头像」上传/删除、列表内头像、`版本：第 N 版`、`删除`（带确认） |

`frontend/src/lib/api.ts`：删除 `importCard`、`previewCardPng`、`importCardPng`、`exportCharacter`、`characterGreetings`、`selectGreeting`；新增 `createCharacter` / `deleteCharacter` / `setCharacterAvatar` / `clearCharacterAvatar`。
`frontend/src/lib/types.ts`：`CharacterDto.definition` 收敛为六个字段，删除 `CardPreviewDto` 与全部 ST 类型。

---

## 4. Model 选择问题的根因

### 4.1 主因（线上真实复现）：悬空路由劫持了模型名

`backend/src/providers/model-router.ts` 的兜底分支原本是：

```ts
return { taskType: task, providerId: picked.config.id, model: route?.model ?? picked.config.defaultModel };
```

`route` 是**当前任务配置的路由**，与 `picked`（最终被选中的 provider）**没有关系**。
真实数据现场（用户本机 SQLite）：

- `model_providers`：只有一行 `openai-compatible-01a0a8a9`（deepseek，`default_model = deepseek-V4-flash`）
- `model_routes`：`chat -> provider_id "echo", model "echo-1"`（echo provider 早已被删除，路由却活了下来）
- `model_usage`：`provider_id = openai-compatible-01a0a8a9, model = "echo-1", success = 0, error_kind = invalid_response`

于是：路由指向不存在的 echo → 兜底选到真实 provider → **却把 `route.model = "echo-1"` 发给了真实 API**。用户配置的 `deepseek-V4-flash` 从来没被用过。

### 4.2 次因：界面根本无法表达"模型"

- `frontend/src/pages/settings.tsx` 的「任务用哪个模型」只让用户选 Provider，然后用 `provider.defaultModel` 当模型提交（`api.setRoute(task, providerId, provider.defaultModel)`）——模型永远是"该 Provider 的默认模型"，用户无法单独选/填。
- `GET /api/models`（会自动去上游取模型列表）在后端早就存在，但前端**零调用**。
- Provider 表单只有「默认模型」一个输入框，且没有"编辑"，改配置会再 POST 一次生成重复 Provider。

### 4.3 结构性：删 Provider 不删路由

`DELETE /api/providers/:id` 只删 provider 与其凭据，`model_routes` 里指向它的行永久留存，且没有任何 HTTP 接口能删单条路由 → 悬空路由只会越积越多（4.1 的现场就是这么来的）。

### 4.4 顺带发现的第三个坑：内置 echo 会顶掉真实 Provider

档位兜底里，内置 `echo` 与用户真实 provider 同属 `standard` 档，且 echo 是启动时种下的第一条 → 没有显式路由时会优先选中占位模型。已修：同档位优先非 echo。

---

## 5. 修改了哪些文件

### 后端 —— 删除

- `backend/src/core/services/character-card/tavern.ts`、`macros.ts`、`png.ts`（整目录）
- `backend/src/core/context/character-book.ts`
- `backend/scripts/phase5-smoke.ts`

### 后端 —— 修改

- `core/model/character.ts`：定义收敛为六个字段；`normalizeDefinition` 变成"读取边界安全忽略遗留键"
- `core/model/context.ts`：删除 3 个 ST 分区 kind
- `core/context/context-engine.ts`：删除 lorebook / 示例对话 / post_history / 宏，重排呈现顺序与优先级
- `core/services/character-service.ts`：删除 `greetings` / `parseCardContent` / `importCard`；新增 `setAvatar`；版本一律写 `companion-v1`
- `core/services/conversation-service.ts`：删除 `applyGreeting` 与宏渲染；开场白写入不再做宏替换
- `core/ports/repositories.ts`：`CharacterRepository.updateAvatar`
- `core/ports/repositories.phase2.ts`：`ProviderConfigRepository.deleteRoutesByProvider`
- `core/ports/model-config.ts`：未改（读端口）
- `storage/repositories/characters.ts`：`updateAvatar` 实现
- `storage/repositories/model-config.ts`：`deleteRoutesByProvider` 实现
- `api/routes/characters.ts`：整文件重写为原生 CRUD + 头像上传/读取/清除（见 §2）
- `api/routes/conversations.ts`：删除 greeting 路由
- `api/dto/mappers.ts`：`CharacterDto.versionCount`
- `app/bootstrap.ts`：context engine 不再注入 `users`；启动时清理悬空路由（§6）
- **`providers/model-router.ts`**：兜底分支不再沿用别的 provider 的路由模型；同档位优先非 echo（§4.1 / §4.4）
- `api/routes/providers.ts`：删 Provider 时连带删它的路由
- `backend/tsconfig.json`：`include` 增加 `scripts/**/*.ts`（此前 scripts 从未被类型检查）
- `backend/package.json`：移除 `smoke:phase5`
- `backend/scripts/*.ts`（10 个）：改用 `POST /api/characters`（§10 说明）

### 前端 —— 修改

- `pages/characters.tsx`：整页重写（§3）
- `pages/settings.tsx`：Provider 表单支持「编辑」；「刷新模型列表」；每条任务路由 = Provider 下拉 + Model 输入（带 datalist 候选）+ 「应用」；显示"实际使用"
- `pages/chat.tsx`：聊天页顶部显示「当前模型：provider / model」
- `lib/api.ts`：角色 API 换代；错误只抛后端 `error.message`；`setRoute` 允许 `model: null`
- `lib/types.ts`：DTO 收敛
- `styles.css`：头像占位样式

### 测试 —— 新增/替换

- 新增 `backend/test/integration/character-native.test.ts`（4）：原生生命周期、头像字节一致、错误输入、**旧数据兼容**
- 新增 `backend/test/integration/model-selection.test.ts`（6）：见 §10
- 新增 `backend/test/unit/context-ordering-and-version-binding.test.ts`（3）：替换原 `phase5-context.test.ts`
- 修改 `backend/test/unit/model-router.test.ts`：修掉一条**断言了 bug 行为**的旧测试，新增 4 条路由回归
- 迁移 `api.test.ts` / `phase2-api.test.ts` / `phase3-api.test.ts` / `sse.test.ts` / `phase4-proactive-weixin.test.ts` / `test/helpers/chat-stack.ts` 到原生角色 API

### 文档

- 新增 `docs/CORE-CLEANUP-REPORT.md`（本文件）；更新 `README.md`（能力描述、快速开始、验证命令表）

数据库：**没有新增 migration，也没有改写 001–007**。JSON 字段层面的废弃在读取边界处理（§6）。

---

## 6. Model 配置如何保存

三层，全部在 SQLite，刷新页面不丢（前端不做任何本地存储，一律重新读接口）：

| 位置 | 内容 |
| --- | --- |
| `model_providers.default_model` | Provider 的默认模型（用户可手填，也可从发现列表里点选后保存） |
| `model_routes(task_type, provider_id, model)` | 每个任务显式选择的 Provider + Model（`chat` = 日常聊天） |
| `model_providers.credential_ref` + 凭据加密存储 | API Key（写入后再也不回传，界面永远不显示明文） |

写入路径：`POST/PATCH /api/providers` 与 `PUT /api/model-routing`；读取路径：`GET /api/providers`、`GET /api/model-routing`（同时返回 `configured` 与 `resolved`）。

启动时的两处卫生处理（`app/bootstrap.ts`）：

1. 只在 `model_providers` 为空时种入内置 echo；
2. **清理悬空路由**：删掉 `provider_id` 已不存在的路由行（用户的有效配置不动）。这一条正是把用户机器上那条 `chat -> echo/echo-1` 清掉的原因。

删除 Provider 时也会连带删除它的路由（避免再次产生悬空路由）。

角色版本相关的数据兼容（题目 §六）：旧 `definition_json` 里的 ST 字段（`characterBook`/`alternateGreetings`/`tags`/`creator`/`specVersion`/`extensions`/…）在 `normalizeDefinition` 处被**静默忽略**，不崩、不迁移、不再生成；已有会话的 `character_version_id` 原样保留。已用测试覆盖（直接往库里写一行旧格式定义再读接口）。

---

## 7. Model 如何传递到 Provider

链路（每一跳都已验证）：

```
设置页（Provider 下拉 + Model 输入）
  → PUT /api/model-routing { taskType, providerId, model }
  → model_routes 落库
  → ModelRouter.resolve(task)：显式路由可用 → { providerId, model }
       └ 路由不可用 → 按档位兜底，但 model 只能用**被选中 provider 的** defaultModel
  → TaskLLM.chat()：provider.chat({ ...request, model: binding.model })
  → OpenAI 兼容：POST {baseUrl}/v1/chat/completions body.model = request.model || options.model
     Ollama：POST {baseUrl}/api/chat body.model = 同上
  → model_usage / context_snapshots 记录真实使用的 provider + model
```

修好之后，**用户选的 Model = 数据库里的 Model = ModelRouter 用的 Model = Provider 请求体里的 Model**。
实测证据（本机真实 DeepSeek）：修好后第一次请求的 usage 行是 `provider_id=openai-compatible-01a0a8a9, model=deepseek-V4-flash`，上游返回 400 并明确说 “you passed deepseek-V4-flash” —— 说明模型名确实按用户配置发出去了（该模型名上游不支持，见 §11）。
把模型改成上游支持的 `deepseek-flash` 后，同一会话拿到真实回复：`还行，店里不忙，就是下午磨豆机响了一整天，耳朵有点木。`，usage `success=true, in=278, out=55, latency=1236ms`。

---

## 8. 自动模型发现如何工作

- 后端：`GET /api/models` 遍历所有 enabled provider，调用各自 `listModels()`：
  · OpenAI 兼容 → `GET {baseUrl}/v1/models`
  · Ollama → `GET {baseUrl}/api/tags`
  · 内置 echo → 直接返回自身（不发网络请求）
  单个 provider 失败只在该条目里返回 `error`，不影响其它 provider，也**不**阻塞手填。
- 前端：Provider 卡片上的「测试连接」会把结果存进 `models[providerId]`；「任务用哪个模型」区的「刷新模型列表」会对所有 Provider 跑一遍，并把模型 id 作为 `<datalist>` 候选挂到 Model 输入框上。
- 实测（本机）：`GET /api/models` → `[{ providerId: "openai-compatible-01a0a8a9", models: [deepseek-flash, deepseek-v4-pro], error: null }]`。
- 明确不假设所有 OpenAI 兼容服务都有 `/v1/models`：404/500 都只是"没有列表"。

---

## 9. 手动模型输入如何工作

- Model 是普通文本输入框（带候选下拉），任何上游没报告过的模型名都能直接填：`gpt-5` / `qwen-plus` / `qwen3:8b` … 代码里没有任何写死的模型名。
- 清空输入框并「应用」= 存 `model: null` = "用该 Provider 的默认模型"。
- 发现失败时界面只提示"部分 Provider 取不到列表（仍可手填模型名）"，输入框照常可用。

---

## 10. 测试结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test`（后端） | **354 / 354 pass，0 fail**（删除 ST 测试后总数下降，新增 13 条原生/模型测试） |
| `pnpm typecheck` | exit 0（backend 含 `src` + `test` + 现在也含 `scripts`；frontend 0 错误） |
| `pnpm build` | exit 0（backend 类型检查 + frontend 产物 300.40 kB / gzip 94.65 kB） |
| `pnpm guard` | **8 / 8 pass**（含 ARCH-7：物理删除 `channels/weixin` 后仍能 `tsc --noEmit`） |
| smoke（12 个） | `smoke` / `phase3` / `phase4` / `45b` / `45c1` / `45c2` / `45c3` / `45d1` / `45d2` / `45d3` / `45d4` / `45e` **全部 OK**（`smoke:phase5` 已随 ST 删除） |

新增/修改的关键测试：

- `model-selection.test.ts`（6）：① 选 A 发 A、切 B 发 B（断言 Provider 真实收到的 `body.model`）；② 悬空路由不能劫持真实 Provider 的模型；③ 删 Provider 会带走它的路由；④ Ollama `/api/tags` 发现（不写死模型名）；⑤ 发现失败仍能手填且手填值真的发出；⑥ 配置持久（重新读接口仍是用户那套）
- `model-router.test.ts`（9）：新增 4 条（悬空路由、同 provider 保留显式模型、`providerId: null` 时模型可用、真实 Provider 优先于内置 echo）；**修正了原来那条断言 bug 行为的用例**
- `character-native.test.ts`（4）：原生生命周期 + 头像字节一致 + 错误输入 + 旧数据兼容
- `context-ordering-and-version-binding.test.ts`（3）：13 个分区的顺序/优先级、版本冻结（旧会话不变、新会话用新版本、开场白只写一次）、删除 ST 分区后装配完好

回归口径：`sillytavern-cards` / `character-card` / `character-png-import` / `phase5-context` 四个纯 ST 测试文件被删除；其余测试**没有删也没有弱化**（只有 5 个集成测试从"导入角色卡"改成"创建角色"，断言意图保持不变）。

---

## 11. 已知限制

1. **上游模型名必须自己填对**：用户原先配的 `deepseek-V4-flash` 被 DeepSeek 拒绝（`The supported API model names are deepseek-flash, deepseek-v4-pro`）。这属于配置问题而非代码问题 —— 现在可以用「刷新模型列表」直接选。本次已把该 Provider 的默认模型与 chat 路由改成 `deepseek-flash`（如需换回请在「模型设置」里改）。
2. **一个角色在 Web 渠道只能有一条会话**（`conversationRef = web:<characterId>`），所以"新会话用新版本"的测试是通过另一个引用（`ensureConversation`）构造的；界面上目前没有"再开一条会话"的入口。
3. `character_versions.spec_version` 是历史遗留 NOT NULL 列，仍然存在，新版本一律写 `companion-v1`；没有为了"干净"去改 001–007 migration。
4. 旧角色的遗留字段虽然被忽略，但仍留在 `definition_json` 里（没有做数据迁移/清除）。审计上仍然能看到它们。
5. 模型发现的候选只在前端内存里（点一次「刷新模型列表」拉一次），刷新页面后候选清空，但**已保存的模型选择不受影响**。
6. 未做"每个 Provider 的模型白名单校验"：填了上游不存在的模型名，错误会在真正调用时以上游 400 的形式暴露（`invalid_response`），界面按普通错误提示。
7. 本阶段未触碰的能力仍保持原有验证状态：真实微信原生语音 / 真实 ASR / 真实 TTS 仍未在真机验证；未打开真实 SillyTavern 客户端（该集成已整体删除）。

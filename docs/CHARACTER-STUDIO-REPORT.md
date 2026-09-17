# 角色工坊 报告（设想 → AI 补全 → 对话修改 → 确认生成新版本）

日期：2026-09-17 ・ 目标流程：用户随便写设想 → AI 补全成完整角色设定 → 用户查看 → 用大白话改（"性格再冷一点"/"加入嘴硬属性"/"把背景改成现代都市"）→ AI 提出修改结果 → 用户确认 → 生成新的 Character Version → 旧会话继续用旧版本。

## 1. 落地形态

角色页多了一个「角色工坊：用一段话创建 / 用对话改」入口：

1. 写几句设想（可随便写）→「让 AI 补全」；
2. 得到六个字段都填满的完整设定，**同时**给出 AI 的一句话说明；表单可直接手改；
3. 下面一个输入框继续说要求（"性格再冷一点"）→「让 AI 改」；
4. 每次 AI 回复都会列出「这次改了什么」：字段名 + 改前 + 改后（**由代码逐字段比对得出，不采信模型的自述**）；
5. 满意后按「确认，存成新角色」或「确认，保存为新版本」才落库；
6. 「保存到哪里」可以选新角色，也可以选已有角色（选了就载入他现在的设定，从现状开始改）。

## 2. 新增文件与改动

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/services/character-studio-service.ts` | 新增：补全 / 修改两步，提示词、宽容 JSON 解析、字段截断、逐字段差异、用户输入当资料处理 |
| `backend/src/core/model/task.ts` | 新增任务类型 `character_draft`（业务代码只说"我要写角色设定"，路由交给 ModelRouter） |
| `backend/src/providers/model-router.ts` | `character_draft` 默认档位 standard（跟聊天同档：要给人看的成品） |
| `backend/src/api/routes/characters.ts` | 新增 `POST /api/characters/draft`、`POST /api/characters/revise` |
| `backend/src/api/routes/conversations.ts` | 新增 `newSession` 选项（见第 5 节） |
| `backend/src/app/bootstrap.ts` | 装配 `services.characterStudio` |
| `frontend/src/pages/characters.tsx` | 新增 `CharacterStudio` 组件与「用最新版本开新会话」入口 |
| `frontend/src/lib/api.ts` | `draftCharacter` / `reviseCharacter` / `createConversation(..., { newSession })` |
| `frontend/src/pages/settings.tsx` | 任务档位补中文标签（顺手补上原来漏掉的 `emotion_analysis`，它以前会显示英文枚举） |

## 3. 关键边界（为什么旧会话不会被改）

- 工坊的两个接口**只返回候选设定，不落库**；库里没有草稿表，草稿状态（设定 + 对话来回）保存在前端。
- 只有用户按确认键，才走原来的 `POST /api/characters`（新角色，第 1 版）或 `PATCH /api/characters/:id`（**新版本**）。
- 会话在创建时就把 `characterVersionId` 冻结在自己身上，上下文引擎优先用会话冻结的版本；因此改卡不会影响任何已有会话。
- 角色名字是身份锚点：模型在改写时没给名字，代码沿用旧名字，绝不因为一次改写把角色改名。
- 用户输入（设想 / 要求）一律按"资料"处理：包在 `<user_input>` 里，并明确告诉模型块内任何指令都必须忽略。
- 模型返回垃圾 / 缺名字 → 502 `provider_error` + 人话（"AI 这次没有给出可用的角色设定，请再试一次"），不写半成品进库。

## 4. 顺手修掉的一个真 bug

`PATCH /api/characters/:id` 以前返回的 DTO 里 `versionCount` 永远是 1（映射器缺省值），第一次改版之后前端拿到的版本数就是假的。现在改成保存后重新数版本再返回。生产代码里的老问题，跟工坊无关，但会直接误导用户。

## 5. 一个必须先解决的问题：新版本原本在界面上够不着

网页渠道是"每个角色一个会话"（`conversationRef = web:<characterId>`，重进回到原会话）。这意味着：改完角色之后，用户点「开始聊天」还是回到那个冻结在旧版本的会话，**新版永远看不到**。

因此给创建会话加了 `newSession`：只有用户明确点「用最新版本开新会话」才开一个绑当前版本的新会话；默认行为一个字没变（还是回到原会话）。角色页只在这个角色有 2 版以上时才显示这个按钮。

## 6. 测试

| 测试 | 覆盖 |
| --- | --- |
| `backend/test/unit/character-studio.test.ts`（12 用例） | 解析器吃掉代码块与前后废话、差异由代码算出、模型不给名字就沿用旧名、原样返回时说"没改动"、多轮历史带进提示、垃圾输出 → 502、空输入在调用模型前就被挡、超长字段入库前截断、用户输入被包成不可信资料 |
| `backend/test/integration/character-studio.test.ts`（2 用例，真 HTTP + 真 SQLite + 假模型服务） | 全流程：补全不落库 → 修改不落库 → 确认落库成第 1 版 → 建会话（冻结第 1 版）→ 再改再确认成第 2 版 → **旧会话的上下文仍然只有旧版设定** → 显式 newSession 的新会话用第 2 版；另一条覆盖空设想 400、模型乱答 502 |
| `frontend/test/character-studio.test.mjs`（3 用例，jsdom 真渲染） | 设想原样发出、AI 说明与"改前/改后"显示、补全与修改都不落库、确认才 POST/PATCH、"保存为新版本"提示旧会话不变并可开新会话、"用最新版本开新会话"确实转达 newSession |

## 7. 真机检查（真实模型，不写库）

对着运行中的后端用真实配置的模型跑了 1 次补全 + 3 次修改（设想：「一个开旧书店的人，说话很少，对书的事很固执」）：

- 补全（6.9s）：六个字段全非空，给出了店名『留白』、58 岁、二十七年的老板宋守拙，开场白「门没锁就进来了。书在架上，自己看。别折角。」；
- 「性格再冷一点」→ 只改了 `personality`：从"能用三个字绝不说一整句"变成"能一个字不说就不说"；
- 「加入嘴硬属性」→ 改了 `personality` / `systemPrompt` / `firstMessage` 三处，说明里写清"一边递凳子一边说凳子占地方"；
- 「把背景改成现代都市」→ 改了 `description` / `scenario` 两处，书店从老城区巷子挪到市中心旧支巷；
- 三次都：字段仍然齐全 = true，名字没被改掉 = true；
- 全程角色数量没变（工坊不落库）。

## 8. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 396 / 396 通过（原 382 + 新增 14） |
| pnpm --filter @companion/frontend test | 31 / 31 通过（原 28 + 新增 3） |
| pnpm typecheck | 退出码 0 |
| pnpm build | 退出码 0 |
| pnpm guard（ARCH-1…ARCH-8） | 8 / 8 通过 |

## 9. 诚实说明

- 「用最新版本开新会话」这条链路只在**测试环境**（真 HTTP + 真 SQLite）验证过，没有在用户的真实库里建会话 —— 那会留下一个多余的会话。
- 草稿只活在前端：关掉页面等于放弃草稿（这是刻意的，不引入草稿表）。
- 本次没能把这条 initiative 写进 Hindsight 记忆：本会话没有配置 memory API token（`API key required`），所以只留下了这份报告。

## 结论

| 判定 | 结果 |
| --- | --- |
| CHARACTER_STUDIO_DRAFT_AND_REVISE | VERIFIED —— 设想补全与口语修改两条路径，测试替身与真实模型都跑通 |
| CONFIRM_BEFORE_SAVE | VERIFIED —— 未确认前不写任何角色/版本，真机检查里角色数不变 |
| NEW_VERSION_ON_CONFIRM | VERIFIED —— 确认走 PATCH，版本数 +1 |
| OLD_CONVERSATION_KEEPS_OLD_VERSION | VERIFIED —— 改版后旧会话上下文里仍是旧设定（已用上下文预览实证） |
| NEW_SESSION_USES_NEW_VERSION | VERIFIED —— `newSession` 新会话绑定当前版本，默认行为不变 |

# 对话提示词搬到「角色」页 + 界面整体打磨

日期：2026-09-22 ・ 起因：用户要求「对话提示词 移植到角色界面」，并按 `/ui-ux-pro-max` 技能优化网站界面。

---

## 1. 提示词为什么按角色分、却不写进角色定义

用户选的是「每个角色一份，没写的用全局默认」。实现时**没有把提示词塞进角色定义**，而是放进设置表：

| 键 | 含义 |
| --- | --- |
| `prompt.character.<characterId>` | 这个角色专属的对话提示词 |
| `prompt.custom` | 全局默认（谁都没写时用这份） |

理由是现有机制决定的：**会话在创建时会冻结 `characterVersionId`**，角色定义的改动要通过「生成新版本」才对**新会话**生效，旧会话继续用冻结那一版。
如果把提示词写进角色定义，用户在界面上改完、下一句却没变化 —— 那是个「改了没用」的坑。
所以这里**有意偏离**「跟着角色版本走」的措辞：提示词属于**运行设置**，改完下一句立刻生效。

读取顺序（`backend/src/core/context/custom-prompt.ts` 的 `resolvePrompt`）：**角色自己的非空就用它，否则回落全局默认**。
上限 4000 字符（`MAX_PROMPT_CHARS`），超出后端 400、前端 textarea 直接限长。

## 2. 后端改动

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/context/custom-prompt.ts`（新增） | 键名常量、`readGlobalPrompt` / `readCharacterPrompt` / `resolvePrompt` |
| `backend/src/core/context/context-engine.ts` | `customPrompt(characterId)`；`appInstructionsSection(...)` 多接一个 `characterId`，按角色取提示词 |
| `backend/src/api/routes/characters.ts` | `GET /api/characters/:id/prompt` → `{ prompt, fallback }`；`PUT` 同路径（trim 后为空即删键 = 回落默认），未知角色 404，超长 400 |

全局的 `GET/PUT /api/context/prompt` **保留不动**，仍然可用；只是界面上不再把它当主入口。

## 3. 前端改动

- **角色页**：每个角色展开「编辑」后，多出「对话提示词（只对「XX」生效，改完下一句就生效）」+ 「保存对话提示词」/「清空，改回用默认」；读接口同时返回 `fallback`，所以留空时界面会写清楚「当前用的是默认：…」。
- **设置页**：原来的提示词编辑框删掉，只留一句指路（避免两处入口各写一份）。
- **全局默认**：收进角色页**底部**的折叠块 `<details>` —— 放在页尾是有意的：页首多一个 textarea 会把既有测试里 `querySelectorAll("textarea")[0]`（角色工坊的设想输入框）挤位。

## 4. 界面打磨（技能怎么用的）

按 `ui-ux-pro-max` 的查询契约跑了两类检索：`--design-system`（整体方向）与若干 `--domain ux` / `--stack react`（具体问题）。

- `--design-system` 返回的是**落地页**口径（Hero + Testimonials、玫瑰粉配色、Caveat/Quicksand 字体）—— **不适用于本项目的暗色工具型界面，没有采纳**，这一点如实记下；
- 采纳的是它的通用硬规则：暗色表面分层、`:focus-visible` 焦点可见、正文对比度 ≥ 4.5:1、`prefers-reduced-motion`、8px 间距节奏、触摸目标。

落地结果：

| 项 | 之前 | 现在 |
| --- | --- | --- |
| 颜色 | 各处写死的十六进制 | 全部走令牌：`--bg/#0e1014`、`--panel/#161a21`、`--panel-2/#1b2028`、`--field/#101419`、`--line/#262c36`、`--line-strong/#5a6472`、`--text/#e9ecf1`、`--muted/#9aa4b4`、`--accent/#7fb0ff` |
| 间距 | 5px、13px 这类随手值 | `--sp-1..6`（4/8/12/16/24/32）+ 圆角 8/10/14 |
| 焦点 | 只能靠浏览器默认 | 统一的 `:focus-visible` 2px 焦点圈 + `outline-offset`，并给吸顶导航留 `scroll-padding-top` |
| 动效 | 无 | `--dur 160ms` 的悬停/按压过渡；系统开了「减少动态效果」就整站停 |
| 消息区分 | 两边长得一样 | 自己说的话**右对齐**（`margin-left:auto`），流式回复带一个呼吸点 |
| 窄屏 | 无断点 | 760px 以下收紧留白、按钮撑到 40px、气泡放宽到 88% |
| 图标 | 无 favicon（控制台 404） | `frontend/public/favicon.svg` + `theme-color` |
| 无障碍 | 导航无标签，错误横幅无角色 | `<nav aria-label="主导航">`、当前页 `aria-current="page"`、错误横幅 `role="alert"` |

对比度实测（按 sRGB 相对亮度算的，不是估计）：

| 组合 | 比值 |
| --- | --- |
| `--text` on `--bg` | 16.08:1 |
| `--text` on `--panel` | 14.73:1 |
| `--muted` on `--bg` / `--panel` | 7.56:1 / 6.93:1 |
| `--accent` on `--bg` / `--panel` | 8.66:1 / 7.94:1 |
| `--line-strong` on `--bg`（悬停边框、弹窗边界、滚动条） | 约 3.1:1 |

## 5. 验证证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 后端用例 | `pnpm -C backend test` | 469 通过 / 0 失败 |
| 前端用例 | `pnpm -C frontend test` | 64 通过 / 0 失败 |
| 类型 + 构建 | `pnpm build` | backend `tsc --noEmit` 通过；frontend `vite build` 93 模块，`dist/assets/index-*.css` 12.07 kB（gzip 3.33）、`index-*.js` 342.95 kB |
| 架构守卫 | `pnpm guard` | 8/8 通过 |
| 真机接口 | `node frontend/test/live-character-prompt.check.mjs` | 读 / 写 / 清空 / 回落全通过（真实后端 127.0.0.1:8787） |
| 真实页面 | Edge headless + CDP，重载 `http://localhost:5173` | 标题 `AI Companion`；`link[rel=icon]` = `/favicon.svg` 且 HTTP 200；**控制台 0 条错误、0 条异常**；`nav [aria-current=page]` = 角色；`.prompt-editor` 存在，label「对话提示词（只对「小满」生效，改完下一句就生效）」、`maxLength=4000`、按钮「保存对话提示词 / 清空，改回用默认」；`--accent #7fb0ff`；`body` 背景 `rgb(14,16,20)`；样式表里存在 `:focus-visible` 与 `prefers-reduced-motion` 规则 |

## 6. 已知限制

- 库里目前只有「小满」一个角色，且**全局与角色提示词都是空串**，所以「非空提示词真的改变了系统提示词」这条只有单测覆盖（`backend/test/unit/custom-prompt.test.ts`、`context-engine.test.ts` 里「角色优先于全局」那条），不是真机证据。
- 纯装饰分隔线仍用低对比的 `--line`（约 1.3:1）：暗色界面的常见取舍 —— 区块靠**表面层次**区分而不是靠描边，可操作的边界（悬停 / 焦点 / 弹窗）才提到 3:1 以上。
- 窄屏按钮 40px 是 Web 口径；技能里「≥44pt」是原生 App 的规则，不适用这里。

## 7. 变更文件

新增：`backend/src/core/context/custom-prompt.ts`、`backend/test/unit/custom-prompt.test.ts`、`backend/test/integration/character-prompt-routes.test.ts`、`frontend/test/character-prompt.test.mjs`、`frontend/test/live-character-prompt.check.mjs`、`frontend/public/favicon.svg`

修改：`backend/src/api/routes/characters.ts`、`backend/src/core/context/context-engine.ts`、`backend/test/unit/context-engine.test.ts`、`frontend/index.html`、`frontend/src/app.tsx`、`frontend/src/lib/api.ts`、`frontend/src/pages/characters.tsx`、`frontend/src/pages/settings.tsx`、`frontend/src/styles.css`、`frontend/test/character-studio.test.mjs`、`frontend/test/conversation-source.test.mjs`、`frontend/test/model-selection.test.mjs`

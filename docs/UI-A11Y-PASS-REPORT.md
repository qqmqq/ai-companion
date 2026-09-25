# 界面第二轮打磨：控件边界对比度、无障碍语义、表单错误

日期：2026-09-22 ・ 起因：用户要求用 `/ui-ux-pro-max` 再优化一轮界面。上一轮做了令牌化与基础无障碍，这一轮按技能检索出的**具体条目**逐条落地。

## 1. 技能检索了什么，采纳了什么

按查询契约跑了四条 `--domain ux` 检索，每条一个主意图：

| 查询 | 命中的条目 | 是否采纳 |
| --- | --- | --- |
| dark mode surface hierarchy contrast | 正文 4.5:1、标题层级 h1→h2 不跳级 | 已满足（实测最低 6.9:1），无需改 |
| inline validation error message field | **每个非法字段要有一条贴着它的错误**，并用 `aria-describedby` 关联；错误要用 `role="alert"` 播报；错误摘要要能聚焦 | 采纳（角色名称为空这条） |
| empty state first run onboarding | 空状态要有引导文案 + 动作 | 已满足（各页本来就有中文空状态），无需改 |
| loading skeleton progressive disclosure | 加载反馈要配得上下等待时间，并暴露 busy 状态 | 采纳（`aria-busy`） |

另外按技能自己的图标纪律（**不许把 emoji 当结构性图标**）处理了聊天页的两处 emoji。
技能给的落地页口径配色/字体建议依旧不适用本项目，未采纳。

## 2. 改了什么

### 2.1 可操作控件的边界，单独立一个令牌

技能要求「可识别的控件边界至少 3:1」。原来表单/按钮边框和装饰分隔线共用 `--line`（对深色底只有 1.36:1），确实分不出来。现在拆成三个语义：

| 令牌 | 用途 | 实测对比度 |
| --- | --- | --- |
| `--line` | 纯装饰分隔线 | 1.36:1（对 `--bg`） |
| `--line-control` `#5c6675` | 输入框 / 下拉 / 文本域 / 次级按钮 / 会话卡片的静止边框 | **3.00:1**（对 `--panel`）、3.28:1（对 `--bg`）、3.18:1（对 `--field`） |
| `--line-strong` `#7a8698` | 悬停态与弹窗边界 | 4.73:1（对 `--panel`） |

装饰线保持低对比是有意的：区块靠表面层次区分，不靠满屏描边；**可点的东西**才需要看得见的边界。

### 2.2 窄屏触摸目标 40px → 44px

`@media (max-width: 760px)` 里按钮、输入框、会话删除键一并撑到 44px（桌面端保持紧凑 —— 技能里 44pt 是原生 App 的口径，Web 上只在手指场景用）。

### 2.3 emoji 换成内联 SVG

`frontend/src/lib/icons.tsx`（新增）提供 `SpeakerIcon` / `MicIcon`：`currentColor` + `aria-hidden="true"` + `focusable="false"`，语义由旁边可见的文字承担。聊天页的 `🔊 语音` / `🎤 语音消息` 换成了它们（不引入任何图标库依赖）。

### 2.4 聊天记录有了正确的语义

`.messages` 现在是 `role="log"` + `aria-live="polite"` + `aria-label="对话记录"`，流式生成期间该容器 `aria-busy="true"` —— 新消息会被念出来，而正在冒字的半句话不会被逐字念一遍。

### 2.5 表单错误贴在字段上

角色表单的「角色名称」是唯一会挡住提交的规则，以前只有按钮变灰，没有任何解释。现在：先碰过（`onBlur`）才报错，错误是字段下方的一行红字 `.field-error`，字段带 `aria-invalid` 与 `aria-describedby` 指向它；填上名字后错误消失、按钮恢复。提交/保存/改写这类按钮补了 `aria-busy`（只加在自己会变文案的按钮上，`aria-busy` 的含义是「这个元素正在被更新」）。

### 2.6 错误横幅的关闭变成真按钮

原来整条横幅是靠 `onClick` 的 div —— 键盘用户关不掉。现在右侧是一个真的 `button`（`.error-close`），焦点可见、Enter/Space 都能按。

## 3. 验证证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 前端用例 | `pnpm -C frontend test` | **67 通过 / 0 失败**（新增 3 例，见 `frontend/test/ui-form-and-a11y.test.mjs`） |
| 前端类型 | `pnpm -C frontend typecheck` | 通过 |
| 构建 | `pnpm build` | 通过（css 12.54 kB / js 344.23 kB） |
| 架构守卫 | `pnpm guard` | 8/8 通过 |
| 真实页面 | Edge headless + CDP 重载 `http://localhost:5173` | `--line-control` = `#5c6675`；第一个输入框实测 `border-top-color: rgb(92, 102, 117)`；`.field-error` 与 `.visually-hidden` 规则已进样式表；**控制台 0 条错误、0 异常** |

新增的三条用例断言的是行为不是文案：① 没碰过不报错、离开字段后报错并且 `aria-describedby` 指向错误节点；② 填上名字后错误消失、按钮恢复可点；③ 样式表里存在 `--line-control` 令牌、`.field-error`、`:focus-visible`、`prefers-reduced-motion`。（写这条时踩到一个坑：React 的 `onBlur` 走 `focusout` 委托，测试里派发 `blur` 是抓不到的。）

## 4. 已知限制

- 对比度是**算出来的**（sRGB 相对亮度），不是看出来的：本次会话无法查看图片，所以视觉观感没有被人工确认过。
- 装饰分隔线仍是 1.36:1 —— 有意保留，理由见 2.1。
- 窄屏 44px 只在 `max-width: 760px` 生效；桌面端按钮仍 36px。
- 聊天气泡里的两个新图标只有在「消息带语音/TTS 状态」时才会出现，而库里目前没有这类消息，真机页面没渲染到它们（由源代码检索与类型检查覆盖）。

## 5. 变更文件

新增：`frontend/src/lib/icons.tsx`、`frontend/test/ui-form-and-a11y.test.mjs`

修改：`frontend/src/styles.css`、`frontend/src/pages/chat.tsx`、`frontend/src/pages/characters.tsx`、`frontend/src/pages/settings.tsx`、`frontend/src/pages/ds-free-login.tsx`、`frontend/src/app.tsx`、`README.md`

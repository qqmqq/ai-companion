# 公开发布 + 一键安装 + 给 AI 的安装指令

日期：2026-09-22 ・ 起因：用户要求「github 更新清理个人信息并开放；加入一键安装脚本，和发给 AI 让 AI 一键安装的指令」。

## 1. 个人信息清理（先审计，再动手）

审计方式是**扫版本库里的 412 个文件 + 翻历史**，不是凭印象：

| 检查项 | 结果 |
| --- | --- |
| 本机绝对路径（`C:\Users\<名字>\`、`/Users/<名字>/`、`/home/<名字>/`） | 只有一处，且是测试夹具里的占位符 `C:\Users\me\secret.png`（文件名脱敏的用例），不是真路径 |
| 提交者身份 | GitHub 的 noreply 地址（`users.noreply.github.com`），没有真实邮箱 |
| LICENSE 署名 | `Copyright (c) 2026 AI Companion contributors`，不是个人姓名 |
| 邮箱 / 手机号 / 私钥 / 访问令牌（sk- / ghp_ / AIza / AKIA…） | 无真实值；命中的全是测试夹具（`sk-smoke-secret`、`13800138000` 这类一眼假的） |
| `.env` / `backend/data/`（数据库、媒体、主密钥）/ `*.key` / `*.pem` / `*.db` | **历史上从未提交过**（`git log --diff-filter=A` 查过），且都已在 `.gitignore` 里 |
| 文档里出现本机路径或用户名 | 无 |
| 个人角色名（用户自己建的那个角色） | **有**：3 个提交的测试夹具与 2 份报告里出现过真实角色名 |

处理：

1. 把这个角色名换成中性的「阿禾」：`backend/test/integration/character-prompt-routes.test.ts`、`frontend/test/character-prompt.test.mjs`（含 slug）、`frontend/test/ui-form-and-a11y.test.mjs`，以及 `docs/CHARACTER-PROMPT-UI-REPORT.md` 里引用它的两处。现在代码与文档里**不再出现**用户的角色名。
2. 新增 `scripts/pii-scan.mjs`（`pnpm scan:pii`）并**挂进 CI**，让这件事以后不会再靠人盯：扫描本机绝对路径、当前机器用户名、邮箱、手机号、私钥、访问令牌，以及 `.env` / `data/` / `*.key` / `*.db` 这类不该进库的文件；对"一眼假"的测试夹具（重复数字的手机号、含 secret/smoke/test/dummy 的假 key、`@im.bot` 假邮箱）自动豁免，也支持行内 `pii-scan: allow`。

**扫描器的自检**（一个永远通过的检查等于没有检查）：

| 输入 | 结果 |
| --- | --- |
| 造一个样本文件，里面放 `C:\Users\<用户名>\私人\笔记.txt` + 手机号 + `sk-live-…` + 真实邮箱 | **报 4 类、退出码 1** |
| 本仓库（`pnpm scan:pii`） | 通过、退出码 0 |

**没做的一件事，明说**：改写历史。那 3 个旧提交的 diff 里仍然留着那个角色名。要彻底抹掉得重写历史并强推 —— 那会让 issue 里引用的 commit 号（`7ec480c`、`770b6bb` …）全部失效，属于破坏性操作，**等你点头再做**。

## 2. 开放与仓库信息

- 仓库当前状态：**PUBLIC**（`gh repo view` → `visibility: PUBLIC`），MIT 协议；
- 描述更新为涵盖 QQ 渠道与模型可换；补了 9 个 topics（`ai-companion / self-hosted / llm / typescript / react / sqlite / fastify / wechat / ollama`）；
- **匿名访问实测**（不带任何凭据）：`api.github.com/repos/qqmqq/ai-companion` → 200；`raw.githubusercontent.com/…/install.sh` → 200（5998 字节）；仓库页面 → 200；
- CI 里新增一步 `pnpm scan:pii`，公开之后的每次提交都会跑。

## 3. 一键安装

两个脚本，行为一致（Windows `install.ps1` / macOS・Linux・WSL `install.sh`）：

1. 检查 Node ≥ 22.13（低版本直接停，不动用户的 Node）；
2. 装好 pnpm：先 corepack，失败才问要不要 `npm i -g pnpm@10`（`-Yes` 时不问、直接装）；
3. `pnpm install --frozen-lockfile`（失败降级为普通 install）；
4. 按 `.env.example` 生成 `.env`——**已存在就不动**；
5. `pnpm build`；
6. 打印启动方式与"数据只在本机"的说明。

| 参数 | Windows | macOS / Linux |
| --- | --- | --- |
| 不提问 | `-Yes` | `--yes` |
| 只检查环境 | `-Check` | `--check` |
| 跳过构建 | `-NoBuild` | `--no-build` |
| 克隆到指定目录再装 | `-Dir <路径>` | `--dir <路径>` |
| 装完直接启动 | `-Start` | `--start` |

刻意的边界：**不装系统包、不需要管理员权限、不覆盖已有 `.env`、不删任何文件**；不在项目根目录会明确报错并退出 1。

### 实测

| 项 | 结果 |
| --- | --- |
| `bash -n install.sh` | 通过（Git Bash） |
| `install.ps1` 在 Windows PowerShell 5.1 与 PowerShell 7 下 `-Check` | 都通过（脚本带 UTF-8 BOM —— 没有 BOM 时 5.1 会把中文按 GBK 读成乱码并直接解析失败，这个坑踩过并修掉了） |
| 完整安装（`--yes --no-build` / `-Yes -NoBuild`） | 通过：依赖已最新 → 幂等空跑；`.env` 已存在 → 明确报告"保持不动" |
| 在非仓库目录运行 | 两个脚本都给出中文错误并退出 1 |
| 从零引导（下载脚本 → `-Dir` 自动克隆 → 安装 → 构建 → 全量测试） | **通过，退出码 0**（详见下一节） |

### 从零引导实测（模拟一个陌生用户）

在空目录里只做三件事：下载脚本 → 让它自己克隆 → 装：

1. `Invoke-WebRequest` 拉取 `raw.githubusercontent.com/.../install.ps1`（6150 字节，匿名可下载）；
2. `install.ps1 -Dir ...\ai-companion -Yes -NoBuild` → 自动 `git clone` 公开仓库 → 装依赖（190 个包，3.3s）→ 生成 `.env` → 结束，退出码 0；
3. 在这个**全新克隆**里跑 `pnpm build`：通过（vite 构建成功，css 15.42 kB / js 344.65 kB）；
4. 再跑整套 `pnpm test`：**后端 469/469、前端 75/75，退出码 0**。

也就是说公开仓库现在的状态是自洽的：陌生人 clone 下来能装、能构建、能全绿。

### CI 上踩到的一个真坑（已修）

第一版扫描器里有一条"当前机器用户名出现就报"的规则。本地用户名是中文路径里的那个词，所以本地全绿；
但 **GitHub Actions 的 runner 用户名就叫 `runner`** —— 仓库里到处都是 `scheduler-runner.ts`、"runner started" 这类词，
CI 当场红了 20 多条。

处理：删掉这条规则（`C:\Users\<名字>\`、`/Users/<名字>`、`/home/<名字>` 已经被"本机绝对路径"那条规则覆盖，
不需要单独按用户名匹配），并把 `runner`、`root`、`ubuntu`、`vscode` 这类 CI/服务账号加进占位符名单。
教训写在这里：**检查规则本身也要在 CI 环境里跑一遍**，本地绿不等于 CI 绿。

第二个坑小一点但同样真实：邮箱规则重构时漏掉了 GitHub 的 noreply 例外，于是扫描器把**这份报告自己**里
引用的示例路径与 noreply 地址也判成了个人信息（第二次 CI 红）。处理：报告里的示例路径改成
`C:\Users\<用户名>\...` 这种占位写法，noreply 域名加回豁免。顺带说明：扫描器把自己的文档也一起扫，
这点是对的 —— 报告里写真实路径，同样是泄露。

## 3.5 CI 本身的更新

三个 action 升到了仍在维护的大版本（`actions/checkout@v7`、`pnpm/action-setup@v6`、`actions/setup-node@v7`）——
旧版跑在 Node 20 运行时上，GitHub 已开始提示弃用。pnpm 的版本仍然只由 `package.json` 的 `packageManager` 声明
（两处都写会报 `ERR_PNPM_BAD_PM_VERSION`，这是这个仓库早期踩过的）。升级后 CI 依然全绿。

## 4. 给 AI 的安装指令

新增 `INSTALL-WITH-AI.md`：一段可以直接整段复制给 AI 编码助手（Claude Code / Codex / Cursor / Gemini CLI / 任意 agent）的指令。
它要求 AI：检查环境（Node 版本不够就停下来问，不许自己升级）→ 克隆 → 跑一键脚本 → 自检（`typecheck / scan:pii / frontend test`）→ 启动并验证两个地址 → 回报每一步的命令与结果。

指令里写死的禁令：不改源码让安装"通过"、不用管理员权限、不装系统包（需要时先问）、不删/不动已有文件（尤其 `.env` 与 `backend/data/`）、不把任何凭据写进仓库、下载失败不要反复重试。

另外附了：一行懒人版、手动安装对照表、三十秒自检清单、常见问题表（Node 太老 / 没有 pnpm / PowerShell 执行策略 / 端口占用 / 没配模型 / 微信 QQ / 反代 / 镜像加速）、隐私说明。README 的「快速开始」改成"一键安装优先"，并指向它。

## 5. 门禁

| 项 | 结果 |
| --- | --- |
| 后端用例 | **469 / 469**（夹具改名后重跑） |
| 前端用例 | **75 / 75** |
| `pnpm typecheck` / `pnpm build` / `pnpm guard` | 通过 / 通过 / **8/8** |
| `pnpm scan:pii` | 通过 |
| CI | 当前提交的在跑；上两个提交均 success |

## 6. 已知限制

- **macOS / Linux 的一键脚本没有在真机上跑过**（本机只有 Windows）：`bash -n` 语法检查通过、逻辑与 PowerShell 版逐条对应，但真实执行未验证；
- 旧提交里的角色名没清（要清得重写历史，等确认）；
- 一键脚本不替你装 Node，也不装系统包 —— 这是刻意的。

## 7. 变更文件

新增：`install.ps1`、`install.sh`、`scripts/pii-scan.mjs`、`INSTALL-WITH-AI.md`
修改：`package.json`（`scan:pii`）、`.github/workflows/ci.yml`（CI 增加扫描步骤）、`README.md`（一键安装 + 隐私 + 五道门）、三个测试文件与一份报告（角色名 → 阿禾）

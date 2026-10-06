# 让 AI 帮你装（INSTALL-WITH-AI）

这份文档是**给 AI 用的**：把下面那段指令整段复制给任意一个能读写文件、能执行命令的 AI 编码助手
（Claude Code / Codex / Cursor / Gemini CLI / 你自己的 agent 都行），它就会把 AI Companion 装好、跑起来，
并把每一步的结果告诉你。你自己也可以照着做 —— 那就是 [install.ps1](install.ps1)（Windows）
或 [install.sh](install.sh)（macOS / Linux / WSL）。

> 一键脚本和这里的指令都不会：装系统包、要管理员权限、覆盖你已有的 .env、删除任何文件、把密钥写进仓库。

---

## 1. 复制这段（完整版，推荐）

`B`text
请在这台电脑上安装并启动 AI Companion（自托管的 AI 陪伴系统，开源仓库：https://github.com/qqmqq/ai-companion）。

请按下面的顺序做，每做完一步都告诉我：执行了什么命令、结果如何。

1) 检查环境并如实报告：
   - node -v（必须 >= 22.13；低于这个版本直接停下来告诉我，不要自己升级 Node）
   - git --version
   - pnpm --version（没有也没关系，下一步的脚本会自己处理）
2) 选一个安装目录：我指定的目录优先；我没指定的话，用当前目录下的 ai-companion/。
   目录已存在且是 git 仓库就用它，否则执行：
   git clone --depth 1 https://github.com/qqmqq/ai-companion.git <安装目录>
3) 在仓库根目录执行一键安装脚本（二选一，按系统来）：
   - Windows：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes
   - macOS / Linux：bash ./install.sh --yes
   说明：脚本会装依赖、按 .env.example 生成 .env（已存在则不动）、构建。它不需要管理员权限。
4) 安装完成后做一次自检，并把结果贴给我：
   - pnpm typecheck
   - pnpm scan:pii
   - pnpm -C frontend test
   （后端整套 pnpm -C backend test 要跑二十来秒，可以跑；但如果它超过 3 分钟没结束，
     就中断并告诉我"后端测试疑似卡住"）
5) 启动：pnpm dev（后台跑，或另开一个终端窗口），然后确认：
   - 前端 http://127.0.0.1:5173 能打开（HTTP 200）
   - 后端 http://127.0.0.1:8787/api/system/health 返回 JSON 且 status 为 ok
6) 告诉我怎么用：打开 http://127.0.0.1:5173 → 「模型设置」填一个 OpenAI 兼容服务或 Ollama
   （不填也能先跑，有内置占位模型）→ 「角色」建一个角色 → 「聊天」发消息。

硬性要求：
- 不要修改仓库里的任何源码、配置或测试来"让安装通过"；装不上就把原始报错贴给我。
- 不要执行 sudo / 以管理员身份运行；除 Node 本身外，不要安装系统级软件包。如果确实需要，先问我。
- 不要删除、移动、覆盖我已有的任何文件（尤其 .env、backend/data/）。
- 不要把 API Key、密码、手机号之类的凭据写进仓库的任何文件里。
- 如果需要联网下载依赖，先确认网络可用；下载失败就停下来告诉我，不要反复重试。
`B`

---

## 2. 短到一行（懒人版）

`B`text
帮我装好并跑起来 https://github.com/qqmqq/ai-companion ：
先看 node -v 是否 >= 22.13，然后进仓库跑一键脚本
（Windows：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes；macOS/Linux：bash ./install.sh --yes），
接着 pnpm dev，确认 http://127.0.0.1:5173 打开、http://127.0.0.1:8787/api/system/health 是 ok。
不要改源码、不要用管理员权限、不要动我已有的 .env 和 backend/data。
`B`

---

## 3. 不做 AI、自己手动装

`B`bash
# 1. 克隆
git clone https://github.com/qqmqq/ai-companion.git
cd ai-companion

# 2. 一键安装（脚本会检查环境、装依赖、生成 .env、构建）
#    Windows:
powershell -ExecutionPolicy Bypass -File .\install.ps1
#    macOS / Linux / WSL:
bash ./install.sh

# 3. 启动
pnpm dev
`B`

脚本参数（两个平台一一对应）：

| 作用 | Windows | macOS / Linux |
| --- | --- | --- |
| 不提问 | `-Yes` | `--yes` |
| 只检查环境，不做改动 | `-Check` | `--check` |
| 跳过构建 | `-NoBuild` | `--no-build` |
| 克隆到指定目录再装 | `-Dir C:\apps\ai-companion` | `--dir ~/apps/ai-companion` |
| 装完直接前台启动 | `-Start` | `--start` |

---

## 4. 装完自己核一遍（三十秒）

1. `node -v` → 输出 ≥ `v22.13.0`；
2. `pnpm -v` → 输出 `10.x`；
3. 浏览器打开 **http://127.0.0.1:5173** → 能看到界面（顶部导航：角色 / 聊天 / 记忆 / …）；
4. 访问 **http://127.0.0.1:8787/api/system/health** → 返回 `{"status":"ok",...}`；
5. 想确认代码本身没问题：`pnpm typecheck && pnpm test && pnpm build && pnpm guard`。

---

## 5. 出问题先看这里

| 现象 | 原因与处理 |
| --- | --- |
| `Node 版本太低` | 本项目用到原生 TS 类型剥离与 `node:sqlite`，必须 ≥ 22.13。去 https://nodejs.org/ 装 22 LTS 或 24。 |
| `找不到 pnpm` | 脚本会先试 corepack。手动兜底：`corepack enable` 或 `npm i -g pnpm@10`。 |
| PowerShell 说"禁止运行脚本" | 用这一行绕过（只对本次生效）：`powershell -ExecutionPolicy Bypass -File .\install.ps1`。 |
| 端口被占用（8787 / 5173） | 改 `.env` 里的 `COMPANION_PORT`；前端端口用 `pnpm -C frontend dev --port 5174`。 |
| 界面能开但发消息没反应 | 还没配模型。去「模型设置」填一个 OpenAI 兼容服务或 Ollama，再在「任务用哪个模型」里给「日常聊天」选上。 |
| 微信 / QQ 连不上 | 这两条是**可选**渠道，不配也能用网页版。微信要扫码登录，QQ 要 AppID / ClientSecret。 |
| 想省钱用本机反代 | 见 [docs/DS-FREE-API-PROXY.md](docs/DS-FREE-API-PROXY.md)：接入助手会打开真实网页自动抓取所需信息。 |
| 依赖下载很慢 | 换成国内镜像：`pnpm config set registry https://registry.npmmirror.com`。 |

---

## 6. 隐私与安全（值得先读一眼）

- **数据只在本机**：SQLite 数据库、媒体文件、加密主密钥都在 `backend/data/`，不会上传到任何地方；
- 默认只监听 `127.0.0.1`，同局域网的其他机器也访问不到（想对外开就自己改 `COMPANION_HOST`，并想清楚后果）；
- 凭据（模型 API Key、微信/QQ 密钥）以 AES 加密存在本机，主密钥单独存放，日志里会脱敏；
- 仓库公开但**不含任何个人信息**：`pnpm scan:pii` 会扫描版本库里的本机路径 / 邮箱 / 手机号 / 密钥 / 令牌，CI 每次都跑。

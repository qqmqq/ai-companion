# 用自建反代省模型费用：接入 ds-free-api

日期：2026-09-19 ・ 目标：把模型的请求转到自建的 **DeepSeek 网页反代**，不花 API 的钱。

## 1. 那个项目是什么

[`NIyueeE/ds-free-api`](https://github.com/NIyueeE/ds-free-api)（Rust，**GPL-3.0**）：把 DeepSeek 网页端包装成 **OpenAI / Anthropic 兼容**的本地服务。

| 事实 | 值 |
| --- | --- |
| 监听地址 | `http://127.0.0.1:22217`（管理面板 `/admin`） |
| OpenAI 兼容 | `POST /v1/chat/completions`、`GET /v1/models` |
| Anthropic 兼容 | `POST /anthropic/v1/messages` |
| 鉴权 | `Authorization: Bearer <它在管理面板里发的 API Key>` |
| 模型名 | `deepseek-default`（裸名 `default` 等价） |
| 它自己的前置条件 | 需要一个 DeepSeek **网页账号**（邮箱密码 + `device_id`），在它的面板里登录并创建 API Key |

> 本项目**只调用它的 HTTP 接口**，没有复制也没有链接它的代码：所以 GPL-3.0 不会传染到本仓库（本仓库仍是 MIT）。
> 它是第三方非官方项目，稳定性与合规风险由使用者自己承担，见下面「要说清的风险」。

## 2. 三步接上（我们这侧不需要改代码）

### 1) 把反代跑起来

```bash
# 方式 A：下 release 里的可执行文件（Windows / macOS / Linux 都有）
#   解压后直接运行，默认监听 127.0.0.1:22217
# 方式 B：Docker
docker compose -f docker/docker-compose.yaml up -d
```

### 2) 在它的管理面板里配好账号与 Key

1. 打开 `http://127.0.0.1:22217/admin`，首次访问设置管理密码；
2. 在「账号池」里添加 DeepSeek 网页账号（**必须填 `device_id`**，否则登录会被风控拦），然后手动登录一次；
3. 在「配置」里创建一个 **API Key**（形如 `sk-…`），复制出来。

### 3) 在本程序里加一个 Provider 并切过去

「模型设置」页 → 点 **预设：DeepSeek 网页反代（127.0.0.1:22217）** → 粘贴上一步的 API Key → 保存。

然后在「任务用哪个模型」里，把「日常聊天」等任务指向这个 Provider（模型选 `deepseek-default`）。

> ⚠️ **Base URL 千万不要带 `/v1`**：我们的 provider 自己会拼 `/v1/chat/completions` 与 `/v1/models`，
> 写成 `http://127.0.0.1:22217/v1` 会变成 `/v1/v1/...`。这条有专门的用例守着（`frontend/test/ds-free-proxy-preset.test.ts`）。

## 3. 已验证到什么程度（诚实说明）

| 项目 | 状态 |
| --- | --- |
| 反代在本机跑起来 | ✅ 实测：v0.2.11 Windows 版启动，监听 22217，`/admin` 可访问 |
| 我们这个 Provider 打得通 | ✅ 实测：加了指向它的 provider 后，「模型发现」请求打到了它的 `/v1/models`，返回的 401 被**如实显示**（`上游返回 401: invalid api token`），而不是假装成功 |
| 全链路（真实提问 → 反代 → DeepSeek 网页 → 回复） | ⏳ **还没跑**：需要你在它的面板里加一个 DeepSeek 账号并创建 API Key |

验证用的临时 provider 已在验证后删除，你的系统里没有留下测试配置。

## 3.5 不想手动配？用「接入助手」一次点完（打开真实网页 → 你登录 → 自动获取）

日期：2026-09-20 ・ 目的：把上面第 2 步里最麻烦的 `device_id` 与 API Key 变成一次点击。

「模型设置」页 → **接入助手：打开真实网页，自动获取所需**：

1. 点 **打开登录页并自动获取**：本程序在你的机器上开一个**真实的浏览器窗口**（独立 profile，放在 `data/ds-free-browser/`），
   打开 `https://chat.deepseek.com/sign_in`，并通过 Chrome DevTools 协议读取页面上的**设备指纹**（数美 `SMSdk.getDeviceId()`，
   取不到就退到 localStorage 里像设备号的键）。这个设备指纹就是 ds-free-api 登录必需的 `device_id`。
2. 拿到设备指纹后**自动收尾**，不用你再动手：
   - **自动关掉那个浏览器窗口**（走 CDP 的 `Browser.close`，不是粗暴 kill）；
   - **自动把反代跑起来**（没在跑的时候）：在 `data/ds-free-api/`、环境变量 `COMPANION_DS_FREE_BIN`、上次你填的路径、
     以及常见下载位置里找那个可执行文件；找到就替你启动，并等它 `/health` 就绪（最多 20 秒）。
     找不到会如实告诉你去哪儿下（就是上面那个开源项目），面板上会多出一栏让你填一次路径，填了就记住；
   - **自动把模型加进「已配置的模型」**：建好 provider `ds-free-proxy`（`baseUrl = http://127.0.0.1:22217`，模型 `deepseek-default`）。
     这一步先不写密钥（那时还不知道），所以它会**先处于停用状态** —— 免得任务被路由到一条打不通的 provider 上；
     点「一键写入」补上密钥时会自动启用。
3. 回到本页填三样：DeepSeek 账号（**邮箱或手机号都行**）、DeepSeek 密码、**反代管理密码**（`/admin` 的密码；没设过就用你填的这个设上）。
   - 手机号账号会自动写成反代要的 `mobile` + `area_code`；填错字段会被反代当成用户名错误（`PASSWORD_OR_USER_NAME_IS_WRONG`），
     表现却是"生成超时"—— 所以这里替你分清楚了。之前错写进 `email` 的那条会在下次写入时就地改掉，不留僵尸账号。
4. 点 **一键写入并配好 provider**，本程序会：
   - 登录（或首次设置）反代管理面板；
   - 把账号（邮箱 + 密码 + `device_id`）写进反代账号池；
   - 在反代里创建一把本程序专用的 API Key（描述为「AI Companion（本机）」）；
   - 写入反代配置并让它热重载；
   - 把密钥补到那条 provider 上（密钥只进本机加密库，界面只回掩码）；
   - **当场真打一次请求**（只生成 1 个 token）验证账号能不能用：通了写「已实测一次真实请求：通」，
     不通就把原因原样写出来（账号密码不对 / 账号池无可用账号 / 限流）—— 不用等你聊天时撞上一句"超时"。
5. 完成后去「任务用哪个模型」把要用的任务指到它。

> 反代程序本身是开源项目 [NIyueeE/ds-free-api](https://github.com/NIyueeE/ds-free-api)（GPL-3.0）。
> 本项目**不打包、不下载、不修改**它，只在你机器上找到它并调用它的 HTTP 接口；界面上也写明了这一点。

接口（都是本机 HTTP）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/integrations/ds-free/start` | 开真实浏览器并开始自动获取（幂等：已在等就返回当前状态）；可带 `binaryPath` 告诉它反代程序在哪 |
| GET | `/api/integrations/ds-free/status` | 当前阶段、设备指纹、窗口有没有自动关、反代是不是我们起的、模型加没加；**不含任何密钥字段** |
| POST | `/api/integrations/ds-free/stop` | 停止等待并清空本轮的抓取状态 |
| POST | `/api/integrations/ds-free/apply` | 一键写入（账号池 + API Key + provider），只回掩码 |

**纪律与边界**（代码注释里写了，也有用例守着）：

- 密码只在这一次请求里使用，**不落库、不进日志**；回给界面的只有掩码（`sk-dsfree-01…cdef` 这种）；
- 设备指纹是唯一硬门槛：没拿到就不允许写入，并明确提示「先点打开登录页并自动获取」；
- 找不到 Chrome/Edge 时如实报错，可以用环境变量 `COMPANION_BROWSER_PATH` 指定浏览器可执行文件（**指定了就只用它**，不会再偷偷开系统里的 Chrome）；
- 浏览器 profile 独立于你日常用的浏览器，窗口关掉不影响已经拿到的设备指纹；
- 反代程序的**工作目录固定在我们的数据目录**里（`data/ds-free-api/run/`），它自己的 `config.toml` 与日志都落在那里，不会写进代码仓库；
- 一个能用的模型都没有时，「任务用哪个模型」这一页**照样打得开**：路由接口返回 `resolved: null` + 一句中文原因（去加 Provider / 用接入助手），不再整页 500。

### 已验证到什么程度

| 项目 | 状态 |
| --- | --- |
| 抓取逻辑（页面表达式 → 设备指纹 → 状态提示） | ✅ 单元用例：空值/占位值/超长值一律当没拿到，未知状态不显示 `undefined` |
| 一键写入全链路 | ✅ 集成用例：对**反代管理 API 的测试替身**跑完整流程（首次设密码 / 密码错 / 账号已存在 / 密钥复用 / 没指纹不许写），断言写进反代的账号含 `device_id`、密钥只有一把、provider 配置正确 |
| 接口层 | ✅ 用例：状态接口不含 `password/apiKey/token` 任何字段；没指纹时一键写入返回中文可操作提示；管理密码过短在入口拦截 |
| 界面 | ✅ 用例：阶段文案中文化、未知阶段不显示 `undefined`、密码提交后立刻清空且页面不回显；面板上标明反代来源是开源项目并给出链接 |
| 抓完自动收尾（关窗 → 起反代 → 加模型） | ✅ **真机实测**：调一次 `/start`，真实 Chrome 打开登录页 → 设备指纹拿到 → 窗口自动关闭（系统里已无带调试端口的 Chrome 进程）→ 反代被自动拉起（22217 开始 LISTEN，`config.toml` 落在 `data/ds-free-api/run/`）→ `ds-free-proxy` 出现在 `/api/providers` 里（模型 `deepseek-default`） |
| 真实页面抓取（本机 Chrome 打真实 DeepSeek 登录页） | ✅ **实测**：本机 Chrome 无头启动 → CDP 读 `https://chat.deepseek.com/sign_in` → `hasSmsdk: true`，`SMSdk.getDeviceId()` 返回 88 字符指纹；同一页面的 localStorage 里也能看到 `deepseek-device-id:chat`、`smidV2` 这类键 |
| 反代管理协议（对 v0.2.11 真实进程） | ✅ **实测**：`/health` 可达；首次 `ensureAdminToken` 走 403→`/admin/api/setup` 设上密码；`GET/PUT /admin/api/config` 结构确认为 `server / ds_core / proxy / admin / api_keys`；写进去的账号（含 `device_id`）与 API Key 都持久化成功，重复加同一邮箱不会变成两条 |
| 生成的 Key 真的能用 | ✅ **实测**：用上面写进去的 Key 请求反代 `/v1/models` → 200，返回 `deepseek-default` |
| 真实 DeepSeek 账号走完一轮对话 | ⏳ **还没跑**：需要你填自己的 DeepSeek 邮箱与密码（我不该也不会有你的账号）；填完点一次「一键写入」即可 |
| 界面上真的点过按钮（真窗口的可视化确认） | ⏳ 组件级用例 + Vite 开发服务器实编译通过；本机浏览器里的目视确认留给你 |

> 注：上面「真机实测」是直接调接口跑的流程（等价于点按钮），不是我替你在浏览器里点了一遍。
## 4. 要说清的风险（别只看省钱）

- **非官方**：它依赖 DeepSeek 网页端的行为，对方改版就可能失效；本项目与它没有任何关系；
- **合规**：用网页端账号给 API 供能可能违反 DeepSeek 的服务条款，请自行判断；
- **稳定性**：网页端有风控、限流、掉登录，反代挂了会直接影响聊天（我们的 provider 会把错误如实上报，不会静默降级到别的模型）；
- **数据经过第三方进程**：你的对话会先发给本机这个反代，再由它转发；**密钥与对话不出本机**（反代跑在 127.0.0.1），但仍建议只用它跑非敏感内容；
- **GPL-3.0**：只调用接口没问题；**不要**把它的代码拷进本仓库。

## 5. 想省点又不折腾的替代方案

- 按任务分档：只把「记忆抽取 / 情绪分析 / 上下文压缩 / 角色设定」这类**便宜档**任务转到反代或本地 Ollama，聊天仍走正式 API（`模型设置 → 任务用哪个模型`）；
- 本地 Ollama：完全离线、零费用、零合规风险，代价是质量与速度（`类型` 选 Ollama 即可）。

## 6. 想切回来

把「任务用哪个模型」改回原来的 Provider 即可；反代那个 Provider 可以直接删掉（密钥随之从本机加密库里删除）。

## 结论

| 判定 | 结果 |
| --- | --- |
| PRESET_ADDED | VERIFIED —— 「模型设置」一键预设，baseUrl 不带 `/v1`（有用例守住） |
| WIRING_VERIFIED | VERIFIED —— 真机：provider → 反代 `/v1/models` 打通，上游 401 如实上报 |
| REAL_PAGE_CAPTURE | VERIFIED —— 本机 Chrome 打真实登录页，设备指纹成功取出 |
| ADMIN_PROTOCOL | VERIFIED —— 对真实 v0.2.11 进程完成「首次设密码 → 写账号+Key → 读回 → 生成的 Key 能调 /v1/models」 |
| ACCOUNT_KIND | VERIFIED —— 邮箱/手机号分别写成 `email` 与 `mobile`+`area_code`（单测 7 例 + 集成用例）；被错写进 `email` 的手机号会就地改掉 |
| POST_WRITE_CHECK | VERIFIED —— 一键写入后当场真发一次请求，通/不通直接写在界面上 |
| AUTO_FINISH | VERIFIED —— 抓完自动关窗、自动拉起反代、自动把模型加进「已配置的模型」（真机实测） |
| END_TO_END_PENDING | PENDING —— 你填自己的 DeepSeek 账号后点一次「一键写入」即可闭环 |
| NO_CODE_COPIED | VERIFIED —— 只调用 HTTP 接口，未复制/链接 GPL-3.0 代码 |

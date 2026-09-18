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
| END_TO_END_PENDING | PENDING —— 需要你配置 DeepSeek 网页账号与 API Key 后才能真跑一轮 |
| NO_CODE_COPIED | VERIFIED —— 只调用 HTTP 接口，未复制/链接 GPL-3.0 代码 |

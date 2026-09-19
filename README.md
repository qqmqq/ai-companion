# 🤖 AI Companion

**一个真正记得你、也会主动找你的 AI 陪伴系统 —— 自托管、可换模型、渠道可插拔。**

[![CI](https://github.com/qqmqq/ai-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/qqmqq/ai-companion/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](pnpm-workspace.yaml)
[![Tests](https://img.shields.io/badge/tests-496%20passing-brightgreen)](#-验证)
[![Arch Guards](https://img.shields.io/badge/%E6%9E%B6%E6%9E%84%E5%AE%88%E5%8D%AB-8%2F8-blue)](#%E6%9E%B6%E6%9E%84%E7%A1%AC%E5%AE%88%E5%8D%AB)

> 不是一个"聊天框套壳"，而是一套完整的陪伴系统：**角色有版本、关系有历史、情绪会变化、说过的事会真的被记住并兑现。**

📌 **历史缺陷与设计记录都在 [Issues](https://github.com/qqmqq/ai-companion/issues?q=is%3Aissue) 里**：每条都写着现象、根因、修复与证据（含真机验证方式），已修的关闭并标注对应文档，未完成的保持打开。

---

## 📖 About · 关于项目

### 它解决什么问题

现有陪聊工具的通病，几乎都在这三件事上翻车：

| 痛点 | 常见表现 | 本项目怎么做 |
| --- | --- | --- |
| **记不住** | 聊到第十轮就忘了你是谁、答应过什么 | 记忆 + 关系 + 情绪三层长期状态，全部落 SQLite（FTS5 检索），每轮按优先级装配进上下文 |
| **不算数** | 说"我 12 点提醒你"，其实什么都没建 | 自然语言 → 结构化动作 → **真的写库**，并注入事实回执；没建成时角色必须说实话，绝不假确认 |
| **不主动** | 永远只有你先开口，关系不会自己长 | 定时提醒与主动消息共用一条链路，到点由**角色用自己的语气**把它说出来 |

另外两个"给自己用"的硬要求：**核心不绑定任何聊天平台**（渠道只是可替换的适配层），以及**模型可换**（OpenAI 兼容 / Ollama / 内置离线占位模型）。

### 为什么开发它

- 想清楚"**长期关系**到底该怎么建模"：关系是慢变量（六维 + 阶段 + 里程碑 + 变化流水），情绪是快变量（半衰期衰减），两者绝不混为一谈；
- 想让 AI 说的每句话**都可追溯**：每个决定（发/不发、为什么）都有决策记录，每个角色版本都能查到会话冻结在哪一版；
- 想验证"**架构守卫**能不能真的挡住腐化"：8 条自动化守卫（见下）让 Core 保持对平台一无所知。

---

## ✨ Key Features · 核心特性

- 🎭 **角色工坊：几句设想 → 完整人设 → 对话式改卡**
  随手写「一个开旧书店的人，说话很少」，AI 补全成完整设定；接着说「性格再冷一点」「加入嘴硬属性」就能改。每次改动都由代码逐字段比对给出**改前/改后**，**只有你按确认才会生成新版本**；旧会话继续用它创建时冻结的那一版。

- 🧠 **三层长期状态：记忆 / 关系 / 情绪**
  记忆带重要度、置信度、来源与作用域；关系有熟悉度、信任、好感、亲密、尊重、依赖六维 + 阶段 + 里程碑；情绪有 valence/arousal/半衰期，会自己回落。每次变化都留下可解释的流水。

- 📅 **说人话就真的办事：事件 / 任务 / 定时提醒**
  一句「今天大概中午12点吧，提醒我去找我朋友」→ 意图解析 → 真正写入 `scheduled_jobs` 并到点投递。解析失败会**问清楚**而不是静默；建不成的动作绝不允许角色假装成功。

- ⏰ **主动找你，而且像它自己说的话**
  定时提醒与主动消息复用同一条上下文链路（人设 + 记忆 + 关系 + 情绪一起进提示词），到点说出来的是角色口吻的话，而不是把记录原文念一遍。自主等级、静音时段、每日上限、冷却都能配。

- 🔌 **渠道可插拔，模型可换**
  网页（内置）+ 微信（可选模块，含图片/文件/视频/语音的加解密与编解码）+ QQ（可选模块，私聊与群聊 @）。LLM / ASR / TTS 都走同一套 Provider 注册表，任务档位（chat / 记忆抽取 / 情绪分析 / 角色设定…）可以分别选不同模型。

- 💸 **接入助手：开一次真实网页，剩下的自动做完（可选，省钱用）**
  点一下会打开真实的浏览器窗口进入 DeepSeek 登录页，自动读出反代登录必需的设备指纹，然后**自动关窗 → 自动把你本机的 [ds-free-api](https://github.com/NIyueeE/ds-free-api) 反代跑起来 → 自动把模型加进「已配置的模型」**；你只需填账号密码，一键写入后就当场真发一次请求告诉你通不通。
  （反代是别人的 GPL-3.0 开源项目：本项目不打包、不下载它，只调用它的本机接口，见 [NOTICE](NOTICE) 与 `docs/DS-FREE-API-PROXY.md`。）

- 🛡️ **8 条架构硬守卫，越界即失败**
  不是文档里的口头约定，而是 CI 里真跑的测试（见「架构硬守卫」）。

---

## 🧱 Tech Stack · 技术架构

| 层次 | 选型 |
| --- | --- |
| **语言** | TypeScript（Node 24 原生类型剥离，`.ts` 直接运行，**无构建步骤**） |
| **后端** | [Fastify 5](https://fastify.dev/) · [zod](https://zod.dev/) 校验 · `node:sqlite`（WAL + 外键） · `silk-wasm`（微信语音 SILK 编解码） |
| **前端** | React 19 · Vite 6 · 原生 CSS（无 UI 框架依赖） · 界面全中文 |
| **工程** | pnpm workspace（`backend` / `frontend` / `scripts`） · `node:test`（后端 441 例 / 前端 55 例） |
| **架构** | 六边形：`core/`（model · ports · services · context · memory）+ 渠道适配层；组合根 `app/bootstrap.ts` 是唯一装配点 |
| **模型** | OpenAI 兼容 / Ollama / 内置 echo 占位；ModelRouter 按任务档位选 Provider + Model，失败可解释 |
| **存储** | SQLite（迁移脚本 + FTS5 中文检索） · 本地媒体存储（凭据 AES 加密，密钥单独存放） |

### 目录结构

```text
backend/src/
├── app/         组合根：配置、脱敏日志、事件总线、bootstrap、HTTP 服务器
├── api/         路由与 DTO（characters / conversations / timeline / scheduler / proactive …）
├── core/        Companion Core：model / ports / services / context / memory（不认识任何平台）
├── channels/    渠道适配层（web 内置；weixin / qq 为可选模块，删掉目录也能构建）
├── integrations/ 外部集成（ds-free 反代接入助手：找程序、起进程、读页面设备指纹）
├── providers/   LLM / ASR / TTS Provider + ModelRouter + TaskLLM
├── security/    加解密、密钥来源、脱敏、不可信内容包装
├── storage/     SQLite、迁移、仓储实现、FTS5 检索
└── util/        纯工具
frontend/        React + Vite（角色 / 聊天 / 记忆 / 关系与情绪 / 事件与任务 / 主动消息 / 微信 / QQ / 模型设置·接入助手）
scripts/         开发脚本（同时起前后端）
docs/            各阶段交付报告与故障复盘
```

### 架构硬守卫

| 守卫 | 含义 |
| --- | --- |
| ARCH-1 | `src/core` 不出现任何具体平台字样 |
| ARCH-2 | `src/core` 只依赖 `core/` 与纯 `util/` |
| ARCH-3 | 只有组合根 `app/bootstrap.ts` 可以依赖具体渠道实现 |
| ARCH-4 | `channels/` 之外不得出现渠道专有标识 |
| ARCH-5 | 依赖清单中不得出现 openclaw 或任何渠道 SDK |
| ARCH-6 | Core 不依赖任何第三方运行时包 |
| ARCH-7 | 复制 src、删掉 `channels/weixin`、跑真实 tsc —— 构建不破 |
| ARCH-8 | `channels/` 目录清单必须与已注册渠道一致 |

---

## 🚀 Getting Started · 快速开始

### 前置条件

- **Node.js ≥ 22.13**（推荐 24.x；本项目依赖原生 TypeScript 类型剥离与 `node:sqlite`）
- **pnpm 10**（`corepack enable pnpm` 或 `npm i -g pnpm@10`）
- 可选：一个 OpenAI 兼容服务或 Ollama（不配也能跑，内置占位模型保证链路可用）

### 1. 克隆与安装

```bash
git clone https://github.com/qqmqq/ai-companion.git
cd ai-companion
pnpm install
```

### 2. 配置（可选）

```bash
cp .env.example .env    # 默认配置即可直接跑，端口 8787
```

### 3. 启动

```bash
pnpm dev               # 同时启动后端(8787) 与前端(5173)
```

打开 **http://127.0.0.1:5173**，然后：

1. **模型设置** → 填 OpenAI 兼容服务或 Ollama（Base URL + 模型 + API Key）→ 保存 → 「测试连接」；再到「任务用哪个模型」为「日常聊天」选 Provider 与 Model（支持自动发现，也可手填）；
   （想省钱也可以直接用页面上的 **接入助手**：打开真实网页自动获取所需 → 一键写入 → 自动配好本机 DeepSeek 网页反代，详见 `docs/DS-FREE-API-PROXY.md`）
2. **角色** → 「角色工坊：用一段话创建」写几句设想，让 AI 补全人设 →「确认，存成新角色」；
3. **聊天** → 发消息（流式），可点「查看上下文」看这一轮模型到底看到了什么；
4. 试试自然语言：「**明天中午12点提醒我去开会**」→ 到点会由角色用自己的语气提醒你；
5. **关系与情绪 / 事件与任务 / 主动消息** 三页可以看长期状态、承诺与提醒、以及它什么时候会主动开口。

### 4. 验证

```bash
pnpm typecheck     # 全量类型检查
pnpm test          # 后端 441 例 + 前端 55 例（单元 / 集成 / 架构守卫）
pnpm guard         # 只跑 8 条架构硬守卫
pnpm build         # 后端类型检查 + 前端产物构建
pnpm --filter @companion/backend smoke   # 冒烟：聊天 / 记忆 / 上下文
```

> 微信渠道为可选模块：不配置账号时整个系统照常运行，只是没有微信这条通路。

---

## 🤝 Contributing · 贡献指南

欢迎 Issue 与 PR。几条让合入变快的约定：

1. **先开 Issue 说清要解决什么**，避免大改动方向不一致；
2. Fork → 建分支（`feat/xxx` / `fix/xxx`）→ 改动请**带上能复现问题的测试**（后端 `backend/test/`，前端 `frontend/test/`）；
3. 提交前必须过四道门：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm guard`；
4. **不要绕过架构守卫**（ARCH-1…8）：它们不是风格偏好，而是这个项目的存在理由；
5. 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` `fix:` `docs:` `refactor:` `test:` `chore:`）；
6. **绝不要提交** `.env`、`backend/data/`（含数据库、媒体与主密钥）或任何真实凭据/聊天记录 —— 这些已在 `.gitignore` 中。

---

## 📄 License · 开源协议

本项目以 **MIT License** 发布，详见 [LICENSE](LICENSE)。

第三方声明见 [NOTICE](NOTICE)：微信渠道参考腾讯公开文档化的 `Tencent/openclaw-weixin`（MIT）**协议事实**，未复制源码、未依赖其运行时；
「接入助手」支持的本机反代 [ds-free-api](https://github.com/NIyueeE/ds-free-api) 是第三方 **GPL-3.0** 项目 —— 本项目只调用它的 HTTP 接口，**不打包、不下载、不修改**它的代码。

---

<div align="center">

**AI Companion** · 自己搭、自己用、自己看着它把人记住。

</div>

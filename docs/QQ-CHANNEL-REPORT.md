# QQ 渠道接入报告

日期：2026-09-17 ・ 参考：`tencent-connect/openclaw-qqbot`（OpenClaw 的 QQ 插件，MIT）

## 1. 做法：抄协议事实，不抄代码、不引依赖

那个仓库是 **OpenClaw 的渠道插件**，底层用腾讯官方 `@tencent-connect/qqbot-nodejs`。本项目是独立系统、明确不做 OpenClaw 插件，
所以按微信渠道同样的纪律处理：**只取公开文档化的协议事实，自己实现一层 `channels/qq/`**。

取到的协议事实（对照官方 Bot API v2 与官方 SDK 源码逐条确认）：

| 环节 | 事实 |
| --- | --- |
| 取凭证 | `POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` → `{access_token, expires_in}`（默认 7200 秒） |
| 调用鉴权 | 请求头 `Authorization: QQBot <access_token>` |
| 正式/沙箱域名 | `https://api.sgroup.qq.com` / `https://sandbox.api.sgroup.qq.com` |
| 网关地址 | `GET /gateway` → `{url}`（wss） |
| 网关协议 | op10 HELLO → op2 IDENTIFY `{token:"QQBot <t>", intents, shard:[0,1]}`；op1 心跳；op6 RESUME；op0 DISPATCH（带 `t`/`s`/`d`）；op11 心跳回应 |
| 事件位 | 群聊/单聊消息 `1<<25`（GROUP_AND_C2C）、按钮交互 `1<<26`；频道消息 `1<<30`、私信 `1<<12` |
| 入站事件 | `C2C_MESSAGE_CREATE`（私聊）、`GROUP_AT_MESSAGE_CREATE`（群 @） |
| 发送 | `POST /v2/users/{openid}/messages`、`POST /v2/groups/{group_openid}/messages`，body `{content, msg_type:0, msg_id?, msg_seq?}` |
| 被动回复 | 带触发消息的 `msg_id` 表示"回复刚收到的这条"；同一条消息多次回复要递增 `msg_seq` |

**没有引入任何新依赖**：网关 WebSocket 用 Node 22+ 内置的 `WebSocket`，HTTP 用内置 `fetch`。

## 2. 实现（`backend/src/channels/qq/`）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 平台概念只在这一层出现（ARCH-4） |
| `config.ts` | appId / 沙箱开关 / 域名覆盖放 settings；**clientSecret 只进加密凭据库** |
| `auth/token-manager.ts` | 取 token + 缓存 + 提前 5 分钟刷新 + **单飞**（并发只取一次） |
| `gateway/gateway.ts` | WebSocket 生命周期：HELLO→IDENTIFY/RESUME→心跳→DISPATCH；掉线按 1s/2s/5s/10s/30s/60s 退避重连；4004 视为鉴权失败并**停止重连** |
| `receiver/inbound-mapper.ts` | 事件 → `InternalMessage`；会话引用 `c2c:<openid>` / `group:<openid>`；去掉 `<@!bot>` 前缀 |
| `sender/sender.ts` | REST 发送；有触发消息就带 `msg_id`+递增 `msg_seq`，没有就是主动推送 |
| `session-state.ts` | 连接状态机（未配置/未连接/连接中/已连接/重连中/凭证无效/已停止） |
| `channel.ts` | ChannelAdapter：start/stop/health/listAccounts/onInbound/send + 管理控制面 |
| `routes.ts` | `/api/channels/qq/status`、`PUT /config`、`/reconnect`、`/disconnect`、`DELETE /credentials` |
| `index.ts` | 渠道模块（被组合根**运行时发现**，删掉整个目录也不影响其它部分 —— ARCH-7） |

前端加了「QQ」页：填 AppID / ClientSecret（密码框）、沙箱开关、保存并连接 / 重连 / 断开 / 清密钥，连接状态全是中文。

当前能力边界（如实写在 `capabilities` 里）：**只支持文本**；私聊与群聊 @ 都通；图片/语音/文件/按钮/流式还没接。

## 3. 测试（7 个后端用例 + 3 个前端用例）

后端用「mock QQ 服务（真 HTTP）+ 假 WebSocket（不引依赖）」驱动整条链路：

1. 没配置时不连网关，状态如实说「还没配置」，一次 token 都不取；
2. 配好后：取 token → 带鉴权拿网关地址 → **IDENTIFY 帧逐字段核对**（`QQBot <token>` 形式、intents 含 `1<<25`、`shard [0,1]`）；
3. 私聊事件 → 内部消息（引用 `c2c:<openid>`、`@` 前缀被去掉）→ 回复走 `/v2/users/<openid>/messages` 且带 `msg_id`/`msg_seq`；
4. 群聊 @ → 走群接口，同一条消息两次回复的 `msg_seq` 递增（否则平台会去重）；
5. 主动消息（没有入站记录）→ **不带** `msg_id`，不假装被动回复；
6. 网关 4004 → 停止重连、如实报「鉴权失败」、不反复取 token；
7. **密钥只进不出**：状态对象里不含 `clientSecret` 也不含 `access_token`。

## 4. 修掉的一个真 bug

token 单飞标记设在了 `await` 之后：一次连接同时要「网关地址」和「token」，两个并发调用都能通过判空检查，**token 接口被打两遍**。
测试先抓到的（断言 token 只取一次），已改成先占住 Promise 再 await。

## 5. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 421 / 421 通过（新增 7） |
| pnpm --filter @companion/frontend test | 44 / 44 通过（新增 3） |
| pnpm typecheck / build / guard | 0 / 0 / 8 通过（ARCH-1…8 全过） |

## 6. 要跑通还需要你做的

1. 到 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿到 **AppID** 与 **ClientSecret**；
2. 在机器人后台开通「私聊」「群聊」相关权限（沙箱环境也能先测）；
3. 打开网页端「QQ」页 → 填 AppID + ClientSecret（没上线就勾沙箱）→「保存并连接」；
4. 用 QQ 私聊机器人，或在群里 @它 —— 消息会走同一条 Core 链路（记忆、关系、情绪、定时提醒都一样生效）。

我没有替你注册机器人，也没有任何可用凭证，所以**真机验证需要你填完凭证后发一条消息**；
在此之前，链路的正确性由上面 7 个用例（真 HTTP + 假网关）保证。

## 结论

| 判定 | 结果 |
| --- | --- |
| QQ_PROTOCOL_IMPLEMENTED | VERIFIED —— 取凭证 / 网关 / IDENTIFY / 心跳 / 事件 / 发送全部按官方 v2 协议实现，零新依赖 |
| ARCHITECTURE_RESPECTED | VERIFIED —— 平台概念只在 channels/qq 内；ARCH-1…8 全过；删除该目录不影响其它部分 |
| TEXT_CHANNEL_WORKS | VERIFIED —— 私聊与群 @ 的入站→回复链路有端到端用例（含被动回复配额字段） |
| CREDENTIALS_SAFE | VERIFIED —— 密钥只进加密库，接口与日志都不回显（有用例断言） |
| LIVE_QQ_PENDING | PENDING —— 需要你的 AppID / ClientSecret 才能真机验证 |

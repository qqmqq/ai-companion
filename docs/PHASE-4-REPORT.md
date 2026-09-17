# Phase 4 开发报告：独立 Weixin Channel（文字消息基础通道）

> 状态：**已完成**。严格遵守 Phase 1–3 既有架构，未重写 Core，未引入 OpenClaw Runtime / Plugin SDK / 任何 OpenClaw 依赖，
> 未实现媒体（图片/语音/视频/文件/CDN/Silk/OCR）——那些留给 Phase 4.5。
> 依赖方向保持：`Core ← ChannelAdapter ← WeixinChannel ← 微信 iLink API`。

## 1. 修改/新增文件

### 新增：渠道本体（`backend/src/channels/weixin/`，22 个文件）
| 文件 | 作用 |
| --- | --- |
| `protocol/types.ts` | 线上类型与常量（item/type/state 码、-14、QR 状态、消息结构）；uint64 一律 string |
| `protocol/endpoints.ts` | 端点路径、API/CDN 基址、QR bot_type |
| `protocol/identity.ts` | iLink-App-Id、客户端版本 0x00MMNNPP、bot_agent 净化 |
| `protocol/lossless-json.ts` | **uint64 无损解析**（解析前给 message_id/msg_id/svr_id 加引号） |
| `protocol/headers.ts` | 公共头 + 鉴权头 + `X-WECHAT-UIN`(base64 十进制 uint32) + base_info |
| `protocol/http-client.ts` | fetch 封装：超时、外部中止、错误分类；GET 不带鉴权头 |
| `protocol/errors.ts` | WeixinTransportError（network/timeout/aborted/http/invalid_response/business/stale_token） |
| `protocol/backoff.ts` | 指数退避 + 抖动 + 可中止 sleep |
| `auth/account-secret.ts` | 账号机密（botToken/baseUrl/userId/**contextTokens**）走 Phase 1 CredentialStore 加密保存 |
| `auth/session-state.ts` | 账号运行状态机 + `-14` 失效标记（sticky） |
| `auth/qr-login.ts` | QR 登录状态机：8 类协议状态 + 刷新预算 + 验证码 + 重定向 |
| `receiver/cursor-store.ts` | **两阶段游标**：savePending → commit（复用 `channel_cursors` 表） |
| `receiver/dedup-store.ts` | 消息幂等表（复用新增的通用表 `channel_message_ids`，ID 存字符串） |
| `receiver/inbound-mapper.ts` | 线上消息 → InternalMessage（只映射文字 + 引用文本，媒体明确 skip） |
| `receiver/long-poll.ts` | 长轮询主循环：两阶段游标、失败语义、退避重连、-14 停止 |
| `sender/sender.ts` | sendmessage：单 item、client_id 幂等、限额重试 + 退避抖动 |
| `channel.ts` | WeixinChannel：实现既有 `ChannelAdapter` + 登录/账号管理/健康 |
| `routes.ts` | 渠道自己的管理接口（登录、状态、账号） |
| `index.ts` | 渠道模块入口（运行时被发现，组合根不 import 它） |

### 新增：框架侧（保持 Core 与平台无关）
| 文件 | 作用 |
| --- | --- |
| `core/ports/channel-module.ts` | **可选渠道模块契约**（kind / createChannel / registerRoutes）+ 最小 SQL 句柄类型 |
| `app/channel-loader.ts` | 运行时在 `channels/` 目录里**发现**渠道模块（无静态 import → ARCH-7 真隔离） |
| `storage/migrations/004_channel_message_ids.sql` | 通用消息幂等表 |

### 修改
| 文件 | 变更 |
| --- | --- |
| `app/bootstrap.ts` | 发现并注册可选渠道；为发现的渠道登记 `channels` 行；新增 `settingsSeed` |
| `app/http-server.ts` | 把渠道自己的路由挂到 Fastify（通过 HttpRouteHost 适配器，渠道不依赖 web 框架） |
| `test/arch/deletion-guard.test.ts` | ARCH-8 升级为"目录必须可发现或被显式注册"，并真实 import 模块校验契约 |
| `test/helpers/container.ts` | 支持 `fetchImpl` / `settingsSeed`（让渠道指向测试替身） |
| `frontend/**` | 新增「微信」页；新增依赖 `qrcode`（渲染二维码） |

### 新增：测试与脚本
`test/helpers/mock-weixin-server.ts`（mock 微信后端）、`test/helpers/weixin-stack.ts`（渠道测试栈）、
`test/unit/weixin-protocol.test.ts`、`test/integration/weixin-channel.test.ts`、`test/integration/phase4-proactive-weixin.test.ts`、`scripts/phase4-smoke.ts`。

## 2. 协议实现要点

- **基址**：`https://ilinkai.weixin.qq.com`（可按账号覆盖，测试指向 mock）。CDN 基址只保留常量，Phase 4 不调用。
- **端点**：`get_bot_qrcode?bot_type=3`、`get_qrcode_status`、`getupdates`、`sendmessage`、`getconfig`、`sendtyping`、`msg/notifystart|stop`。
- **请求头**：`iLink-App-Id`、`iLink-App-ClientVersion`(0x00MMNNPP 十进制)、`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、`X-WECHAT-UIN: base64(十进制 uint32)`（每请求重新随机），可选 `SKRouteTag`。GET（二维码状态）**只带公共头**。
- **base_info**：`{channel_version, bot_agent}`；bot_agent 按 UA 语法净化（非法 token 丢弃、≤256 字节、空则回退）。
- **发送**：`from_user_id:""`、`message_type:2`、`message_state:2`、**一次请求只带一个 item**、回传 `context_token`、`client_id` 使用 Core 的 idempotencyKey。

## 3. 登录状态机（8 类状态）

| 协议状态 | 对外阶段 | 处理 |
| --- | --- | --- |
| `wait` | `waiting_scan` | 继续轮询 |
| `scaned` | `scanned` | 清空待用验证码 |
| `need_verifycode` | `need_verifycode` | 置 `needsVerifyCode`，前端输入后下一次轮询带上 `verify_code` |
| `verify_code_blocked` | `verify_code_blocked` | 计入刷新预算，允许重新取码 |
| `expired` | `expired` | 刷新二维码；超过预算（默认 3）后终态 expired |
| `scaned_but_redirect` | `redirected` | 记录 host 并切换后续轮询基址 |
| `binded_redirect` | `already_bound` | 视为已绑定；**不写入任何凭证** |
| `confirmed` | `logged_in` | 校验 `ilink_bot_id` + `bot_token` 后暂存凭证，等待 `completeLogin` |

登录失败/未完成时**不会**进入 connected：`completeLogin` 取不到一次性凭证就直接报错；账号只有在 `completeLogin` 保存凭证后才登记并开始轮询。

## 4. 凭证与账号

- 一个账号一份机密载荷 `{botToken, baseUrl, ilinkUserId, contextTokens}`，整体走 Phase 1 的 `CredentialStore`（AES-256-GCM）。
- 数据库里只有密文：测试断言 `credentials.ciphertext` 不含 token 明文；API 响应、日志、快照、错误信息都不含 token（有断言）。
- **context_token 属于渠道 transport state**：不从进入 `InternalMessage`，只按 `账号 + 会话` 保存在机密载荷里与库内密文中。
- 账号复用既有 `channels / channel_accounts` 表（没有新建 weixin_accounts 之类的重复结构）。
- **-14 行为**：标记 `requiresRelogin`（sticky，并发成功的请求也不能清除）→ 停止轮询 → 后续 `runOnce` 直接短路不请求后端 → UI 显示"需要重新登录"；重新登录成功后才解除。

## 5. 两阶段游标与失败语义

```text
读 committed 游标 → getupdates → 保存 pending 游标 → 逐条处理 → 全部完成才 commit
```

- 处理中途失败：**释放该消息的去重声明**（下次可重试）、抛 `BatchIncompleteError`、**不 commit**，循环退避后重取整批。
- 已处理过的消息靠去重表跳过，因此"失败点之前的消息不会被重复处理，失败点之后的消息不会被静默丢失"。
- 崩溃恢复：启动时若发现未提交的 `pending`，记录告警并从 **committed** 重新拉取（去重保证幂等）。
- 幂等键是协议消息 ID，**uint64 用字符串保存**：`9223372036854775807` 原样保留（测试断言，并对照朴素 `JSON.parse` 会丢精度）。

## 6. 重连 / 退避 / 抖动

- 轮询循环：失败 → 指数退避 + 抖动重试；连续失败达阈值（默认 5）→ 记 pause 并按更长退避继续；**-14 直接 return，不做无限重连**。
- 发送：最多 `maxAttempts`（默认 3）次，指数退避 + 抖动；4xx 业务拒绝不重试；`-14` 立即上抛并标记失效。
- 抖动实现为 `base*2^n * (1 ± ratio)`（默认 ±20%），测试断言不同随机源产生不同延迟，避免同步重试风暴。

## 7. ChannelAdapter 复用（没有另造一套）

WeixinChannel 完整实现 Phase 1 的 `ChannelAdapter`：`kind / capabilities / start / stop / health / listAccounts / removeAccount / onInbound / send`。
- `capabilities`：text=true，**media 全 false**（Phase 4 不宣称未实现的能力），loginMethod=`qr`。
- 主动消息：Phase 3 的 `ProactiveService → ProactiveOutbound → ChannelRegistry → ChannelAdapter.send()` **未做任何微信相关改动**，微信只是被注册进来的一个适配器（有端到端测试与冒烟证据）。

## 8. 可选渠道的"真隔离"机制

组合根**没有**任何 `import ".../channels/weixin"`：`app/channel-loader.ts` 在运行时扫描 `channels/` 目录，用**动态说明符**加载导出 `kind` + `createChannel` 的模块。
因此 ARCH-7 的"删掉 `channels/weixin/` 仍然能编译/构建/测试"是真实成立的（守卫每次都会复制源码、物理删除该目录、跑真实 `tsc`）。

## 9. API（渠道自带）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/channels/weixin/status` | 启用状态、账号列表（状态/是否登录/是否需要重登/最近错误）、健康 |
| POST | `/api/channels/weixin/login` | 开始扫码登录，返回二维码内容与阶段 |
| GET | `/api/channels/weixin/login/:sessionId` | 推进一次并返回当前阶段（前端按需轮询） |
| POST | `/api/channels/weixin/login/:sessionId/verify-code` | 提交验证码 |
| POST | `/api/channels/weixin/login/:sessionId/complete` | 建立账号（存凭证 + 登记 + 开始轮询） |
| POST | `/api/channels/weixin/login/:sessionId/cancel` | 取消登录 |
| GET | `/api/channels/weixin/accounts` | 账号列表 |
| DELETE | `/api/channels/weixin/accounts/:accountId` | 删除账号（清凭证 + 清游标 + 去重表） |
| POST | `/api/channels/weixin/accounts/:accountId/relogin` | 解除失效标记并恢复轮询 |

## 10. 前端

新增「微信」页：通道启用状态、账号列表（已连接/未连接/重连中/登录已失效）、扫码添加（canvas 渲染二维码）、验证码输入、重新获取二维码、取消、删除账号、重新连接。
界面只用普通用户语言（不出现 cursor / context_token / long poll / credential 等术语）；**不展示任何 token**。

## 11. 测试覆盖

### Mock 微信后端
`test/helpers/mock-weixin-server.ts`：QR 状态序列、getupdates 批次队列与错误注入（含 -14）、sendmessage 失败注入、鉴权头校验与记录、发送内容记录。

### QR（8 类状态）
wait / scaned / need_verifycode / verify_code_blocked / expired / scaned_but_redirect / binded_redirect / confirmed 全部有断言；并断言登录视图不含 token、未完成登录不能建立账号。

### 轮询与游标
正常收消息、空 batch、多消息 batch（保序）、游标持久化与回传、**批次未完成不 commit**、崩溃恢复（pending → 从 committed 重取）、处理失败后续消息不丢失。

### 失败与重连
单条消息处理失败不吞错；网络断开上抛；退避与抖动；`-14` 停止轮询且不再请求后端、重新登录后恢复。

### 去重与 uint64
同一 `message_id` 重复投递只处理一次（`duplicates` 计数）；`9223372036854775807` 原样保存并可作为幂等键。

### 多账号与 context_token 隔离
Account A/B 各自用自己的 `Authorization`、各自的游标、各自的 context_token 发送；B 读不到 A 会话的令牌；删除 A 不影响 B。

### 发送
正常发送（client_id = 幂等键、回传该会话 context_token）、网络失败重试两次后成功（退避被记录）、超过上限后最终失败且错误信息不含凭证。

### 端到端（真实 HTTP）
- `phase4-proactive-weixin.test.ts`：真实容器 + 运行时发现 + 扫码登录 + **ProactiveService → ChannelAdapter → WeixinChannel → mock 微信后端**；并校验落库 `source=proactive`、快照 `source=proactive`、决策审计。
- 管理 API 测试：状态、登录全流程、complete、删除；断言响应不含 token。

## 12. 测试结果

```text
pnpm test       → tests 169 / pass 169 / fail 0（Phase 3 为 146，Phase 4 新增 23）
pnpm typecheck  → 后端 + 前端 全通过
pnpm build      → 前端构建成功（291.33 kB / gzip 91.67 kB）
pnpm guard      → ARCH-1..8 全部通过
```

ARCH-7 每次都会真实执行：复制 `src` → 物理删除 `channels/weixin` → 跑 `tsc --noEmit` → 必须 0 错误。**这是"可删除性"的机械证明，不是口号。**

## 13. 真实 HTTP / UI 冒烟

`pnpm --filter @companion/backend smoke:phase4`（真实进程 + 真实 SQLite + mock 微信后端 + mock 模型）：

```text
CHANNEL DISCOVERED: weixin（运行时发现，Core 不认识微信）
QR: phase=waiting_scan qrcode=qr-value-1（凭证只进加密存储）
QR: scanned=scanned → logged_in
ACCOUNT: wx-account-1（已登记到 channel_accounts，凭证密文保存）
INBOUND: message_id=9007199254740993(user=wx-user-1) 已被处理（uint64 原样保存）
REPLY → WEIXIN: "（角色）我在，刚忙完手头的事。" | to=wx-user-1 | context_token=ctx-user-1
CONVERSATION: <uuid> channel=weixin
PROACTIVE: decision=sent blocked=—（ProactiveService → ChannelAdapter → WeixinChannel）
REPLY → WEIXIN (proactive): "（角色）我在，刚忙完手头的事。"
CHANNEL STATUS: wx-account-1:connected(loggedIn=true)
CREDENTIAL LEAK CHECK: no token/context_token in API response
AFTER -14: requiresRelogin=true health=degraded（停止轮询，等待重新登录）
PHASE 4 SMOKE OK
```

## 14. 过程中发现并修复的真实缺陷

1. **uint64 解析**：朴素 `JSON.parse` 会改写超大 message_id → 解析前对这些键加引号（有对照断言）。
2. **bot_agent 净化丢注释**：`Name/Version (comment)` 的注释部分被丢弃 → 改为按语法整体处理。
3. **SQL 句柄类型不匹配**：渠道内的游标/去重存储收到了原始句柄却按封装类型使用 → 统一改为依赖 Core 的最小 SQL 端口。
4. **发现渠道未登记 `channels` 行**：导致 `channel_accounts` 外键失败 → 组合根在注册渠道时先登记渠道行。
5. **-14 后可能被并发成功请求"复活"**：`markConnected` 会清掉失效标记 → 改为 sticky，只有显式重新登录才解除（冒烟已验证）。
6. **登录后后台轮询抢走测试批次**：测试变成随机失败 → 测试助手默认停掉后台循环，由测试显式驱动。

## 15. 已知问题

| # | 问题 | 影响 | 计划 |
| --- | --- | --- | --- |
| P4-1 | 只支持文字：图片/语音/视频/文件一律 skip | 用户看不到媒体内容，也没有提示 | Phase 4.5 |
| P4-2 | 引用消息只还原内联文本，没有本地引用缓存 | 只带 svr_id 的引用显示为未解析占位 | Phase 4.5（MessageReferenceService） |
| P4-3 | 未实现 typing（sendTyping 已封装常量但未接入） | 微信端看不到"正在输入" | 视需要 |
| P4-4 | 未实现 getconfig/typing_ticket 链路 | 同上 | 同 P4-3 |
| P4-5 | `scaned_but_redirect` 切换为 https，本地 mock 无法验证切换后的请求 | 重定向路径只验证了阶段与 host 记录 | 需要真实环境验证 |
| P4-6 | 去重表没有保留期清理（`prune` 已实现但无人调用） | 长期运行会缓慢增长 | 交给调度器周期任务 |
| P4-7 | 群聊（group_id）未处理 | 只支持单聊 | 后续 |
| P4-8 | 未做发送速率限制/风控退让 | 大量主动消息可能触发风控 | 需要实测 |
| P4-9 | 仍未提供 `channel_message_ids` 的 UI 视图 | 排查重复消息只能查库 | 视需要 |
| P4-10 | 前端只用了 canvas 渲染二维码，未处理二维码内容为图片 URL 的情况 | 若后端返回图片 URL，会显示文本而不是图片 | 按真实返回调整 |

## 16. 未完成事项（明确排除在本阶段之外）

- **Phase 4.5**：图片、语音（含 Silk 编解码）、视频、文件、CDN 上传下载、AES 媒体加密、OCR/图片理解、引用媒体还原。
- **Phase 5**：Browser 服务、工具系统与权限审批。
- **Phase 6+**：TTS、Performance Engine、Live2D、多角色世界。
- 横切项：本地口令鉴权、数据导出/删除（沿用 Phase 2/3 的已知问题清单）。

## 17. 完成清单

```text
[x] QR 登录可用
[x] 8 类登录状态正确处理
[x] credential 加密保存（库内只有密文，API/日志/快照无线索）
[x] -14 正确处理（sticky 失效 + 停止轮询 + 可重新登录）
[x] long poll 可用
[x] cursor 持久化
[x] 两阶段 cursor（pending → commit）
[x] batch failure semantics 正确（不 commit、不丢后续、可重试）
[x] message dedup（协议 ID 幂等）
[x] uint64 安全（字符串保存 + 解析前加引号）
[x] 多账号隔离（凭证/游标/令牌互不串用）
[x] context_token 正确隔离（按账号+会话，密文保存）
[x] sendmessage 可用（单 item、幂等键、context_token 回传）
[x] retry/backoff/jitter（限额重试 + 抖动）
[x] reconnect（退避重连，-14 不无限重连）
[x] health/start/stop
[x] Proactive 可通过 WeixinChannel 发送（Phase 3 代码零改动）
[x] 微信基础 UI
[x] Mock 微信后端
[x] 全部测试通过（169/169）
[x] typecheck 通过
[x] build 通过
[x] ARCH-1..8 全部通过
[x] 删除 channels/weixin 后 Core 仍然通过 ARCH-7
```

---

**Phase 4 完成。**
停止。
不要进入 Phase 4.5 / Phase 5。

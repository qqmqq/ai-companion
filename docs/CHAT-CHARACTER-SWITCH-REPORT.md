# 换角色：微信口令 + 后台按钮（含真机验证）

日期：2026-09-17 ・ 需求：「微信在聊的角色添加切换功能，切换新角色新聊天发送开场白」+「后台也有相关功能」

## 1. 之前为什么换不了

入站消息只带渠道层的会话引用（微信里就是对方的 id），角色靠 `resolveCharacterId` 猜：
`metadata.characterId` → 全局 `defaultCharacterId` → **第一个角色**。三个来源都不会变，所以聊来聊去永远是同一个人。

## 2. 两个入口，一条逻辑

| 入口 | 怎么用 |
| --- | --- |
| **微信里发口令** | 「切换角色 Kai」「换成Aria」「我要跟Kai聊天」；「角色列表」看现在有谁、正在跟谁聊 |
| **后台界面** | 「微信」页 →「在跟谁聊（可以在这里换角色）」→ 每条聊天一个下拉框 +「切换到这个角色」按钮 |

两者调用的是同一个核心方法 `ChatCharacterSwitch.switchTo()`，行为完全一致。

## 3. 改动

| 文件 | 改动 |
| --- | --- |
| `backend/src/core/services/chat-character-switch.ts` | 新增：口令解析 + 每个聊天的当前角色 + `switchTo()`（口令与按钮共用） |
| `backend/src/core/services/messaging-pipeline.ts` | 入站先看是不是口令；`resolveCharacterId` 新增"这个聊天当前的角色"这一级（优先于全局默认） |
| `backend/src/api/routes/conversations.ts` | 新增 `PUT /api/conversations/:id/active-character`；会话列表补 `activeCharacterId` |
| `backend/src/api/dto/mappers.ts` | 会话 DTO 增加 `activeCharacterId` |
| `backend/src/app/bootstrap.ts` | 装配 + 暴露 `services.characterSwitch` |
| `frontend/src/pages/weixin.tsx` | 「在跟谁聊」分区：当前角色、最近消息、角色下拉框、「切换到这个角色」按钮、结果提示 |
| `frontend/src/lib/api.ts` / `types.ts` | `switchConversationCharacter()`、`activeCharacterId` |

### 行为规则（两个入口一致）

- 换到**没聊过**的角色 → 新建会话（会话创建时写入该角色开场白），这句开场白**真的发到渠道**；
- 换回**聊过**的角色 → 复用原会话，回一句「已经切回「X」，之前聊的都在。」；
- 换到**正在聊**的角色 → 不变，回一句「现在就在跟「X」聊」；
- 名字对不上 / 能对上好几个 → 说清楚 + 给列表，**不瞎切**。

### 后台按钮的两个细节

- **web 会话不发**：网页聊天的开场白本来就以消息形式存在库里、由前端渲染，再发一次会变成重影（`channel !== WEB_CHANNEL_KIND` 时才投递）；
- **发失败不吞事实**：切换本身已经成功，若渠道发不出去（例如微信掉线），接口返回 `delivered:false` + `deliveryError`，界面照实提示「开场白没发出去（原因）」。

### 不误伤普通聊天

「换」字开头的句子很多不是命令。规则：**没说「角色/人物」二字时，名字必须真的对得上某个角色**，否则照常当聊天。
名字还必须像名字（≤12 字、不含「什么/怎么/谁/吗/哪/样/办」）。这两条都是被测试逼出来的：
「更换角色：Kai」把冒号带进了名字；「换成什么样都行吗」被误判成换人。

## 4. 真机验证（你自己的微信，2026-09-17 21:02）

日志与数据库里的事实：

```
21:01:38  character created            name=Nova（你新建的角色）
21:02:43  chat character switched; new conversation created
          characterId=01a0ac06…  hasFirstMessage=true
21:02:43  chat character command handled  newConversation=true  durationMs=316
```

数据库结果：

- 新建的微信会话 `01a0ac07…` 里**只有一条消息** —— 就是那个角色版本里写的那句开场白；
- 原来那条微信会话（26 条消息）**一条都没多**；
- `settings.chatActiveCharacter.weixin.<账号>.<对方 id>` = Nova。

也就是说：**换人 = 新会话 = 开场白，这条链路在真机上已经跑通了**（你那次走的是微信口令入口；后台按钮是这次新加的）。

## 5. 自动化验证

| 测试 | 覆盖 |
| --- | --- |
| `backend/test/unit/chat-character-switch.test.ts`（3 用例） | 17 种口令写法、7 种不该误判的普通句子、键的隔离性、键里不含平台字样 |
| `backend/test/integration/weixin-character-switch.test.ts`（2 用例，真 HTTP + 真 SQLite + mock 微信后端） | 微信口令端到端 8 条断言；**后台接口**：新会话 + 开场白真的发到微信（mock 后端收到原文）、列表带 `activeCharacterId`、切回复用旧会话、角色不存在 404、写审计 |
| `frontend/test/weixin-character-switch.test.mjs`（2 用例，jsdom） | 微信页渲染「未指定（按第一个角色回复）」、网页会话不混进来、没选人不能点、选中后 PUT 的 body 正确、提示「开场白已发到微信：「…」」、刷新后标出「现在在聊」；没有角色时提示先去建角色 |

## 6. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 411 / 411 通过 |
| pnpm --filter @companion/frontend test | 38 / 38 通过 |
| pnpm typecheck / build / guard | 0 / 0 / 8 通过 |

后端已重启（web + weixin healthy）。

## 7. 诚实说明

- **网页聊天不吃口令**：网页走流式路径（有自己的会话列表与角色页），口令在那边只会被当普通聊天；后台的换角色入口在「微信」页。
- 切换口令本身**不落库**（新会话里只有开场白，是最干净的"新聊天"）；动作记在日志 `chat.character.switch` 与后台换角色的审计 `conversation.character_switched`。
- 后台按钮我没有在真实微信上点过（那会往你手机发一条消息）；它走的是与口令完全相同的方法，且有 mock 微信后端的端到端测试兜着。

## 结论

| 判定 | 结果 |
| --- | --- |
| SWITCH_VIA_WECHAT_COMMAND | VERIFIED —— 真机：21:02 新建会话 + 开场白，旧会话不受影响 |
| SWITCH_VIA_BACKEND_UI | VERIFIED —— 接口 + 页面 + 端到端测试；开场白确实投递到渠道 |
| NEW_CHARACTER_NEW_CHAT | VERIFIED —— 换人开新会话，旧会话一条不多 |
| NO_FALSE_SWITCH | VERIFIED —— 名字对不上/有歧义/普通句子都不切，角色不存在 404 |
| NO_REGRESSION | VERIFIED —— 411 / 38 / typecheck / build / guard 全绿 |

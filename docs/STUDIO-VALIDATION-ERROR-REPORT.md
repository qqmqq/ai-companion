# 角色工坊「AI 补全人设」报「请求参数不合法」——定位与修复

日期：2026-09-17 ・ 来源：用户反馈「ai 补全人设显示出错了：请求参数不合法」

## 1. 那句话是怎么来的

「请求参数不合法」是 `backend/src/api/validation.ts` 里 `parseOrThrow()` 的固定文案：只要 zod 校验不过就抛它。
**真正的原因（哪个字段、为什么）原本被丢掉了** —— 用户只能看到这一句，等于没说。

## 2. 复现到的三个触发点（对着运行中的后端实测）

| 操作 | 结果 |
| --- | --- |
| 设想框留空后提交 | 400 `请求参数不合法` |
| 设想超过 2000 字（界面上没有任何上限提示） | 400 `请求参数不合法` |
| 在设定里把「角色名称」清空，再点「让 AI 改」 | 400 `请求参数不合法` |

正常调用（几百字的设想、名字非空）都是 200，接口本身没坏。

## 3. 两层根因

### A. 后端把校验详情吞了

`parseOrThrow` 只回一句固定文案，`parsed.error.issues` 里的字段路径与原因没有进 message（只在 details 里，界面不看 details）。

### B. 前端既没有上限，也没有前置校验，而且工坊手里是旧值

- 设想框、要求框都没有长度上限，用户写多长都行，超了才在服务端被拒；
- 角色名称清空后，「让 AI 改」照样可点；
- **更隐蔽的一个真 bug**：角色名称/描述这些字段的编辑状态在 `CharacterForm` 内部，工坊手里的 `draft` 还是「AI 补全那一刻」的旧值 —— 用户手改完再让 AI 改，提交上去的是**改之前**的定义。三个入口里最难发现的就是这个。

## 4. 修复

| 文件 | 改动 |
| --- | --- |
| `backend/src/api/validation.ts` | 新增 `describeIssue()`：把 zod 的英文提示逐条翻成人话并带上字段路径。报错从「请求参数不合法」变成「请求参数不合法：ideas 最多 2000 个字」；`details.issues` 保留（path + 中文 message） |
| `frontend/src/pages/characters.tsx` | 设想框 `maxLength=2000` + 实时字数提示；要求框 `maxLength=1000`；角色名称为空时「让 AI 改」禁用并说明原因；新增 `friendlyStudioError()` 把字段路径翻成中文（设想 / 角色名称 / 性格 / 背景 …），界面上不出现 `ideas`、`definition.name` 这类代码名 |
| `frontend/src/pages/characters.tsx`（CharacterForm） | 新增 `onChange`：用户手改字段时把最新定义同步给工坊，修掉"改完再让 AI 改，提交的是旧值"这个 bug |

## 5. 真机验证（改完之后实际返回）

```
空设想            → 400  请求参数不合法：ideas 不能为空
超长设想（2500字）→ 400  请求参数不合法：ideas 最多 2000 个字
改设定但名字为空  → 400  请求参数不合法：definition.name 不能为空
```

界面上再把字段路径翻一层：用户看到的是「请求参数不合法：设想最多 2000 个字」。

## 6. 测试

| 测试 | 覆盖 |
| --- | --- |
| `backend/test/unit/validation.test.ts`（新增 3 用例） | 空值/超长/类型错/枚举错都能翻成人话；合法输入原样通过 |
| `backend/test/integration/character-studio.test.ts` | 真接口上：空设想 400 且 message 说明字段与原因；超长设想 400 且写明上限 |
| `frontend/test/character-studio.test.mjs`（新增 2 用例） | 后端拒绝时界面显示「设想最多 2000 个字」且不出现 `ideas`；设想框 maxLength=2000 且有字数提示；名字清空时按钮禁用并说明 |

## 7. 回归

| 检查 | 结果 |
| --- | --- |
| pnpm --filter @companion/backend test | 406 / 406 通过（原 403 + 新增 3） |
| pnpm --filter @companion/frontend test | 36 / 36 通过（原 34 + 新增 2） |
| pnpm typecheck / build / guard | 0 / 0 / 8 通过 |

后端已重启（web + weixin healthy）。

## 8. 诚实说明

我没看到你当时点的是哪一步，所以把三个能走到这个报错的入口全部堵上，并且让报错本身说清原因。
如果还会出现，请把界面上那句话发我 —— 它现在会写明是哪个字段、为什么。

## 结论

| 判定 | 结果 |
| --- | --- |
| ERROR_IS_SELF_EXPLANATORY | VERIFIED —— 后端逐条翻译 zod 提示，前端再把字段路径翻成中文 |
| INVALID_SUBMIT_PREVENTED | VERIFIED —— 长度上限 + 字数提示 + 名字为空的硬禁 |
| STALE_DRAFT_BUG_FIXED | VERIFIED —— 手改字段会同步给工坊，改完再让 AI 改提交的是当前值 |
| NO_REGRESSION | VERIFIED —— 406 / 36 / typecheck / build / guard 全绿 |

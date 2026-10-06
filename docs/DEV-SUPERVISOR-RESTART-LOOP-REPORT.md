# pnpm dev 每 0.6 秒重启一次后端（守护进程死循环）

日期：2026-09-22 ・ 现象：\`pnpm dev\` 起来后满屏 \`[dev] 后端退出（code=null signal=SIGTERM），600ms 后重启\`，
后端始终起不来，前端一片 500。

## 1. 排查过程（三次都以为是别的原因）

1. **先是端口**：确实有占用 —— 之前几轮测试留下的孤儿进程还listen着 8787，新进程起来就 EADDRINUSE。
   清掉之后重启…… 还是循环。所以端口占用是**另一个**问题（下面第 3 节也修了提示）。
2. **再是扫描器/测试**：不是。
3. **最后抓现场**：在风暴进行时用一个 \`fs.watch(recursive)\` 探针盯着 \`backend/src\`，10 秒抓到 30 多条：

```text
t=0.5s event=change filename="api\\routes\\proactive.ts"
t=1.2s event=change filename="api\\routes\\integrations.ts"
t=2.9s event=change filename="channels\\qq\\index.ts"
...
```

文件名按目录顺序滚动 —— 这些文件**根本没被改过**。

## 2. 根因

Windows 上 \`fs.watch(dir, { recursive: true })\` 会在文件**被读取**时也报 \`change\`。
而后端是 \`node --experimental-strip-types\` 直接跑 .ts 的 —— **进程启动时就要把整棵 src 读一遍**。
于是形成闭环：

> 启动后端 → 读源码 → Windows 报一片 change → 守护进程认为"代码改了" → 杀掉后端重启 →
> 新进程又读一遍 → 又报 change → …

第一版 \`dev.mjs\` 还有第二个隐患：\`fs.watch\` 在 Windows 上会给出 \`filename = null\` 的事件，
而当时的写法是"filename 不是字符串或不以 .ts 结尾就不管"—— \`null\` 不满足"以 .ts 结尾"，
本该被过滤，但代码写成了 \`if (typeof filename === "string" && !filename.endsWith(".ts")) return;\`，
\`null\` 直接穿过去被当成"有文件改了"。

## 3. 修了什么

判断逻辑抽到 \`backend/scripts/dev-lib.mjs\`（外加 \`dev-lib.d.mts\` 类型声明），**7 条测试**钉住：

| 改动 | 说明 |
| --- | --- |
| **只信 mtime/size** | \`createChangeTracker\` 记住每个文件上次的 \`mtimeMs:size\`，一样就返回"没改"。第一次见到某个文件只登记基线 —— 否则启动那一波扫描就会触发重启 |
| filename 可能是 null | \`shouldRestartForFile\` 明确只认字符串且以 \`.ts\` 结尾 |
| 退避 | 改动触发的重启固定 800ms（不是 0：旧监听释放要时间）；崩溃重试 2s→4s→…→30s 封顶（原来是固定 2s 狂刷） |
| 端口占用的提示 | 先静默短重试（300/600/1200/2400ms，预算 ≈10 秒），还不行才打印**可执行**的提示：Windows / macOS 各自的清理命令 + 换端口的出路。实测改一次代码约 1.3 秒就回来了，那点空窗不该弹警告 |

## 4. 证据

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 启动后 25~30 秒内的重启次数 | **24 次**（每 0.6s 一轮） | **0 次** |
| 启动期间的"端口被占用"提示 | 每轮都刷 | 0 次 |
| 改一次源码（touch 一个 .ts） | 循环重启 | **恰好 1 次**，0 次 EADDRINUSE、0 次提示 |
| 后端停机时间（改一次代码） | 起不来 | **downAt=25ms，backUpAt=1341ms** |
| 前后端健康状况 | backend=down | frontend=200 / backend=200 |

门禁：后端 **476/476**（新增 7 例）、前端 **75/75**、\`typecheck\`、\`pnpm build\`、架构守卫 **8/8**、\`pnpm scan:pii\` 全通过。

## 5. 已知限制

- 偶发一行子进程自己打印的 \`failed to start: listen EADDRINUSE\`：Windows 上监听端口的释放比进程退出慢一点，
  新进程偶尔会先撞上。守护进程现在会静默重试并自愈（实测 1.3 秒内恢复）。**没有**去改后端监听套接字的
  端口复用选项 —— 那会牵扯"端口能不能被别人抢"的语义，不该为了开发期的几百毫秒去动生产行为。
- 排查过程中还发现：我自己用后台任务起停服务时留下了孤儿进程（杀掉包装进程不会带走孙子进程），
  这也是"端口被占用"的来源之一。这不是代码缺陷，但值得记一笔。

## 6. 变更文件

新增：\`backend/scripts/dev-lib.mjs\`、\`backend/scripts/dev-lib.d.mts\`、\`backend/test/unit/dev-supervisor.test.ts\`
修改：\`backend/scripts/dev.mjs\`、\`backend/tsconfig.json\`（把 \`scripts/**/*.d.mts\` 纳入类型检查）

/**
 * 开发守护进程里"纯判断"的部分：文件改动要不要重启、下次重试等多久。
 *
 * 单独放一个文件是为了能测 —— 这里的每一条都是踩出来的：
 *
 * 1. Windows 上 fs.watch(recursive) 会给出 filename=null 的事件（目录、来不及取名的事件），
 *    第一版把它当成了"文件改了"，后端被反复 SIGTERM；
 * 2. 更隐蔽的一条：**Windows 上只是"读"这些 .ts 文件也会报 change 事件**。
 *    后端启动时 node 的类型剥离要读一遍源码 → 产生一片 change → 守护进程重启后端 →
 *    新进程又读一遍 → 无限重启。表现就是"[dev] 后端退出（signal=SIGTERM）"每 0.6 秒刷一次。
 *    所以判断不能信事件，要看 **mtime 真的变了没有**。
 */

/** 只有 .ts 源码的改动才值得重启后端；其它事件（目录、临时文件、filename 为 null）一律忽略 */
export function shouldRestartForFile(filename) {
  return typeof filename === "string" && filename.endsWith(".ts");
}

/**
 * 记住每个文件上次看到的 mtime/大小，只有真的变了才算"编辑"。
 * 第一次见到某个文件只登记基线、不算改动（否则启动那一波扫描就会触发重启）。
 * stat 注入进来是为了能测；真实实现用 fs.statSync。
 */
export function createChangeTracker(stat) {
  const seen = new Map();
  return {
    /** 返回 true 表示这次事件对应的文件真的被改过 */
    changed(filename) {
      if (!shouldRestartForFile(filename)) return false;
      const info = stat(filename);
      if (info === null) {
        seen.delete(filename); // 文件被删：不重启，等编辑动作自己触发
        return false;
      }
      const mark = info.mtimeMs + ":" + info.size;
      const previous = seen.get(filename);
      seen.set(filename, mark);
      if (previous === undefined) return false; // 基线
      return previous !== mark;
    },
    /** 测试与诊断用 */
    size() {
      return seen.size;
    },
  };
}

/**
 * 改动触发的重启延迟：不能是 0 —— 旧进程刚被 kill、Windows 上那个监听端口还没真正释放，
 * 立刻起新进程就会撞 EADDRINUSE（这正是"改一次代码要等好几秒才起来"的原因）。
 */
export const CHANGE_RESTART_DELAY = 800;

/**
 * 端口被占用时的**短重试**序列：多数情况是刚被杀掉的自己人还没退干净，几百毫秒后就好了。
 * 只有这几次都失败，才当成"真的有别的实例占着"，打印提示并转入长退避。
 */
export const PORT_RETRY_DELAYS = [300, 600, 1200, 2400];

export function portRetryDelay(attempt) {
  const index = Math.max(0, Math.min(attempt, PORT_RETRY_DELAYS.length - 1));
  return PORT_RETRY_DELAYS[index];
}

/**
 * 什么时候才值得喊"端口被别人占了"：实测改一次代码，后端约 1.3 秒就回来了 ——
 * 那点空窗不该让人看到警告。所以先安静地重试两轮（≈10 秒），还不行才提示。
 */
export const PORT_HINT_AFTER_ATTEMPTS = PORT_RETRY_DELAYS.length * 2;

/**
 * 崩溃重试要退避：端口被占用这类问题不会自己好，2 秒一次狂刷日志只会把原因埋掉。
 * 2s → 4s → 8s → 16s → 30s（封顶）。
 */
export function nextRestartDelay(previousDelay, cause) {
  if (cause === "change") return CHANGE_RESTART_DELAY;
  if (typeof previousDelay !== "number" || previousDelay <= 0) return 2000;
  return Math.min(previousDelay * 2, 30000);
}

/** 端口占用时给人看的提示：不同系统的查法不一样，直接写清楚 */
export function portBusyHint(port) {
  return [
    "端口 " + port + " 已经被占用，后端起不来（很可能是上一次没退干净的实例）。",
    "  Windows:  Get-NetTCPConnection -LocalPort " + port + " -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }",
    "  macOS/Linux:  lsof -ti:" + port + " | xargs kill",
    "  或者换个端口：在 .env 里改 COMPANION_PORT。",
    "守护进程会退避重试，你处理完它自己就会起来。",
  ].join("\n");
}

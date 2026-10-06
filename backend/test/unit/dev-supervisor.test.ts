import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_RESTART_DELAY,
  PORT_HINT_AFTER_ATTEMPTS,
  createChangeTracker,
  nextRestartDelay,
  portBusyHint,
  portRetryDelay,
  shouldRestartForFile,
} from "../../scripts/dev-lib.mjs";

/**
 * 开发守护进程的判断逻辑。
 *
 * 每一条都是踩出来的，不是"顺手测一下"：
 *
 * 1. Windows 上 fs.watch 会给出 filename=null 的事件，第一版把它当成"文件改了"，
 *    后端被反复 SIGTERM；
 * 2. 更隐蔽的是：Windows 上**读**这些 .ts 文件也会报 change。后端启动时 node 要读一遍源码，
 *    于是"重启 → 新进程读源码 → 又报 change → 再重启"，0.6 秒一轮无限循环。
 *    所以判断不能信事件类型，只看 mtime 是否真的变了。
 */

type Entries = Record<string, { mtimeMs: number; size: number } | undefined>;

function fakeStat(entries: Entries) {
  return (filename: string) => entries[filename] ?? null;
}

test("只有 .ts 源码改动才值得重启：null 与其它后缀都不算", () => {
  assert.equal(shouldRestartForFile("core/services/chat.ts"), true);
  assert.equal(shouldRestartForFile("app/main.ts"), true);
  assert.equal(shouldRestartForFile(null), false);
  assert.equal(shouldRestartForFile(undefined), false);
  assert.equal(shouldRestartForFile(""), false);
  assert.equal(shouldRestartForFile("notes.ts.bak"), false);
  assert.equal(shouldRestartForFile("scripts/dev.mjs"), false);
});

test("光是读到文件（mtime 没变）不能触发重启：第一次只登记基线", () => {
  const tracker = createChangeTracker(fakeStat({ "app/main.ts": { mtimeMs: 1000, size: 10 } }));
  assert.equal(tracker.changed("app/main.ts"), false, "第一次见到只登记，不算改动");
  assert.equal(tracker.changed("app/main.ts"), false, "再读一次还是一样，仍然不算改动");
  assert.equal(tracker.changed("app/main.ts"), false);
  assert.equal(tracker.size(), 1, "同一个文件只记一条");
});

test("真的改了 mtime（或大小）才算编辑，改完能重复触发", () => {
  const entries = { "app/main.ts": { mtimeMs: 1000, size: 10 } };
  const tracker = createChangeTracker(fakeStat(entries));
  tracker.changed("app/main.ts"); // 基线

  entries["app/main.ts"] = { mtimeMs: 1001, size: 10 }; // 只改 mtime
  assert.equal(tracker.changed("app/main.ts"), true);

  entries["app/main.ts"] = { mtimeMs: 1001, size: 11 }; // 只改大小
  assert.equal(tracker.changed("app/main.ts"), true);

  assert.equal(tracker.changed("app/main.ts"), false, "没变化就不该再触发");
});

test("文件被删掉不重启（等编辑动作自己触发），恢复后重新算基线", () => {
  const entries: Entries = { "app/main.ts": { mtimeMs: 1000, size: 10 } };
  const tracker = createChangeTracker(fakeStat(entries));
  tracker.changed("app/main.ts");
  entries["app/main.ts"] = undefined; // 删掉
  assert.equal(tracker.changed("app/main.ts"), false, "删除本身不触发重启");
  entries["app/main.ts"] = { mtimeMs: 2000, size: 10 };
  assert.equal(tracker.changed("app/main.ts"), false, "重新出现时先当基线");
});

test("端口占用先短重试（刚被杀掉的监听要一会儿才释放），三次都失败才转长退避", () => {
  assert.equal(portRetryDelay(0), 300);
  assert.equal(portRetryDelay(1), 600);
  assert.equal(portRetryDelay(2), 1200);
  assert.equal(portRetryDelay(3), 2400);
  assert.equal(portRetryDelay(9), 2400, "越界也不越拖越久");
  const total = [0, 1, 2, 3].reduce((sum, i) => sum + portRetryDelay(i), 0);
  assert.ok(total >= 4000, "短重试的总时长要够覆盖 Windows 上刚退出的监听，实得 " + total + "ms");

  // 实测：改一次代码后端约 1.3 秒回来。安静重试要撑到远大于这个数，才不至于每次都弹警告。
  const quietBudget = [0, 1, 2, 3, 4, 5, 6, 7].reduce((sum, i) => sum + portRetryDelay(i), 0);
  assert.ok(PORT_HINT_AFTER_ATTEMPTS >= 8, "先安静重试至少 8 次");
  assert.ok(quietBudget >= 10000, "安静重试的总预算要 ≥ 10 秒，实得 " + quietBudget + "ms");
});

test("改动重启固定 800ms（给旧监听时间释放，避免撞 EADDRINUSE）；崩溃重试指数退避封顶 30s", () => {
  assert.equal(nextRestartDelay(16000, "change"), CHANGE_RESTART_DELAY);
  assert.ok(CHANGE_RESTART_DELAY >= 500, "改动重启不能是 0：Windows 上会撞端口占用");
  assert.equal(nextRestartDelay(0, "crash"), 2000);
  assert.equal(nextRestartDelay(2000, "crash"), 4000);
  assert.equal(nextRestartDelay(16000, "crash"), 30000);
  assert.equal(nextRestartDelay(30000, "crash"), 30000);
});

test("端口占用时给的是可执行的提示，不是一句'启动失败'", () => {
  const hint = portBusyHint(8787);
  assert.match(hint, /8787/);
  assert.match(hint, /Get-NetTCPConnection/);
  assert.match(hint, /lsof -ti:8787/);
  assert.match(hint, /COMPANION_PORT/);
});

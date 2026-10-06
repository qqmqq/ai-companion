/**
 * 开发用守护进程：跑后端，崩了自动重启。
 *
 * 为什么不用 `node --watch`：它只在**文件变化**时重启。子进程崩溃后它只打印
 * "Failed running ... Waiting for file changes before restarting" 然后一直等 ——
 * 后端就这样静默地死了，前端接着满屏 500（Vite 代理连不上 8787）。
 *
 * 判断逻辑（要不要重启 / 退避多久 / 端口占用怎么提示）都在 dev-lib.mjs 里，那边有测试。
 */
import { spawn } from "node:child_process";
import { statSync, watch } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PORT_HINT_AFTER_ATTEMPTS,
  createChangeTracker,
  nextRestartDelay,
  portBusyHint,
  portRetryDelay,
  shouldRestartForFile,
} from "./dev-lib.mjs";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(backendRoot, "src");
const entry = join(srcRoot, "app", "main.ts");
const envFile = "--env-file-if-exists=" + join(backendRoot, "..", ".env");
const port = Number(process.env.COMPANION_PORT ?? 8787);

/** Windows 上"读"源码也会报 change 事件，所以只信 mtime 真的变了 */
const tracker = createChangeTracker((filename) => {
  try {
    const info = statSync(join(srcRoot, filename));
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
});

let child = null;
let stopping = false;
let restartDelay = 0;
let restartTimer = null;
let warnedAboutPort = false;
let changeTimer = null;
let startAttempts = 0;

/** 端口被占用时别装死：说清楚是谁占着、怎么清掉（只提示一次，退避重试） */
function checkPort() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (busy) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function start() {
  restartTimer = null;
  if (await checkPort()) {
    // 刚被杀掉的自己人还没退干净：先安静重试，别急着喊"端口被占用"（实测改一次代码约 1.3s 就回来）
    if (startAttempts < PORT_HINT_AFTER_ATTEMPTS) {
      const wait = portRetryDelay(startAttempts);
      startAttempts += 1;
      restartTimer = setTimeout(() => void start(), wait);
      return;
    }
    if (!warnedAboutPort) {
      warnedAboutPort = true;
      process.stdout.write("[dev] " + portBusyHint(port) + "\n");
    }
    restartDelay = nextRestartDelay(restartDelay, "crash");
    restartTimer = setTimeout(() => void start(), restartDelay);
    return;
  }
  startAttempts = 0;
  warnedAboutPort = false;
  const started = spawn(process.execPath, [envFile, entry], { cwd: backendRoot, stdio: "inherit" });
  child = started;
  started.on("error", (error) => {
    process.stdout.write("[dev] 起不来：" + error.message + "\n");
  });
  started.on("exit", (code, signal) => {
    if (child === started) child = null;
    if (stopping) return;
    restartDelay = nextRestartDelay(restartDelay, "crash");
    process.stdout.write(
      "[dev] 后端退出（code=" + String(code) + " signal=" + String(signal) + "），" + String(restartDelay) + "ms 后重启\n",
    );
    restartTimer = setTimeout(() => void start(), restartDelay);
  });
}

/** 文件改动：去抖 150ms 再换掉旧进程（改动导致的退出用固定 300ms，不长退避） */
function restartForChange() {
  if (stopping) return;
  restartDelay = nextRestartDelay(restartDelay, "change");
  if (changeTimer !== null) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    if (stopping) return;
    if (child !== null) {
      child.kill();
      return;
    }
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => void start(), nextRestartDelay(0, "change"));
    }
  }, 150);
}

watch(srcRoot, { recursive: true }, (_event, filename) => {
  if (!shouldRestartForFile(filename)) return; // filename 在 Windows 上可能是 null
  if (!tracker.changed(filename)) return; // 只是被读了：mtime 没变，不算编辑
  restartForChange();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (restartTimer !== null) clearTimeout(restartTimer);
    if (changeTimer !== null) clearTimeout(changeTimer);
    if (child !== null) child.kill();
    process.exit(0);
  });
}

void start();

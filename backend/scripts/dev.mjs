/**
 * 开发用守护进程：跑后端，崩了自动重启。
 *
 * 为什么不用 `node --watch`：它只在**文件变化**时重启。子进程崩溃后它只打印
 * "Failed running ... Waiting for file changes before restarting" 然后一直等 ——
 * 后端就这样静默地死了，前端接着满屏 500（Vite 代理连不上 8787）。
 *
 * ponytail: 递归监听整棵 src + 300ms 去抖，够用；node --watch 支持崩溃重启后这个文件就可以删。
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(backendRoot, "src", "app", "main.ts");
const envFile = "--env-file-if-exists=" + join(backendRoot, "..", ".env");

let child = null;
let stopping = false;
let restartDelay = 2000;
let restartTimer = null;

function start() {
  restartTimer = null;
  const started = spawn(process.execPath, [envFile, entry], { cwd: backendRoot, stdio: "inherit" });
  child = started;
  started.on("exit", (code, signal) => {
    if (child === started) child = null;
    if (stopping) return;
    process.stdout.write("[dev] 后端退出（code=" + String(code) + " signal=" + String(signal) + "），" + String(restartDelay) + "ms 后重启\n");
    restartTimer = setTimeout(start, restartDelay);
    restartDelay = 2000;
  });
}

/** 文件改动：立刻换掉旧进程（改动导致的退出不需要长退避） */
function restartForChange() {
  if (stopping) return;
  restartDelay = 300;
  if (child !== null) {
    child.kill();
    return;
  }
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(start, 300);
  }
}

watch(join(backendRoot, "src"), { recursive: true }, (_event, filename) => {
  if (typeof filename === "string" && !filename.endsWith(".ts")) return;
  restartForChange();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (restartTimer !== null) clearTimeout(restartTimer);
    if (child !== null) child.kill();
    process.exit(0);
  });
}

start();

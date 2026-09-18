/**
 * 真实浏览器 + CDP（Chrome DevTools Protocol）。
 *
 * 为什么不用 Playwright/Puppeteer：我们只需要"开一个真浏览器 + 读一个页面变量"，
 * 而 Node 24 自带 WebSocket，直接用 CDP 就够，**不引入任何新依赖**。
 *
 * 为什么用独立 user-data-dir：不动用户日常的浏览器配置，登录态还能跨次保留。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { Logger } from "../../core/ports/logger.ts";

export interface BrowserCandidate {
  name: string;
  path: string;
}

/** Windows 上常见的 Chrome / Edge 路径；可用环境变量 COMPANION_BROWSER_PATH 覆盖 */
export function defaultBrowserCandidates(): BrowserCandidate[] {
  const programFiles = process.env["ProgramFiles"] ?? "C:/Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";
  const candidates: BrowserCandidate[] = [
    { name: "Chrome", path: programFiles + "/Google/Chrome/Application/chrome.exe" },
    { name: "Chrome", path: programFilesX86 + "/Google/Chrome/Application/chrome.exe" },
    { name: "Edge", path: programFilesX86 + "/Microsoft/Edge/Application/msedge.exe" },
    { name: "Edge", path: programFiles + "/Microsoft/Edge/Application/msedge.exe" },
  ];
  if (localAppData.length > 0) {
    candidates.push({ name: "Chrome", path: localAppData + "/Google/Chrome/Application/chrome.exe" });
  }
  const override = process.env["COMPANION_BROWSER_PATH"];
  if (typeof override === "string" && override.length > 0) candidates.unshift({ name: "自定义", path: override });
  return candidates;
}

export function findBrowser(candidates: BrowserCandidate[] = defaultBrowserCandidates()): BrowserCandidate | null {
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

/** 让系统分一个空闲端口（远程调试端口） */
export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("拿不到空闲端口"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** 开一个真实浏览器窗口（独立 profile + 调试端口），进程与我们的程序解耦 */
export function launchBrowser(input: {
  exePath: string;
  url: string;
  profileDir: string;
  debugPort: number;
  logger: Logger;
}): void {
  const args = [
    "--remote-debugging-port=" + String(input.debugPort),
    "--user-data-dir=" + input.profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationHints",
    input.url,
  ];
  const child = spawn(input.exePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  input.logger.info("ds-free login helper launched a browser", {
    step: "dsfree.browser",
    status: "completed",
    debugPort: input.debugPort,
  });
}

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** 从调试端口列出页面目标（等浏览器把调试端口开起来） */
export async function waitForPageTarget(input: {
  debugPort: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  /** 只挑这个前缀的页面（默认 deepseek 登录页） */
  urlPrefix?: string;
}): Promise<CdpTarget | null> {
  const doFetch = input.fetchImpl ?? fetch;
  const deadline = Date.now() + (input.timeoutMs ?? 20_000);
  const prefix = input.urlPrefix ?? "https://chat.deepseek.com";
  while (Date.now() < deadline) {
    try {
      const response = await doFetch("http://127.0.0.1:" + String(input.debugPort) + "/json/list");
      if (response.ok) {
        const targets = (await response.json()) as CdpTarget[];
        const page = targets.find((target) => target.type === "page" && target.url.startsWith(prefix)) ?? targets.find((t) => t.type === "page");
        if (page !== undefined && typeof page.webSocketDebuggerUrl === "string") return page;
      }
    } catch {
      // 浏览器还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 500));
  }
  return null;
}

/** 在页面里执行一段表达式并拿回值（一次连接、一条命令，用完就关） */
export async function cdpEvaluate(input: {
  webSocketDebuggerUrl: string;
  expression: string;
  timeoutMs?: number;
  webSocketImpl?: typeof WebSocket;
}): Promise<unknown> {
  const WebSocketImpl = input.webSocketImpl ?? WebSocket;
  return await new Promise<unknown>((resolve) => {
    const socket = new WebSocketImpl(input.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // 已经关了
      }
      resolve(null);
    }, input.timeoutMs ?? 5000);

    const finish = (value: unknown): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已经关了
      }
      resolve(value);
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: input.expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    socket.addEventListener("message", (event: { data: unknown }) => {
      try {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } };
        if (frame.id !== 1) return;
        finish(frame.result?.result?.value ?? null);
      } catch {
        finish(null);
      }
    });
    socket.addEventListener("error", () => finish(null));
    socket.addEventListener("close", () => finish(null));
  });
}


/**
 * 反代进程（ds-free-api）的定位与拉起。
 *
 * 我们**不打包也不下载**它：那是别人 GPL-3.0 的开源项目（https://github.com/NIyueeE/ds-free-api）。
 * 这里只做两件事：在你机器上找到你已经下好的那个可执行文件；找到了就替你启动。
 *
 * 找的顺序：上次你填的路径 → 环境变量 COMPANION_DS_FREE_BIN → 本程序数据目录下 → 常见下载位置。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../core/ports/logger.ts";

export const DS_FREE_PROJECT_URL = "https://github.com/NIyueeE/ds-free-api";
/** 它自己的默认监听端口；我们的 provider 也默认指向这里 */
export const DS_FREE_DEFAULT_PORT = 22_217;

const BINARY_NAMES = ["ds-free-api.exe", "ds-free-api"];

export interface DsFreeProxyProcessDeps {
  logger: Logger;
  dataDir: string;
  /** 上次用户填的路径（一般为 null） */
  rememberedPath?: () => string | null;
  /** 记住这次用的路径，下次直接用 */
  rememberPath?: (path: string) => void;
  env?: Record<string, string | undefined>;
  existsImpl?: (path: string) => boolean;
  spawnImpl?: typeof spawn;
  /** 扫这些目录找可执行文件（默认含临时目录里最常见的下载位置） */
  searchRoots?: string[];
}

/** 在一个目录里最多找两层：`<root>/ds-free-api.exe` 或 `<root>/<子目录>/ds-free-api.exe` */
function scanRoot(root: string, exists: (path: string) => boolean, depth = 2): string | null {
  if (!exists(root)) return null;
  for (const name of BINARY_NAMES) {
    const direct = join(root, name);
    if (exists(direct)) return direct;
  }
  if (depth <= 0) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return null;
  }
  for (const entry of entries) {
    const found = scanRoot(entry, exists, depth - 1);
    if (found !== null) return found;
  }
  return null;
}

export function createDsFreeProxyProcess(deps: DsFreeProxyProcessDeps) {
  const exists = deps.existsImpl ?? existsSync;
  const run = deps.spawnImpl ?? spawn;
  const env = deps.env ?? process.env;

  function candidates(): Array<string | null> {
    const remembered = deps.rememberedPath?.() ?? null;
    const fromEnv = env["COMPANION_DS_FREE_BIN"] ?? null;
    const inData = BINARY_NAMES.map((name) => join(deps.dataDir, "ds-free-api", name));
    const envTemp = env["TEMP"] ?? env["TMP"] ?? tmpdir();
    // ponytail: 顺手扫一下临时目录里最常见的下载位置；扫不到就让用户填一次路径，不做全盘搜索
    const roots = deps.searchRoots ?? [join(envTemp, "dsfree"), join(env["LOCALAPPDATA"] ?? "", "Programs", "ds-free-api")];
    return [remembered, fromEnv, ...inData, ...roots];
  }

  return {
    /** 找到可执行文件就返回绝对路径，否则 null */
    locate(): string | null {
      for (const candidate of candidates()) {
        if (candidate === null || candidate.length === 0) continue;
        if (exists(candidate)) return candidate;
        const scanned = scanRoot(candidate, exists);
        if (scanned !== null) return scanned;
      }
      return null;
    },

    remember(path: string): void {
      deps.rememberPath?.(path);
    },

    /**
     * 起一个反代进程：独立进程、不阻塞我们，工作目录固定在我们的数据目录里，
     * 免得它把自己的 config.toml 写进代码仓库。
     */
    start(binaryPath: string): { ok: boolean; reason: string } {
      const workdir = join(deps.dataDir, "ds-free-api", "run");
      try {
        mkdirSync(workdir, { recursive: true });
        const child = run(binaryPath, [], { cwd: workdir, detached: true, stdio: "ignore" });
        child.unref();
        deps.logger.info("ds-free proxy process started", { step: "dsfree.proxy", status: "started", binary: binaryPath });
        return { ok: true, reason: "" };
      } catch (error) {
        const reason = (error as Error).message;
        deps.logger.warn("ds-free proxy process failed to start", { step: "dsfree.proxy", status: "failed", error: reason });
        return { ok: false, reason };
      }
    },

    /** 给界面看的一句话：去哪儿下、下完放哪儿 */
    guidance(): string {
      return "没找到反代程序。它是开源项目 ds-free-api（" + DS_FREE_PROJECT_URL + "），需要你自己下载：解压后把 ds-free-api(.exe) 放到 " + join(deps.dataDir, "ds-free-api") + "，或在下面填一次它的完整路径。";
    },
  };
}

export type DsFreeProxyProcess = ReturnType<typeof createDsFreeProxyProcess>;

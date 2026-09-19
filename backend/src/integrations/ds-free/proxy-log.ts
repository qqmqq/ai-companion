/**
 * 反代怎么了：读它自己的运行日志，给一句人话 + 最近几条 WARN/ERROR。
 *
 * 为什么需要它：账号被风控 / 掉登录时，反代会在内部不停重试，我们这侧只能看到 60 秒超时 ——
 * 用户看到的就是「ai 反代又超时了」，而真正的原因写在它的日志里。
 *
 * 纪律：日志里可能有手机号等个人信息，输出前一律把长数字串打码；只回最近几条，不做全量回传。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProxyDiagnosis {
  /** 没看出问题就是 true */
  ok: boolean;
  summary: string;
  /** 最近几条 WARN/ERROR（已打码） */
  lines: string[];
  logPath: string;
}

/** 把长数字串打码（手机号、账号 id 之类），保留头 3 位与尾 4 位 */
export function maskDigits(text: string): string {
  return text.replace(/\d{8,}/g, (digits) => digits.slice(0, 3) + "****" + digits.slice(-4));
}

/** 按日志内容判一句人话（顺序有意义：越具体的越靠前） */
const RULES: Array<{ pattern: RegExp; summary: string }> = [
  {
    // 先因后果：muted 是原因，「账号池无可用账号」只是症状
    pattern: /muted|账号异常|biz_code.:5/i,
    summary: "这个 DeepSeek 账号被风控禁言了（user is muted）：等它解禁，或者换一个账号。反代拿不到可用账号时只能空转重试，所以我们这边看到的是超时。",
  },
  {
    pattern: /账号池无可用账号|no available account/i,
    summary: "反代现在没有可用账号：账号掉登录或被风控了，它只能空转重试，所以我们这边看到的是超时。",
  },
  {
    pattern: /PASSWORD_OR_USER_NAME_IS_WRONG/i,
    summary: "账号或密码不对：反代登录被拒，账号池里那条一直用不上。",
  },
  {
    pattern: /service overloaded|too many requests|429/i,
    summary: "DeepSeek 网页端在过载（429）：等一会儿再试。",
  },
  {
    pattern: /Invalid|re-login failed/i,
    summary: "反代把某个账号标成了无效（登录失败多次）：检查账号密码，或换一个账号。",
  },
];

export function readProxyDiagnosis(input: {
  dataDir: string;
  /** 测试注入 */
  existsImpl?: (path: string) => boolean;
  readImpl?: (path: string) => string;
  maxLines?: number;
}): ProxyDiagnosis {
  const exists = input.existsImpl ?? existsSync;
  const read = input.readImpl ?? ((path: string) => readFileSync(path, "utf8"));
  const logPath = join(input.dataDir, "ds-free-api", "run", "logs", "runtime.log");
  if (!exists(logPath)) {
    return {
      ok: false,
      summary: "没找到反代日志（它可能没在跑，或者工作目录不是 data/ds-free-api/run）。先点「打开登录页并自动获取」让它起来。",
      lines: [],
      logPath,
    };
  }

  let raw = "";
  try {
    raw = read(logPath);
  } catch (error) {
    return { ok: false, summary: "读不了反代日志：" + (error as Error).message, lines: [], logPath };
  }

  const all = raw.split("\n").filter((line) => line.trim().length > 0);
  // 只看最近一段，避免一次性扫整份日志
  const recent = all.slice(-1500);
  const notable = recent
    .filter((line) => line.includes(" ERROR ") || line.includes(" WARN "))
    .slice(-(input.maxLines ?? 8))
    .map((line) => maskDigits(line.trim()));

  const haystack = recent.join("\n");
  const hit = RULES.find((rule) => rule.pattern.test(haystack));
  if (hit !== undefined) return { ok: false, summary: hit.summary, lines: notable, logPath };
  return {
    ok: true,
    summary: notable.length === 0 ? "最近没有明显报错。" : "最近没有致命错误，但有一些警告（见下）。",
    lines: notable,
    logPath,
  };
}

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageMeta {
  version?: string;
  ilink_appid?: string;
}

function readOwnPackage(): PackageMeta {
  try {
    const pkg = require("../../../../package.json") as PackageMeta;
    return pkg;
  } catch {
    return {};
  }
}

const meta = readOwnPackage();

/** iLink-App-Id：与参考实现保持一致的应用标识（不是密钥） */
export const ILINK_APP_ID = typeof meta.ilink_appid === "string" && meta.ilink_appid.length > 0 ? meta.ilink_appid : "bot";

export const CHANNEL_VERSION = typeof meta.version === "string" ? meta.version : "0.0.0";

/** bot_agent 只用于可观测性，不是凭证 */
export const DEFAULT_BOT_AGENT = "AI-Companion";

export function clientVersionCode(version: string = CHANNEL_VERSION): string {
  const [major = 0, minor = 0, patch = 0] = version
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const code = ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
  return String(code);
}

/**
 * UA 语法净化：`Name/Version` 允许最多 32 字符，其后可跟一个空格 + `(comment)`。
 * 非法 token 丢弃；全部非法或为空时回退默认值；结果上限 256 字节。
 */
export function sanitizeBotAgent(raw: string | undefined, fallback = DEFAULT_BOT_AGENT): string {
  if (raw === undefined) return fallback;
  const PRODUCT = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const COMMENT = /^\([\x20-\x27\x2A-\x7E]{1,64}\)$/;

  const parts: string[] = [];
  let lastWasProduct = false;
  for (const token of raw.trim().split(/\s+/)) {
    if (PRODUCT.test(token)) {
      parts.push(token);
      lastWasProduct = true;
      continue;
    }
    // 注释必须紧跟在一个合法的 product 之后
    if (lastWasProduct && COMMENT.test(token)) {
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${token}`;
      lastWasProduct = false;
      continue;
    }
    lastWasProduct = false;
  }

  const joined = parts.join(" ").trim();
  if (joined.length === 0) return fallback;
  return joined.length > 256 ? joined.slice(0, 256) : joined;
}
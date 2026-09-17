export const SENSITIVE_KEYS = [
  "token",
  "bot_token",
  "access_token",
  "refresh_token",
  "context_token",
  "typing_ticket",
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "secret",
  "password",
  "passphrase",
  "ciphertext",
  "private_key",
  "master_key",
] as const;

const SENSITIVE = new Set<string>(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
const MASK = "«redacted»";
const MAX_STRING = 512;

export function redactToken(token: string | null | undefined, prefixLen = 6): string {
  if (!token) return "(none)";
  if (token.length <= prefixLen) return `****(len=${token.length})`;
  return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const hadQuery = url.search.length > 0;
    return `${url.origin}${url.pathname}${hadQuery ? "?«redacted»" : ""}`;
  } catch {
    return `«unparseable-url len=${rawUrl.length}»`;
  }
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // 关键：字符串值也要过一遍内联清洗，否则 "token=xxx" 这类裸文本会绕过键名匹配。
    const scrubbed = redactText(value);
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, 64)}…(len=${scrubbed.length})` : scrubbed;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 6) return "«max-depth»";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE.has(key.toLowerCase()) ? MASK : redactValue(item, depth + 1);
    }
    return out;
  }
  return "«unserializable»";
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return redactValue(headers) as Record<string, unknown>;
}

/**
 * 兜底文本清洗：即使调用方忘了传字段名，也不允许明显形态的凭据进入日志。
 */
export function redactText(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 «redacted»")
    .replace(/\b(api[-_]?key|token|secret|password)\s*[=:]\s*["']?[A-Za-z0-9._~+\/=-]{6,}/gi, "$1=«redacted»");
}

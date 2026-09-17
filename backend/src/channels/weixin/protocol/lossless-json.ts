/**
 * uint64 安全解析。
 *
 * 线上 message_id / msg_id / svr_id 是裸 JSON 数字，超过 2^53 会被 JSON.parse 静默改变数值。
 * 这里在解析前把这些键的数字字面量加引号，从而无损地得到字符串。
 * 字符串内部的同名内容不会被误改（扫描时跳过字符串）。
 */
const UINT64_KEYS = ["message_id", "msg_id", "svr_id"] as const;

export function quoteUint64Fields(raw: string): string {
  let out = "";
  let index = 0;
  let inString = false;

  while (index < raw.length) {
    const ch = raw[index]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += raw[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      // 判断这个字符串是不是某个 uint64 键的 key
      const match = /^"([A-Za-z0-9_]+)"\s*:/.exec(raw.slice(index));
      if (match !== null && (UINT64_KEYS as readonly string[]).includes(match[1]!)) {
        out += `"${match[1]}": `;
        let cursor = index + match[0].length;
        while (cursor < raw.length && /\s/.test(raw[cursor]!)) cursor += 1;
        if (raw[cursor] === '"') {
          // 服务端已经给了字符串，原样复制
          let end = cursor + 1;
          while (end < raw.length) {
            if (raw[end] === "\\") {
              end += 2;
              continue;
            }
            if (raw[end] === '"') break;
            end += 1;
          }
          out += raw.slice(cursor, end + 1);
          index = end + 1;
          continue;
        }
        let end = cursor;
        while (end < raw.length && /[0-9.eE+-]/.test(raw[end]!)) end += 1;
        const literal = raw.slice(cursor, end);
        if (literal.length > 0 && /^-?\d+$/.test(literal)) {
          out += `"${literal}"`;
          index = end;
          continue;
        }
      }
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

export function parseLossless<T>(raw: string): T {
  return JSON.parse(quoteUint64Fields(raw)) as T;
}

/** 统一的 id 归一化：数字/字符串都转成十进制字符串，绝不走 Number */
export function toIdString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return value.toString();
  return null;
}

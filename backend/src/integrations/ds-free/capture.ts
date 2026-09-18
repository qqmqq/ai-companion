/**
 * 从真实页面里"自动获取所需"。
 *
 * 需要的东西只有一件：**device_id**（数美设备指纹）。缺了它，反代登录会被风控拦（RISK_DEVICE_DETECTED）。
 * 官方文档给的两个办法是：看 Network 里登录请求的 payload，或在控制台执行 SMSdk.getDeviceId()。
 * 这里就是把后者自动化。
 */

/** 页面表达式：优先问数美 SDK，退而求其次扫 localStorage 里像设备号的键 */
export const DEVICE_ID_EXPRESSION = [
  "(() => {",
  "  try { if (window.SMSdk && typeof window.SMSdk.getDeviceId === \"function\") { const v = window.SMSdk.getDeviceId(); if (v) return v; } } catch (e) {}",
  "  try {",
  "    const keys = Object.keys(window.localStorage || {});",
  "    for (const k of keys) { if (/device|smid|fingerprint/i.test(k)) { const v = window.localStorage.getItem(k); if (v && v.length >= 16) return v; } }",
  "  } catch (e) {}",
  "  return null;",
  "})()",
].join(String.fromCharCode(10));

/** 页面表达式：判断页面状态（登录态只作为提示，不作为硬门槛） */
export const PAGE_STATE_EXPRESSION = [
  "(() => {",
  "  try {",
  "    const keys = Object.keys(window.localStorage || {});",
  "    return {",
  "      url: String(location.href),",
  "      hasSmsdk: !!(window.SMSdk && window.SMSdk.getDeviceId),",
  "      tokenKeys: keys.filter((k) => /token|session|user/i.test(k)).slice(0, 8),",
  "    };",
  "  } catch (e) { return null; }",
  "})()",
].join(String.fromCharCode(10));

/** 把页面返回值收成干净的 device id（空值、占位值一律当没拿到） */
export function extractDeviceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < 16 || value.length > 512) return null;
  if (value === "null" || value === "undefined") return null;
  return value;
}

export interface PageState {
  url: string;
  hasSmsdk: boolean;
  tokenKeys: string[];
}

export function parsePageState(raw: unknown): PageState | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    url: typeof record.url === "string" ? record.url : "",
    hasSmsdk: record.hasSmsdk === true,
    tokenKeys: Array.isArray(record.tokenKeys) ? record.tokenKeys.filter((k): k is string => typeof k === "string") : [],
  };
}

/** 给界面看的一句话状态（不暴露任何密钥） */
export function describePageState(state: PageState | null): string {
  if (state === null) return "还没读到页面（浏览器可能还在启动）";
  if (state.hasSmsdk) return "已读到页面，设备指纹 SDK 就绪";
  return "页面已打开，但还没等到风控 SDK（保持页面打开，或先完成一次登录）";
}


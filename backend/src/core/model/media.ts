/**
 * 通用媒体模型（平台无关、Provider 无关、Channel 无关）。
 *
 * 设计要点（Phase 4.5-A）：
 * 1. 消息里保存的是**媒体引用与元数据**，不是二进制内容；实际文件将来由 MediaStorage 管理。
 * 2. 这里不出现任何平台概念（微信/CDN/加密参数/Silk 等），也不出现任何模型厂商概念。
 * 3. 元数据全部有长度上限，防止"异常大的字段"无限流入 Core。
 * 4. url 必须显式标注来源（internal/external）：Core **绝不**因为收到 url 就去请求网络，
 *    外部 URL 只是数据，是否访问由未来的 Browser/Network 权限系统决定。
 */

export type MediaKind = "image" | "audio" | "video" | "file";

/** 最小媒体状态：够表达"还没就绪 / 可用 / 失败 / 已过期"，不做复杂状态机。 */
export type MediaStatus = "pending" | "available" | "failed" | "expired";

/** 媒体从哪来：渠道收到 / 系统生成 / 外部引用。 */
export type MediaOrigin = "channel" | "generated" | "external";

/**
 * URL 引用。kind 明确区分内部存储地址与外部地址；
 * 外部地址不允许被 Core 自动请求。
 */
export interface MediaUrl {
  kind: "internal" | "external";
  value: string;
}

export interface MediaReference {
  /** 指向 MediaStorage 的引用；Phase 4.5-B 之前可能为 null（例如只有元数据） */
  mediaId: string | null;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  origin: MediaOrigin;
  status: MediaStatus;
  url: MediaUrl | null;
}

export const MEDIA_LIMITS = {
  maxMediaIdLength: 120,
  maxMimeTypeLength: 120,
  maxFilenameLength: 200,
  maxUrlLength: 2000,
  /** 单条消息最多 part 数，防止一条消息塞爆内存与上下文 */
  maxPartsPerMessage: 32,
  maxTextPartLength: 20_000,
  /**
   * 单个媒体资产的字节上限（25 MiB）。
   * 与 Phase 4 报告里记录的"参考实现单文件上限"一致；上传/下载都以此为准，
   * 避免出现多个互相冲突的大小限制。
   */
  maxMediaBytes: 25 * 1024 * 1024,
  /** 单个媒体资产的元数据上限（sidecar JSON），防止元数据无限增长 */
  maxMediaMetadataBytes: 16 * 1024,
} as const;

export function isWithinMediaSizeLimit(sizeBytes: number, limitBytes: number = MEDIA_LIMITS.maxMediaBytes): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= limitBytes;
}

const MIME_PATTERN = /^[a-zA-Z0-9!#$&^_.+-]{1,60}\/[a-zA-Z0-9!#$&^_.+-]{1,60}(;\s*[^;]{1,60})*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function clampString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function clampCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : null;
}

export function sanitizeMimeType(value: unknown): string | null {
  const cleaned = clampString(value, MEDIA_LIMITS.maxMimeTypeLength);
  if (cleaned === null) return null;
  return MIME_PATTERN.test(cleaned) ? cleaned.toLowerCase() : null;
}

export function sanitizeFilename(value: unknown): string | null {
  const cleaned = clampString(value, MEDIA_LIMITS.maxFilenameLength);
  if (cleaned === null) return null;
  // 去掉任何路径成分：文件名只是展示与下载提示，不允许携带路径
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return base.length > 0 ? base : null;
}

export function sanitizeMediaUrl(value: unknown, kind: MediaUrl["kind"] = "external"): MediaUrl | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const cleaned = clampString(value, MEDIA_LIMITS.maxUrlLength);
    return cleaned === null ? null : { kind, value: cleaned };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const rawKind = record.kind === "internal" ? "internal" : "external";
    const cleaned = clampString(record.value, MEDIA_LIMITS.maxUrlLength);
    return cleaned === null ? null : { kind: rawKind, value: cleaned };
  }
  return null;
}

export function emptyMediaReference(origin: MediaOrigin = "channel"): MediaReference {
  return {
    mediaId: null,
    mimeType: null,
    filename: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    origin,
    status: "pending",
    url: null,
  };
}

export interface MediaReferenceInput {
  mediaId?: unknown;
  mimeType?: unknown;
  filename?: unknown;
  sizeBytes?: unknown;
  width?: unknown;
  height?: unknown;
  durationMs?: unknown;
  origin?: unknown;
  status?: unknown;
  url?: unknown;
}

const ORIGINS: MediaOrigin[] = ["channel", "generated", "external"];
const STATUSES: MediaStatus[] = ["pending", "available", "failed", "expired"];

/** 任何来源的媒体元数据都必须经过这里：截断、净化、规范化。 */
export function sanitizeMediaReference(input: MediaReferenceInput = {}): MediaReference {
  const origin = ORIGINS.includes(input.origin as MediaOrigin) ? (input.origin as MediaOrigin) : "channel";
  const status = STATUSES.includes(input.status as MediaStatus) ? (input.status as MediaStatus) : "pending";
  return {
    mediaId: clampString(input.mediaId, MEDIA_LIMITS.maxMediaIdLength),
    mimeType: sanitizeMimeType(input.mimeType),
    filename: sanitizeFilename(input.filename),
    sizeBytes: clampCount(input.sizeBytes),
    width: clampCount(input.width),
    height: clampCount(input.height),
    durationMs: clampCount(input.durationMs),
    origin,
    status,
    url: sanitizeMediaUrl(input.url, origin === "external" ? "external" : "internal"),
  };
}

export function hasMediaPayload(media: MediaReference): boolean {
  return media.mediaId !== null || media.url !== null;
}

/** 上下文用的文本表示：只描述"有什么"，绝不 stringify 元数据。 */
export function describeMedia(kind: MediaKind, media: MediaReference): string {
  const name = media.filename;
  switch (kind) {
    case "image":
      return "[图片]";
    case "audio":
      return "[语音]";
    case "video":
      return "[视频]";
    case "file":
      return name === null ? "[文件]" : `[文件: ${name}]`;
  }
}

/**
 * 外部 URL 永远是"数据"，不是"行动指令"。
 * Core 只在明确的、用户授权的流程里才会去取媒体，本阶段完全不实现下载。
 */
export function isExternalMedia(media: MediaReference): boolean {
  return media.origin === "external" || media.url?.kind === "external";
}
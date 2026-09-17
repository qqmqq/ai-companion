import type { MediaKind } from "../model/media.ts";

/**
 * 媒体传输端口（平台无关）。
 *
 * Core 只知道"把这段字节交给某个渠道的传输层 / 从它那里取回字节"，
 * 不知道 CDN、加密参数、密钥编码等任何实现细节。
 *
 * 注意 `handle` 与 `secretMaterial` 的分工：
 * - handle：**可以出现在日志/快照/消息里**的非敏感引用（尺寸、时间、渠道侧文件 id）
 * - secretMaterial：**只能进加密凭证存储**的敏感材料（例如解密所需的密钥与下载参数），
 *   绝不允许写日志、写消息、写快照、写普通 API 响应。
 */
export interface MediaUploadRequest {
  accountId: string;
  /** 会话/对端引用，由渠道决定含义 */
  conversationRef: string;
  kind: MediaKind;
  bytes: Uint8Array;
  mimeType: string | null;
  filename: string | null;
  signal?: AbortSignal;
}

export interface MediaHandle {
  provider: string;
  mediaId: string | null;
  sizeBytes: number;
  /** 渠道侧加密后的大小（仅用于诊断，非敏感） */
  transferredSizeBytes: number;
  mimeType: string | null;
  filename: string | null;
  uploadedAt: string;
}

export interface MediaUploadResult {
  handle: MediaHandle;
  /** 必须写入加密凭证存储；调用方不得把它放进日志/消息/快照/API */
  secretMaterial: Record<string, string>;
}

export interface MediaDownloadRequest {
  accountId: string;
  handle: MediaHandle;
  /** 敏感材料，从加密凭证存储取回 */
  secretMaterial: Record<string, string>;
  expectedMimeType?: string | null;
  signal?: AbortSignal;
}

export interface MediaDownloadResult {
  bytes: Uint8Array;
  mimeType: string | null;
  sizeBytes: number;
}

export interface MediaTransport {
  readonly kind: string;
  upload(request: MediaUploadRequest): Promise<MediaUploadResult>;
  download(request: MediaDownloadRequest): Promise<MediaDownloadResult>;
}

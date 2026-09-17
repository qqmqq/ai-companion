import type { MediaOrigin } from "../model/media.ts";

/**
 * 媒体存储端口（平台无关）。
 *
 * Core 只认 `mediaId`：它由我们自己的存储产生，与任何渠道的 CDN 标识没有关系。
 * 二进制内容不进消息表、不进日志、不进上下文快照。
 */
export interface MediaPutInput {
  bytes: Uint8Array;
  mimeType: string | null;
  filename: string | null;
  origin: MediaOrigin;
}

export interface MediaAsset {
  mediaId: string;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number;
  /** sha256 十六进制：用于完整性校验，不可逆，不泄漏内容 */
  checksum: string;
  origin: MediaOrigin;
  createdAt: string;
}

export interface MediaReadResult extends MediaAsset {
  bytes: Uint8Array;
}

export interface MediaStorage {
  readonly kind: string;
  /** 写入并返回元数据（调用方只拿到 mediaId，拿不到路径细节） */
  put(input: MediaPutInput): Promise<MediaAsset>;
  /** 读取元数据 + 字节；不存在返回 null */
  get(mediaId: string): Promise<MediaReadResult | null>;
  /** 只读元数据 */
  stat(mediaId: string): Promise<MediaAsset | null>;
  has(mediaId: string): Promise<boolean>;
  /** 删除，返回是否真的删掉了 */
  remove(mediaId: string): Promise<boolean>;
}

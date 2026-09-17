import type { BaseInfo } from "./types.ts";

/**
 * 微信媒体相关的协议类型（Phase 4.5-B）。
 * 字段取值依据 Phase 0 研究报告（docs/AI-COMPANION-ARCHITECTURE-REPORT.md §3.7）与
 * 参考实现的行为，不自行发明字段。
 */

/** getUploadUrl 的 media_type：1 图片 / 2 视频 / 3 文件 / 4 语音 */
export const UPLOAD_MEDIA_TYPE_IMAGE = 1;
export const UPLOAD_MEDIA_TYPE_VIDEO = 2;
export const UPLOAD_MEDIA_TYPE_FILE = 3;
export const UPLOAD_MEDIA_TYPE_VOICE = 4;

export interface GetUploadUrlRequest {
  /** 客户端生成的 16 字节 filekey（十六进制字符串） */
  filekey: string;
  media_type: number;
  to_user_id: string;
  /** 明文大小 */
  rawsize: number;
  /** 明文 md5（十六进制） */
  rawfilemd5: string;
  /** PKCS#7 填充后的密文大小 */
  filesize: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  /** Phase 4.5-B 不上传缩略图 */
  no_need_thumb: true;
  /** 16 字节密钥的十六进制字符串 */
  aeskey: string;
  base_info: BaseInfo;
}

export interface GetUploadUrlResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

/** 下载/发送消息时使用的媒体引用（`encrypt_type` 0=仅 fileid，1=打包缩略图/中图信息） */
export interface CdnMediaReference {
  encrypt_query_param: string;
  /** base64(十六进制密钥字符串) */
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export const CDN_ENCRYPT_TYPE_PACKED = 1;

export interface CdnUploadSuccess {
  /** 服务器返回的下载参数（来自 x-encrypted-param 响应头） */
  downloadParam: string;
  url: string;
}

export interface CdnDownloadResult {
  bytes: Uint8Array;
  mimeType: string | null;
  contentLength: number | null;
}
/**
 * 入站图片消息里的媒体对象。
 * 字段名与 docs/protocol.md 的 Message model / Media fields 一致：
 * - `image_item.aeskey`：32 位十六进制密钥，优先级高于 `media.aes_key`
 * - `image_item.mid_size`：发送方写入的**密文**字节数
 * - `media.encrypt_query_param` / `media.full_url`：下载引用（full_url 优先）
 * - `media.aes_key`：base64（16 原始字节 或 32 位十六进制字符串）
 */
export interface WeixinCdnMediaObject {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0 = 仅 fileid，1 = 打包缩略图/中图信息 */
  encrypt_type?: number;
  full_url?: string;
}

export interface WeixinImageItem {
  media?: WeixinCdnMediaObject;
  thumb_media?: WeixinCdnMediaObject;
  aeskey?: string;
  mid_size?: number;
  url?: string;
}

/** 出站图片 item 的线上结构（一次 sendmessage 只带一个 item） */
export interface OutboundImageItem {
  type: typeof UPLOAD_MEDIA_TYPE_IMAGE_ITEM_TYPE;
  image_item: {
    media: {
      encrypt_query_param: string;
      /** base64(32 位十六进制密钥字符串) */
      aes_key: string;
      encrypt_type: number;
    };
    /** 密文字节数 */
    mid_size: number;
  };
}

/** item_list 里的图片类型码（与 getUploadUrl 的 media_type 是两套编号） */
export const UPLOAD_MEDIA_TYPE_IMAGE_ITEM_TYPE = 2;

/**
 * 入站视频消息里的媒体对象（Phase 4.5-C3）。
 *
 * 字段依据 docs/AI-COMPANION-ARCHITECTURE-REPORT.md §3.6/§3.7（Phase 0 协议研究）：
 * - `video_item.media`：与图片同构的 CDN 引用（encrypt_query_param / full_url / aes_key / encrypt_type）；
 * - `video_item.video_size`：发送方写入的**密文**字节数（与图片的 `mid_size` 同类，不是明文大小）；
 * - `video_item.thumb_media`：缩略图引用（本阶段不使用，也不生成缩略图）；
 * - 视频没有 `aeskey` 字段：密钥只能来自 `media.aes_key`；
 * - 协议**没有**提供宽高、时长或 MIME：这三个值必须保持 null / 安全兜底，绝不为了拿到它们去解码视频。
 */
export interface WeixinVideoItem {
  media?: WeixinCdnMediaObject;
  thumb_media?: WeixinCdnMediaObject;
  /** 密文字节数（诊断用） */
  video_size?: number;
  url?: string;
}

/**
 * 入站文件消息里的媒体对象（Phase 4.5-C2）。
 *
 * 字段依据 docs/AI-COMPANION-ARCHITECTURE-REPORT.md §3.6/§3.7（Phase 0 协议研究）：
 * - `file_item.media`：与图片同构的 CDN 引用（encrypt_query_param / full_url / aes_key / encrypt_type）；
 * - `file_item.file_name`：发送方给出的文件名（不可信输入，入库前必须净化）；
 * - `file_item.len`：**明文**字节数的十进制字符串（不是密文大小，也没有 mid_size 字段）；
 * - 文件没有 `aeskey` 字段：密钥只能来自 `media.aes_key`。
 */

export interface WeixinFileItem {
  media?: WeixinCdnMediaObject;
  file_name?: string;
  /** 明文字节数的十进制字符串 */
  len?: string | number;
}

/**
 * 入站语音消息里的媒体对象（Phase 4.5-D1）。
 *
 * 字段依据 docs/AI-COMPANION-ARCHITECTURE-REPORT.md §3.6/§3.7（Phase 0 协议研究）：
 * - `voice_item.media`：与图片/视频同构的 CDN 引用（encrypt_query_param / full_url / aes_key / encrypt_type）；
 * - 语音**没有** `aeskey` 字段：密钥只能来自 `media.aes_key`（文档："语音/文件/视频必须有 media.aes_key"）。
 *
 * 注意：协议资料里**没有**语音的大小/时长/MIME 字段（图片有 mid_size、视频有 video_size、文件有 len；
 * 语音那一行只说明 media_type:4 在参考实现的**发送链路从未被使用**）。因此这里不发明 voice_size 之类的字段。
 */
export interface WeixinVoiceItem {
  media?: WeixinCdnMediaObject;
}

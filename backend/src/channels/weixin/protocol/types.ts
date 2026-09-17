/**
 * 微信 iLink Backend 线上类型（只覆盖 Phase 4 需要的文本消息子集）。
 * 所有 uint64 一律用 string 保存，绝不进入 JS Number。
 */
import type { WeixinFileItem, WeixinImageItem, WeixinVideoItem, WeixinVoiceItem } from "./media-types.ts";

export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;

export const MESSAGE_STATE_NEW = 0;
export const MESSAGE_STATE_GENERATING = 1;
export const MESSAGE_STATE_FINISH = 2;

export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;

export const TYPING_STATUS_TYPING = 1;
export const TYPING_STATUS_CANCEL = 2;

/** -14：token 失效，必须停止轮询并等待重新登录 */
export const STALE_TOKEN_ERRCODE = -14;

export interface BaseInfo {
  channel_version: string;
  bot_agent: string;
}

export interface TextItem {
  type: typeof ITEM_TYPE_TEXT;
  text_item: { text: string };
}

export interface MessageItem {
  type: number;
  msg_id?: string;
  create_time_ms?: number;
  is_completed?: boolean;
  text_item?: { text?: string };
  image_item?: WeixinImageItem;
  file_item?: WeixinFileItem;
  video_item?: WeixinVideoItem;
  voice_item?: WeixinVoiceItem;
  /** 引用消息（Phase 4 只读取文本，不做媒体还原） */
  ref_msg?: {
    svr_id?: string;
    title?: string;
    message_item?: { msg_id?: string; text_item?: { text?: string } };
  };
}

export interface WeixinMessage {
  seq?: string | number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** 会话上下文令牌：必须先回传才能发送 */
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageRequest {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    item_list: MessageItem[];
    context_token?: string;
    run_id?: string;
  };
  base_info: BaseInfo;
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  message_id?: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

export interface QrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrStatusResponse {
  status?: QrStatus | string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  errcode?: number;
  errmsg?: string;
}
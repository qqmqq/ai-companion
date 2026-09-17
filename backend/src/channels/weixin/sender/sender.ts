import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import type { WeixinHttp } from "../protocol/http-client.ts";
import { ENDPOINTS, buildUrl } from "../protocol/endpoints.ts";
import { MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT, STALE_TOKEN_ERRCODE, ITEM_TYPE_TEXT, ITEM_TYPE_IMAGE, ITEM_TYPE_FILE, ITEM_TYPE_VIDEO, ITEM_TYPE_VOICE, type SendMessageResponse } from "../protocol/types.ts";
import { CDN_ENCRYPT_TYPE_PACKED } from "../protocol/media-types.ts";
import { WeixinTransportError } from "../protocol/errors.ts";
import { computeBackoffMs, sleep as defaultSleep } from "../protocol/backoff.ts";
import { toIdString } from "../protocol/lossless-json.ts";
import { buildBaseInfo } from "../protocol/headers.ts";
import type { WeixinSecretStore } from "../auth/account-secret.ts";

export interface SendTextInput {
  accountId: string;
  toUserId: string;
  conversationRef: string;
  text: string;
  /** 幂等键：同一次 Core 响应重复发送时必须复用 */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface SendTextResult {
  providerMessageId: string | null;
  attempts: number;
  contextTokenUsed: boolean;
}

export interface SendImageInput {
  accountId: string;
  toUserId: string;
  conversationRef: string;
  /** 已上传的媒体引用（来自 MediaTransport.upload 的 secretMaterial） */
  encryptQueryParam: string;
  /** base64(十六进制密钥字符串)：协议里 image_item.media.aes_key 的形态 */
  aesKeyProtocolBase64: string;
  /** 密文字节数：协议里 image_item.mid_size */
  ciphertextSizeBytes: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface SendVoiceInput {
  accountId: string;
  toUserId: string;
  conversationRef: string;
  /** 已上传的媒体引用（来自 MediaTransport.upload 的 secretMaterial） */
  encryptQueryParam: string;
  /** base64(十六进制密钥字符串)：协议里 voice_item.media.aes_key 的形态 */
  aesKeyProtocolBase64: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface SendFileInput {
  accountId: string;
  toUserId: string;
  conversationRef: string;
  /** 已上传的媒体引用（来自 MediaTransport.upload 的 secretMaterial） */
  encryptQueryParam: string;
  /** base64(十六进制密钥字符串)：协议里 file_item.media.aes_key 的形态 */
  aesKeyProtocolBase64: string;
  /** 已净化的文件名（不允许携带路径） */
  fileName: string;
  /** **明文**字节数：协议里 file_item.len 是十进制字符串 */
  plaintextSizeBytes: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface SendVideoInput {
  accountId: string;
  toUserId: string;
  conversationRef: string;
  /** 已上传的媒体引用（来自 MediaTransport.upload 的 secretMaterial） */
  encryptQueryParam: string;
  /** base64(十六进制密钥字符串)：协议里 video_item.media.aes_key 的形态 */
  aesKeyProtocolBase64: string;
  /** **密文**字节数：协议里 video_item.video_size 是与图片 mid_size 同类的密文字节数 */
  ciphertextSizeBytes: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface WeixinSenderDeps {
  http: WeixinHttp;
  secrets: WeixinSecretStore;
  logger: Logger;
  clock: Clock;
  botAgent?: string;
  baseUrl: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 发送失败语义：可重试的一律退避重试；凭证失效立刻上抛，不进入无限重试。 */
export function createWeixinSender(deps: WeixinSenderDeps) {
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;

  /**
   * 一次 sendmessage 只带一个 item（协议要求）。文字/图片/文件共用这条发送/重试路径，
   * 不额外发明第二套重试、幂等或 session 处理。
   */
  async function sendItem(input: {
    accountId: string;
    toUserId: string;
    conversationRef: string;
    item: Record<string, unknown>;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<SendTextResult> {
      const secret = await deps.secrets.load(input.accountId);
      const baseUrl = secret.baseUrl.length > 0 ? secret.baseUrl : deps.baseUrl;
      const contextToken = secret.contextTokens[input.conversationRef] ?? null;
      if (contextToken === null) {
        deps.logger.warn("weixin send without context token; server may reject", { accountId: input.accountId });
      }

      const body = {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: input.idempotencyKey,
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [input.item],
          ...(contextToken === null ? {} : { context_token: contextToken }),
        },
        base_info: buildBaseInfo(deps.botAgent),
      };

      let lastError: unknown = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const response = await deps.http.postJson<SendMessageResponse>(
            buildUrl(baseUrl, ENDPOINTS.sendMessage),
            body,
            { label: "sendmessage", ...(input.signal === undefined ? {} : { signal: input.signal }) },
          );

          const ret = response.ret ?? 0;
          const errcode = response.errcode ?? 0;
          if (ret === STALE_TOKEN_ERRCODE || errcode === STALE_TOKEN_ERRCODE) {
            throw new WeixinTransportError("stale_token", "微信凭证已失效（errcode -14）", { retryable: false });
          }
          if (ret !== 0 || errcode !== 0) {
            throw new WeixinTransportError("business", `发送被拒绝：ret=${ret} errcode=${errcode} ${response.errmsg ?? ""}`.trim(), {
              retryable: false,
            });
          }
          return { providerMessageId: toIdString(response.message_id), attempts: attempt + 1, contextTokenUsed: contextToken !== null };
        } catch (error) {
          lastError = error;
          const transport = error instanceof WeixinTransportError ? error : null;
          if (transport?.kind === "stale_token") throw error;
          if (transport?.kind === "aborted") throw error;
          const retryable = transport === null || transport.retryable;
          const isLast = attempt === maxAttempts - 1;
          if (!retryable || isLast) throw error;
          const delay = computeBackoffMs(attempt, {
            baseMs: deps.baseDelayMs ?? 500,
            maxMs: deps.maxDelayMs ?? 10_000,
            ...(deps.jitterRatio === undefined ? {} : { jitterRatio: deps.jitterRatio }),
            ...(deps.random === undefined ? {} : { random: deps.random }),
          });
          deps.logger.warn("weixin send failed; retrying", {
            attempt: attempt + 1,
            maxAttempts,
            delayMs: delay,
            kind: transport?.kind ?? "unknown",
          });
          await sleepImpl(delay, input.signal);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("weixin send failed");
  }

  return {
    sendText(input: SendTextInput): Promise<SendTextResult> {
      return sendItem({
        accountId: input.accountId,
        toUserId: input.toUserId,
        conversationRef: input.conversationRef,
        item: { type: ITEM_TYPE_TEXT, text_item: { text: input.text } },
        idempotencyKey: input.idempotencyKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    /**
     * 文件消息：file_item.media + file_name + len（明文字节数的十进制字符串）。
     * 与图片共用同一条发送/重试/幂等路径，只是 item 形状不同。
     */
    sendFile(input: SendFileInput): Promise<SendTextResult> {
      return sendItem({
        accountId: input.accountId,
        toUserId: input.toUserId,
        conversationRef: input.conversationRef,
        item: {
          type: ITEM_TYPE_FILE,
          file_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyProtocolBase64,
              encrypt_type: CDN_ENCRYPT_TYPE_PACKED,
            },
            file_name: input.fileName,
            // 十进制字符串：避免任何整数精度问题，也与协议一致
            len: String(input.plaintextSizeBytes),
          },
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    /**
     * 语音消息：voice_item.media。
     *
     * 注意（诚实说明）：协议资料只确认了 `media_type:4` 与 item 类型码 `3`，
     * 参考实现的**发送链路从未发过语音**，因此语音 item 除 `media` 之外是否还需要别的字段
     * 无法从现有资料确认；这里只发送与图片/视频/文件同构的 `media`（不发明字段）。
     */
    sendVoice(input: SendVoiceInput): Promise<SendTextResult> {
      return sendItem({
        accountId: input.accountId,
        toUserId: input.toUserId,
        conversationRef: input.conversationRef,
        item: {
          type: ITEM_TYPE_VOICE,
          voice_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyProtocolBase64,
              encrypt_type: CDN_ENCRYPT_TYPE_PACKED,
            },
          },
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    /**
     * 视频消息：video_item.media + video_size（**密文**字节数，与图片 mid_size 同类）。
     * 协议没有视频的明文大小、宽高或时长字段，因此不发送这些值，也不做缩略图。
     */
    sendVideo(input: SendVideoInput): Promise<SendTextResult> {
      return sendItem({
        accountId: input.accountId,
        toUserId: input.toUserId,
        conversationRef: input.conversationRef,
        item: {
          type: ITEM_TYPE_VIDEO,
          video_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyProtocolBase64,
              encrypt_type: CDN_ENCRYPT_TYPE_PACKED,
            },
            video_size: input.ciphertextSizeBytes,
          },
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    /** 图片消息：image_item 的线上结构与协议一致（含 media/mid_size）。 */
    sendImage(input: SendImageInput): Promise<SendTextResult> {
      return sendItem({
        accountId: input.accountId,
        toUserId: input.toUserId,
        conversationRef: input.conversationRef,
        item: {
          type: ITEM_TYPE_IMAGE,
          image_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyProtocolBase64,
              encrypt_type: CDN_ENCRYPT_TYPE_PACKED,
            },
            mid_size: input.ciphertextSizeBytes,
          },
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}

export type WeixinSender = ReturnType<typeof createWeixinSender>;
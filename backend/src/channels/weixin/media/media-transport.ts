import { randomBytes } from "node:crypto";
import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import type {
  MediaDownloadRequest,
  MediaDownloadResult,
  MediaHandle,
  MediaTransport,
  MediaUploadRequest,
  MediaUploadResult,
} from "../../../core/ports/media-transport.ts";
import type { MediaKind } from "../../../core/model/media.ts";
import { MEDIA_LIMITS, isWithinMediaSizeLimit } from "../../../core/model/media.ts";
import { WeixinTransportError } from "../protocol/errors.ts";
import type { WeixinHttp } from "../protocol/http-client.ts";
import { computeBackoffMs, sleep } from "../protocol/backoff.ts";
import { ENDPOINTS, buildUrl } from "../protocol/endpoints.ts";
import { buildBaseInfo } from "../protocol/headers.ts";
import {
  UPLOAD_MEDIA_TYPE_FILE,
  UPLOAD_MEDIA_TYPE_IMAGE,
  UPLOAD_MEDIA_TYPE_VIDEO,
  UPLOAD_MEDIA_TYPE_VOICE,
  type GetUploadUrlResponse,
} from "../protocol/media-types.ts";
import {
  decryptMedia,
  encryptedSize,
  encryptMedia,
  generateMediaKey,
  mediaKeyFromProtocolBase64,
  mediaKeyToHex,
  mediaKeyToProtocolBase64,
  plaintextMd5Hex,
} from "./aes-media.ts";
import { createCdnClient, type CdnClient } from "./cdn-client.ts";
import type { WeixinSecretStore } from "../auth/account-secret.ts";

/** secretMaterial 的键名。这些值**只能**进加密凭证存储，绝不能写日志/消息/快照/API。 */
export const MEDIA_SECRET_KEYS = {
  /** base64(十六进制密钥字符串)：协议里媒体消息的 aes_key 形态 */
  mediaKey: "mediaKey",
  /** CDN 下载参数 */
  encryptQueryParam: "encryptQueryParam",
  /** 可选的完整下载地址 */
  fullUrl: "fullUrl",
} as const;

export function uploadMediaTypeFor(kind: MediaKind): number {
  switch (kind) {
    case "image":
      return UPLOAD_MEDIA_TYPE_IMAGE;
    case "video":
      return UPLOAD_MEDIA_TYPE_VIDEO;
    case "audio":
      return UPLOAD_MEDIA_TYPE_VOICE;
    case "file":
      return UPLOAD_MEDIA_TYPE_FILE;
  }
}

export interface WeixinMediaTransportDeps {
  http: WeixinHttp;
  secrets: WeixinSecretStore;
  logger: Logger;
  clock: Clock;
  cdnBaseUrl: string;
  /** 账号机密里没有 baseUrl 时使用的回退地址 */
  baseUrl: string;
  botAgent?: string;
  maxBytes?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 测试注入 */
  cdnClient?: CdnClient;
}

/**
 * 微信媒体传输实现（Core 只见 MediaTransport）。
 *
 * 上传：明文 → 校验大小 → 生成密钥 → getuploadurl → AES-128-ECB 加密 → CDN 上传 → 引用 + 敏感材料
 * 下载：敏感材料 → CDN 下载密文 → AES 解密 → 原始字节
 *
 * 传输类错误按 Phase 4 的 backoff 有限重试；协议/加密/解密/大小错误**不重试**。
 */
export function createWeixinMediaTransport(deps: WeixinMediaTransportDeps): MediaTransport {
  const maxBytes = deps.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const cdn =
    deps.cdnClient ??
    createCdnClient({ http: deps.http, cdnBaseUrl: deps.cdnBaseUrl, logger: deps.logger, maxBytes });

  async function withRetry<T>(operation: () => Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const transport = error instanceof WeixinTransportError ? error : null;
        const retryable = transport === null || transport.retryable;
        if (!retryable || attempt === maxAttempts - 1) throw error;
        const delay = computeBackoffMs(attempt, {
          baseMs: deps.baseDelayMs ?? 500,
          maxMs: deps.maxDelayMs ?? 10_000,
          ...(deps.jitterRatio === undefined ? {} : { jitterRatio: deps.jitterRatio }),
          ...(deps.random === undefined ? {} : { random: deps.random }),
        });
        // 只记录阶段与重试次数，不记录任何字节或密钥
        deps.logger.warn("weixin media attempt failed; retrying", { label, attempt: attempt + 1, delayMs: delay });
        await sleepImpl(delay, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("media operation failed");
  }

  return {
    kind: "weixin-cdn",

    async upload(request: MediaUploadRequest): Promise<MediaUploadResult> {
      const plaintext = Buffer.from(request.bytes);
      if (!isWithinMediaSizeLimit(plaintext.length, maxBytes)) {
        throw new WeixinTransportError("size_limit", `媒体超过大小上限（${plaintext.length} > ${maxBytes} 字节）`, { retryable: false });
      }
      if (plaintext.length === 0) {
        throw new WeixinTransportError("protocol_error", "不能上传空媒体", { retryable: false });
      }

      const secret = await deps.secrets.load(request.accountId);
      if (secret.botToken.length === 0) {
        throw new WeixinTransportError("stale_token", "微信账号未登录或凭证已失效", { retryable: false });
      }
      const baseUrl = secret.baseUrl.length > 0 ? secret.baseUrl : deps.baseUrl;

      const mediaKey = generateMediaKey();
      const filekey = randomBytes(16).toString("hex");
      const ciphertext = encryptMedia(plaintext, mediaKey);
      const mediaType = uploadMediaTypeFor(request.kind);

      const uploadUrl = await withRetry(
        async () => {
          const response = await deps.http.postJson<GetUploadUrlResponse>(
            buildUrl(baseUrl, ENDPOINTS.getUploadUrl),
            {
              filekey,
              media_type: mediaType,
              to_user_id: request.conversationRef,
              rawsize: plaintext.length,
              rawfilemd5: plaintextMd5Hex(plaintext),
              filesize: encryptedSize(plaintext.length),
              no_need_thumb: true,
              aeskey: mediaKeyToHex(mediaKey),
              base_info: buildBaseInfo(deps.botAgent),
            },
            { label: "getuploadurl", ...(request.signal === undefined ? {} : { signal: request.signal }) },
          );
          const ret = response.ret ?? 0;
          const errcode = response.errcode ?? 0;
          if (ret === -14 || errcode === -14) {
            throw new WeixinTransportError("stale_token", "微信凭证已失效（errcode -14）", { retryable: false });
          }
          if (ret !== 0 || errcode !== 0) {
            throw new WeixinTransportError("protocol_error", `getuploadurl 失败：ret=${ret} errcode=${errcode}`.trim(), { retryable: false });
          }
          if ((response.upload_full_url ?? "").trim().length === 0 && (response.upload_param ?? "").trim().length === 0) {
            throw new WeixinTransportError("protocol_error", "getuploadurl 未返回可用上传地址", { retryable: false });
          }
          return response;
        },
        "getuploadurl",
        request.signal,
      );

      const uploaded = await withRetry(
        () =>
          cdn.uploadEncrypted({
            ciphertext,
            uploadParam: uploadUrl.upload_param ?? null,
            uploadFullUrl: uploadUrl.upload_full_url ?? null,
            filekey,
            label: "weixin-media",
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        "cdn-upload",
        request.signal,
      );

      const handle: MediaHandle = {
        provider: "weixin-cdn",
        mediaId: null,
        sizeBytes: plaintext.length,
        transferredSizeBytes: ciphertext.byteLength,
        mimeType: request.mimeType,
        filename: request.filename,
        uploadedAt: deps.clock.nowIso(),
      };

      return {
        handle,
        // 敏感材料：调用方必须写入加密凭证存储
        secretMaterial: {
          [MEDIA_SECRET_KEYS.mediaKey]: mediaKeyToProtocolBase64(mediaKey),
          [MEDIA_SECRET_KEYS.encryptQueryParam]: uploaded.downloadParam,
        },
      };
    },

    async download(request: MediaDownloadRequest): Promise<MediaDownloadResult> {
      const keyValue = request.secretMaterial[MEDIA_SECRET_KEYS.mediaKey];
      if (typeof keyValue !== "string" || keyValue.length === 0) {
        throw new WeixinTransportError("decryption_error", "缺少媒体密钥，无法解密下载内容", { retryable: false });
      }
      const mediaKey = mediaKeyFromProtocolBase64(keyValue);
      const encryptQueryParam = request.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam] ?? null;
      const fullUrl = request.secretMaterial[MEDIA_SECRET_KEYS.fullUrl] ?? null;

      const downloaded = await withRetry(
        () =>
          cdn.downloadEncrypted({
            encryptQueryParam,
            fullUrl,
            expectedMimeType: request.expectedMimeType ?? null,
            label: "weixin-media",
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        "cdn-download",
        request.signal,
      );

      const plaintext = decryptMedia(downloaded.bytes, mediaKey);
      if (!isWithinMediaSizeLimit(plaintext.byteLength, maxBytes)) {
        throw new WeixinTransportError("size_limit", "解密后的媒体超过大小上限", { retryable: false });
      }
      return {
        bytes: plaintext,
        mimeType: downloaded.mimeType ?? request.expectedMimeType ?? null,
        sizeBytes: plaintext.byteLength,
      };
    },
  };
}

export type WeixinMediaTransport = ReturnType<typeof createWeixinMediaTransport>;
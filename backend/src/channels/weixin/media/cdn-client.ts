import type { Logger } from "../../../core/ports/logger.ts";
import { WeixinTransportError } from "../protocol/errors.ts";
import type { WeixinHttp } from "../protocol/http-client.ts";
import type { CdnDownloadResult, CdnUploadSuccess } from "../protocol/media-types.ts";
import { MEDIA_LIMITS } from "../../../core/model/media.ts";

export interface CdnClientDeps {
  http: WeixinHttp;
  cdnBaseUrl: string;
  logger: Logger;
  /** 上传允许的重试次数（4xx 立即放弃） */
  maxUploadAttempts?: number;
  maxBytes?: number;
}

/** 密文媒体不应出现的响应类型（通常意味着错误页） */
const SUSPICIOUS_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/json", "text/xml", "application/xml"]);
const OCTET_STREAM = "application/octet-stream";

const UPLOAD_ERROR_HEADER = "x-error-message";
const UPLOAD_PARAM_HEADER = "x-encrypted-param";

/** CDN 上传地址：优先用服务端给的完整 URL，否则用 upload_param + filekey 拼。 */
export function buildCdnUploadUrl(input: { cdnBaseUrl: string; uploadParam: string; filekey: string }): string {
  const base = input.cdnBaseUrl.replace(/\/+$/, "");
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(input.uploadParam)}&filekey=${encodeURIComponent(input.filekey)}`;
}

/** CDN 下载地址：优先 full_url，否则用 encrypt_query_param 拼。 */
export function buildCdnDownloadUrl(input: { cdnBaseUrl: string; encryptQueryParam: string }): string {
  const base = input.cdnBaseUrl.replace(/\/+$/, "");
  return `${base}/download?encrypted_query_param=${encodeURIComponent(input.encryptQueryParam)}`;
}

/**
 * 微信媒体 CDN 客户端。
 * 只负责"把密文发上去 / 把密文取回来"，加解密由 aes-media 负责，重试由调用方按 retryable 决定。
 */
export function createCdnClient(deps: CdnClientDeps) {
  const maxBytes = deps.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;

  return {
    /**
     * 上传密文。成功条件与参考实现一致：HTTP 200 且响应头 `x-encrypted-param` 非空。
     * 4xx 视为永久失败（不重试），其余由调用方重试。
     */
    async uploadEncrypted(input: { ciphertext: Uint8Array; uploadParam: string | null; uploadFullUrl: string | null; filekey: string; label: string; signal?: AbortSignal }): Promise<CdnUploadSuccess> {
      const url = input.uploadFullUrl !== null && input.uploadFullUrl.trim().length > 0
        ? input.uploadFullUrl.trim()
        : input.uploadParam === null || input.uploadParam.length === 0
          ? null
          : buildCdnUploadUrl({ cdnBaseUrl: deps.cdnBaseUrl, uploadParam: input.uploadParam, filekey: input.filekey });
      if (url === null) {
        throw new WeixinTransportError("protocol_error", "getuploadurl 既没有 upload_full_url 也没有 upload_param", { retryable: false });
      }

      const response = await deps.http.postBytes(
        url,
        input.ciphertext,
        { label: `${input.label}:upload`, timeoutMs: 60_000, ...(input.signal === undefined ? {} : { signal: input.signal }) },
        { maxBytes: 64 * 1024 },
      );

      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers.get(UPLOAD_ERROR_HEADER);
        throw new WeixinTransportError("http", `CDN 上传被拒绝（HTTP ${response.status}）${detail === null ? "" : ": " + detail.slice(0, 200)}`, {
          httpStatus: response.status,
          retryable: false,
        });
      }
      if (response.status !== 200) {
        throw new WeixinTransportError("http", `CDN 上传失败（HTTP ${response.status}）`, {
          httpStatus: response.status,
          retryable: true,
        });
      }
      const downloadParam = response.headers.get(UPLOAD_PARAM_HEADER);
      if (downloadParam === null || downloadParam.length === 0) {
        throw new WeixinTransportError("protocol_error", "CDN 上传成功但缺少 x-encrypted-param 响应头", { retryable: true });
      }
      // 只记录长度，不记录参数内容
      deps.logger.debug("cdn upload ok", { bytes: input.ciphertext.byteLength, status: response.status });
      return { downloadParam, url };
    },

    /** 下载密文（不做解密）。 */
    async downloadEncrypted(input: { encryptQueryParam: string | null; fullUrl: string | null; expectedMimeType?: string | null; label: string; signal?: AbortSignal }): Promise<CdnDownloadResult> {
      const url = input.fullUrl !== null && input.fullUrl.trim().length > 0
        ? input.fullUrl.trim()
        : input.encryptQueryParam === null || input.encryptQueryParam.length === 0
          ? null
          : buildCdnDownloadUrl({ cdnBaseUrl: deps.cdnBaseUrl, encryptQueryParam: input.encryptQueryParam });
      if (url === null) {
        throw new WeixinTransportError("protocol_error", "媒体引用既没有 full_url 也没有 encrypt_query_param", { retryable: false });
      }

      const response = await deps.http.getBytes(
        url,
        { label: `${input.label}:download`, timeoutMs: 60_000, ...(input.signal === undefined ? {} : { signal: input.signal }) },
        { maxBytes },
      );
      if (response.status !== 200) {
        throw new WeixinTransportError("http", `CDN 下载失败（HTTP ${response.status}）`, {
          httpStatus: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      if (response.bytes.byteLength === 0) {
        throw new WeixinTransportError("protocol_error", "CDN 返回了空响应体", { retryable: false });
      }
      const contentType = response.contentType === null ? null : response.contentType.split(";")[0]!.trim().toLowerCase();
      // CDN 上放的是**密文**，因此 application/octet-stream（或缺省）是正常回答；
      // 文本类内容说明大概率拿到的是错误页，必须拒绝而不是当成媒体。
      if (contentType !== null && SUSPICIOUS_CONTENT_TYPES.has(contentType)) {
        throw new WeixinTransportError("protocol_error", `CDN 返回了疑似错误页的内容类型（${contentType}）`, { retryable: false });
      }
      if (
        input.expectedMimeType !== null &&
        input.expectedMimeType !== undefined &&
        contentType !== null &&
        contentType !== OCTET_STREAM &&
        contentType !== input.expectedMimeType.split(";")[0]!.trim().toLowerCase()
      ) {
        throw new WeixinTransportError("protocol_error", `Media-Type 不匹配（期望 ${input.expectedMimeType}，实际 ${contentType}）`, {
          retryable: false,
        });
      }
      return { bytes: response.bytes, mimeType: input.expectedMimeType ?? response.contentType, contentLength: response.contentLength };
    },
  };
}

export type CdnClient = ReturnType<typeof createCdnClient>;
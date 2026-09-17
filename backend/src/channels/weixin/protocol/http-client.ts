import type { Logger } from "../../../core/ports/logger.ts";
import { WeixinTransportError, isAbortError } from "./errors.ts";
import { buildCommonHeaders, buildPostHeaders, type HeaderOptions } from "./headers.ts";
import { parseLossless } from "./lossless-json.ts";

export interface WeixinHttpDeps extends HeaderOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger: Logger;
}

export interface RequestContext {
  /** 渠道标签，只出现在日志里 */
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ByteResponse {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  headers: Headers;
  bytes: Uint8Array;
}

export interface ByteRequestOptions {
  /** 响应体大小上限（超过即判为 size_limit，不会把超大响应读进内存） */
  maxBytes?: number;
}

export interface WeixinHttp {
  getJson<T>(url: string, context: RequestContext): Promise<T>;
  postJson<T>(url: string, body: unknown, context: RequestContext): Promise<T>;
  /**
   * 二进制请求（媒体 CDN 用）。
   * 注意：CDN 请求**不带任何微信鉴权头**，因此这里复用超时/中止/错误分类，但不加鉴权。
   */
  postBytes(url: string, body: Uint8Array, context: RequestContext, options?: ByteRequestOptions): Promise<ByteResponse>;
  getBytes(url: string, context: RequestContext, options?: ByteRequestOptions): Promise<ByteResponse>;
  /** 测试与诊断用：当前鉴权头是否带 token（不返回 token 本身） */
  hasToken(): boolean;
}

export function createWeixinHttp(deps: WeixinHttpDeps): WeixinHttp {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const defaultTimeout = deps.timeoutMs ?? 20_000;

  async function request(url: string, init: RequestInit, context: RequestContext): Promise<Response> {
    const timeoutMs = context.timeoutMs ?? defaultTimeout;
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (context.signal !== undefined) signals.push(context.signal);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    try {
      const response = await fetchImpl(url, { ...init, signal });
      if (!response.ok) {
        // 错误体只截断记录，且日志走脱敏 logger
        const text = await response.text().catch(() => "");
        throw new WeixinTransportError("http", `HTTP ${response.status}: ${text.slice(0, 200)}`, {
          httpStatus: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof WeixinTransportError) throw error;
      if (isAbortError(error)) {
        const abortedByCaller = context.signal?.aborted === true;
        throw new WeixinTransportError(abortedByCaller ? "aborted" : "timeout", abortedByCaller ? "请求已取消" : `请求超时（${timeoutMs}ms）`, {
          retryable: !abortedByCaller,
          cause: error,
        });
      }
      throw new WeixinTransportError("network", `网络错误: ${(error as Error).message}`, { retryable: true, cause: error });
    }
  }

  async function readJson<T>(response: Response, context: RequestContext): Promise<T> {
    const text = await response.text().catch(() => "");
    if (text.length === 0) return {} as T;
    try {
      return parseLossless<T>(text);
    } catch (error) {
      deps.logger.warn("weixin response is not valid json", { label: context.label, chars: text.length });
      throw new WeixinTransportError("invalid_response", "上游返回的不是合法 JSON", { retryable: false, cause: error });
    }
  }

  async function readBytes(response: Response, context: RequestContext, options: ByteRequestOptions = {}): Promise<ByteResponse> {
    const declaredLength = response.headers.get("content-length");
    const contentLength = declaredLength === null ? null : Number.parseInt(declaredLength, 10);
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new WeixinTransportError("size_limit", `响应超过大小上限（${contentLength} > ${maxBytes} 字节）`, {
        retryable: false,
      });
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new WeixinTransportError("size_limit", `响应超过大小上限（${buffer.byteLength} > ${maxBytes} 字节）`, {
        retryable: false,
      });
    }
    // 只记录长度，不记录内容
    deps.logger.debug("weixin binary response", { label: context.label, status: response.status, bytes: buffer.byteLength });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentLength,
      headers: response.headers,
      bytes: buffer,
    };
  }

  return {
    async getBytes(url: string, context: RequestContext, options: ByteRequestOptions = {}): Promise<ByteResponse> {
      const response = await request(url, { method: "GET" }, context);
      return readBytes(response, context, options);
    },
    async postBytes(
      url: string,
      body: Uint8Array,
      context: RequestContext,
      options: ByteRequestOptions = {},
    ): Promise<ByteResponse> {
      const response = await request(
        url,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(body) },
        context,
      );
      return readBytes(response, context, options);
    },
    async getJson<T>(url: string, context: RequestContext): Promise<T> {
      // GET（二维码状态轮询）只带公共头，不带鉴权
      const response = await request(url, { method: "GET", headers: buildCommonHeaders(deps) }, context);
      return readJson<T>(response, context);
    },
    async postJson<T>(url: string, body: unknown, context: RequestContext): Promise<T> {
      const response = await request(
        url,
        { method: "POST", headers: buildPostHeaders(deps), body: JSON.stringify(body) },
        context,
      );
      return readJson<T>(response, context);
    },
    hasToken: () => typeof deps.token === "string" && deps.token.trim().length > 0,
  };
}
export type WeixinErrorKind =
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "invalid_response"
  | "business"
  | "stale_token"
  // Phase 4.5-B：媒体传输与加解密
  | "protocol_error"
  | "encryption_error"
  | "decryption_error"
  | "size_limit";

/** 渠道内部的统一错误类型；错误信息里绝不允许出现 token。 */
export class WeixinTransportError extends Error {
  readonly kind: WeixinErrorKind;
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(
    kind: WeixinErrorKind,
    message: string,
    options: { httpStatus?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WeixinTransportError";
    this.kind = kind;
    this.httpStatus = options.httpStatus ?? null;
    // 只有传输类错误可重试；加密/解密/协议/大小错误重试没有意义
    this.retryable =
      options.retryable ?? (kind === "network" || kind === "timeout" || kind === "http" || kind === "invalid_response");
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
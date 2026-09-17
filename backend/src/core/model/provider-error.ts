import { DomainError } from "./errors.ts";

export type ProviderErrorKind =
  | "timeout"
  | "unauthorized" // 401
  | "forbidden" // 403
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "network"
  | "invalid_response"
  | "model_unavailable"
  | "aborted"
  | "unknown";

export interface ProviderErrorDetails {
  providerId: string;
  kind: ProviderErrorKind;
  httpStatus: number | null;
  retryable: boolean;
  model?: string;
}

/**
 * 统一的 Provider 错误。任何 SDK/HTTP 特定错误都必须在 provider 层被转换成它，
 * 不允许泄漏进 Core。
 */
export class ProviderError extends DomainError {
  readonly providerKind: ProviderErrorKind;
  readonly providerId: string;
  /** 上游 HTTP 状态（无 HTTP 交互时为 null）；基类 httpStatus 由 DomainError 提供统一映射值。 */
  readonly upstreamStatus: number | null;
  readonly retryable: boolean;
  readonly model: string | null;

  constructor(message: string, details: ProviderErrorDetails, options: { cause?: unknown } = {}) {
    super("provider_error", message, {
      details: {
        providerId: details.providerId,
        kind: details.kind,
        httpStatus: details.httpStatus,
        retryable: details.retryable,
      },
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ProviderError";
    this.providerKind = details.kind;
    this.providerId = details.providerId;
    this.upstreamStatus = details.httpStatus;
    this.retryable = details.retryable;
    this.model = details.model ?? null;
  }
}

export function kindFromHttpStatus(status: number): ProviderErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_unavailable";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_response";
  return "unknown";
}

export function isRetryable(kind: ProviderErrorKind): boolean {
  return kind === "timeout" || kind === "rate_limited" || kind === "server_error" || kind === "network";
}

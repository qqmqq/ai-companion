export type DomainErrorCode =
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "unauthorized"
  | "channel_unavailable"
  | "provider_error"
  | "internal";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: { httpStatus?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultStatus(code);
    this.details = options.details ?? {};
  }
}

export function defaultStatus(code: DomainErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid_input":
      return 400;
    case "conflict":
      return 409;
    case "unauthorized":
      return 401;
    case "channel_unavailable":
      return 503;
    case "provider_error":
      return 502;
    default:
      return 500;
  }
}

export function notFound(what: string, id: string): DomainError {
  return new DomainError("not_found", `${what} not found: ${id}`, { details: { what, id } });
}

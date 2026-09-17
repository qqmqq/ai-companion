import { DomainError } from "../core/model/errors.ts";

export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

export function toApiError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof DomainError) {
    return {
      statusCode: error.httpStatus,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return { statusCode: 500, body: { error: { code: "internal", message, details: {} } } };
}

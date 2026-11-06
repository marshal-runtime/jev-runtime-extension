import type { JevClientErrorCode } from "./api.js";

/**
 * Typed error for @marshal/jev. `message` is guaranteed never to embed the
 * raw API key — constructors here only ever take non-secret context (status
 * codes, option ids, field names).
 */
export class JevClientError extends Error {
  readonly code: JevClientErrorCode;
  readonly status?: number;

  constructor(code: JevClientErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "JevClientError";
    this.code = code;
    this.status = options?.status;
  }
}

export function notConnectedError(): JevClientError {
  return new JevClientError(
    "JEV_NOT_CONNECTED",
    "Jev is not connected. Call jev.connect to show the sign-in card.",
  );
}

export function invalidKeyError(detail?: string): JevClientError {
  return new JevClientError(
    "JEV_INVALID_KEY",
    detail ?? "The stored OpenAI API key was rejected (HTTP 401).",
    { status: 401 },
  );
}

export function permissionDeniedError(detail?: string): JevClientError {
  return new JevClientError(
    "JEV_INVALID_KEY",
    detail ?? "The OpenAI API key does not have permission for this request (HTTP 403).",
    { status: 403 },
  );
}

export function rateLimitedError(detail?: string): JevClientError {
  return new JevClientError(
    "JEV_RATE_LIMITED",
    detail ?? "OpenAI rate-limited this request (HTTP 429).",
    { status: 429 },
  );
}

export function unavailableError(status?: number, detail?: string): JevClientError {
  return new JevClientError(
    "JEV_UNAVAILABLE",
    detail ?? `OpenAI is temporarily unavailable${status ? ` (HTTP ${status})` : ""}.`,
    status !== undefined ? { status } : undefined,
  );
}

export function badRequestError(detail: string, status?: number): JevClientError {
  return new JevClientError("JEV_BAD_REQUEST", detail, status !== undefined ? { status } : undefined);
}

export function invalidResponseError(detail: string): JevClientError {
  return new JevClientError("JEV_INVALID_RESPONSE", detail);
}

export function abortedError(): JevClientError {
  return new JevClientError("JEV_ABORTED", "The request was aborted.");
}

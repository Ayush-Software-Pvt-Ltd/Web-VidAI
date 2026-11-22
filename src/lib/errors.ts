import type { ErrorCode, WireError } from "./types";

/** Every code the server sends (SPEC section 3), so a stray string is never taken for one. */
export const ERROR_CODES = [
  "invalidInput",
  "notFound",
  "conflict",
  "forbidden",
  "unauthenticated",
  "notReady",
  "io",
  "internal",
  "tooLarge",
  "rateLimited",
] as const satisfies readonly ErrorCode[];

// Compile-time check: a code added to the wire type must be added to the list above.
export const ALL_ERROR_CODES_LISTED: Exclude<ErrorCode, (typeof ERROR_CODES)[number]> extends never
  ? true
  : never = true;

/**
 * The error every `api` call rejects with. It is a real `Error` (stack traces, `instanceof`) that
 * also has the wire shape `{ code, message }` of SPEC section 3.
 */
export class ApiError extends Error implements WireError {
  readonly code: ErrorCode;
  /**
   * The input field the sentence is about (`email`, `password`, `currentPassword`, ...), so a form
   * can show it under that field; absent when the refusal is not about one field.
   */
  readonly field?: string;

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (field !== undefined && field !== "") this.field = field;
  }
}

/**
 * The request never got an answer from VidAI itself: the network is down, the server is stopped
 * or restarting, or something in between (a proxy) answered with its own error page. It has the
 * code `io`, but unlike an `io` the server sends, `isNetworkError` tells the screens that the
 * action did not reach VidAI at all (so showing "try again" is right and nothing was refused).
 */
export class NetworkError extends ApiError {
  constructor(message = "VidAI could not be reached. Check your connection and try again.") {
    super("io", message);
    this.name = "NetworkError";
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** The `field` of a wire error body, when it is a text. */
function fieldOf(body: object): string | undefined {
  return "field" in body && typeof body.field === "string" ? body.field : undefined;
}

/** Normalizes anything a call or the transport can throw into an `ApiError`. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const { code, message } = error;
    if (isErrorCode(code) && typeof message === "string") {
      return new ApiError(code, message, fieldOf(error));
    }
  }
  if (error instanceof Error) return new ApiError("internal", error.message);
  if (typeof error === "string") return new ApiError("internal", error);
  return new ApiError("internal", "Something went wrong.");
}

/** The error for an answer that has no `{ code, message }` body, by its HTTP status. */
export function errorForStatus(status: number): ApiError {
  switch (status) {
    case 401:
      return new ApiError("unauthenticated", "Please sign in again.");
    case 403:
      return new ApiError("forbidden", "VidAI refused this request.");
    case 404:
      return new ApiError("notFound", "Nothing was found at that address.");
    case 409:
      return new ApiError("conflict", "That could not be done right now. Try again in a moment.");
    case 413:
      return new ApiError("tooLarge", "That is more than the server accepts.");
    case 429:
      return new ApiError("rateLimited", "Too many requests. Try again in a moment.");
    default:
      // A 5xx, or a 200 that is no JSON, is a proxy or a half-started server speaking.
      return status >= 500 || status === 200
        ? new NetworkError()
        : new ApiError("internal", "The server gave an answer VidAI did not understand.");
  }
}

/**
 * The error of a body `{ code, message }` the server sent; `null` for anything else (the page of
 * a proxy, an empty answer, an unknown code), so the caller falls back on the HTTP status.
 */
export function parseWireError(body: unknown): ApiError | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("code" in body) || !isErrorCode(body.code)) return null;
  if (!("message" in body) || typeof body.message !== "string" || body.message === "") return null;
  return new ApiError(body.code, body.message, fieldOf(body));
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/** The call failed because VidAI could not be reached at all (see `NetworkError`). */
export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

/** The error of a transfer that was stopped on purpose (`AbortController`), such as a paused upload. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

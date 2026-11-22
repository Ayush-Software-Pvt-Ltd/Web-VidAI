// How a failed request to the OpenCode server is told to the user (docs/SPEC.md section 5, "The
// OpenCode 2 program"; ported from `describe` in `child.rs`). The server runs on the computer
// that runs VidAI, so "Mac" and "PC" of the desktop texts became that phrase.

/**
 * Why a request to the server did not get an answer.
 * - `timeout`: no answer within the limit.
 * - `connect`: nothing listens (the server ended, or never started).
 * - `other`: anything else.
 * @typedef {"timeout" | "connect" | "other"} RequestFailureKind
 */

/** An error of a request that got no answer; `message` is a sentence for the user. */
export class OpencodeRequestError extends Error {
  /**
   * @param {RequestFailureKind} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = "OpencodeRequestError";
    this.kind = kind;
  }
}

/** Error codes of a connection that could not be made or was cut at once. */
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function codeOf(error) {
  if (typeof error !== "object" || error === null) return null;
  const code = /** @type {{ code?: unknown, cause?: unknown }} */ (error).code;
  if (typeof code === "string") return code;
  return codeOf(/** @type {{ cause?: unknown }} */ (error).cause);
}

/**
 * The failure of one `fetch` as an `OpencodeRequestError`.
 * @param {unknown} error What `fetch` threw.
 * @returns {OpencodeRequestError}
 */
export function describeFetchError(error) {
  if (error instanceof OpencodeRequestError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new OpencodeRequestError("timeout", "OpenCode did not answer in time");
  }
  const code = codeOf(error);
  if (code !== null && CONNECT_CODES.has(code)) {
    return new OpencodeRequestError(
      "connect",
      "Could not reach the OpenCode server on the computer that runs VidAI",
    );
  }
  const cause = error instanceof Error ? /** @type {{ cause?: unknown }} */ (error).cause : null;
  const detail =
    cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return new OpencodeRequestError("other", `The request to OpenCode failed: ${detail}`);
}

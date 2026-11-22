// The one error type that crosses the wire (docs/SPEC.md section 3): `{ code, message }`, plus
// `field` when the sentence is about one input field (the only optional member).

/** @typedef {import("../../src/lib/wire.ts").ErrorCode} ErrorCode */

/** @type {Record<ErrorCode, number>} */
const HTTP_STATUS = {
  invalidInput: 400,
  notReady: 400,
  io: 400,
  internal: 400,
  unauthenticated: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  tooLarge: 413,
  rateLimited: 429,
};

export class AppError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message A full sentence the user can read.
   * @param {{ cause?: unknown, field?: string }} [options] `field`: the input field the sentence
   *   is about, for a form to show it there.
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = "AppError";
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {string | null} */
    this.field = options?.field ?? null;
  }

  /** The HTTP status this error is answered with. */
  get status() {
    return HTTP_STATUS[this.code];
  }

  /** @returns {{ code: ErrorCode, message: string, field?: string }} */
  toJSON() {
    return this.field === null
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, field: this.field };
  }
}

/**
 * @param {string} message
 * @param {string} [field] The input field the sentence is about.
 */
export const invalidInput = (message, field) =>
  new AppError("invalidInput", message, field ? { field } : undefined);
/** @param {string} message */
export const notFound = (message) => new AppError("notFound", message);
/**
 * @param {string} message
 * @param {string} [field] The input field the sentence is about.
 */
export const conflict = (message, field) =>
  new AppError("conflict", message, field ? { field } : undefined);
/** @param {string} message */
export const forbidden = (message) => new AppError("forbidden", message);
/** @param {string} message */
export const notReady = (message) => new AppError("notReady", message);

/**
 * Any thrown value as an `AppError`: an `AppError` stays, a file system error becomes `io`,
 * everything else `internal`.
 * @param {unknown} error
 * @returns {AppError}
 */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    const isFileError = typeof code === "string" && /^E[A-Z]+$/.test(code);
    return new AppError(isFileError ? "io" : "internal", error.message, { cause: error });
  }
  return new AppError("internal", String(error));
}

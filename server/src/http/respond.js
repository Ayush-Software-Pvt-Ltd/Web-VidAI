// JSON answers.
/**
 * Answer with a JSON body. `undefined` is sent as `null`.
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value ?? null), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Answer an `AppError` as `{ code, message }` with its status.
 * @param {import("node:http").ServerResponse} res
 * @param {import("../errors.js").AppError} error
 */
export function sendError(res, error) {
  sendJson(res, error.status, error.toJSON());
}

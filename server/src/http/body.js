// Reading a request body with a size limit and a silence limit (docs/SPEC.md sections 4 and 14).
import { AppError, invalidInput } from "../errors.js";

/** RPC bodies are small JSON; uploads have their own route. */
export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * Read a whole body into memory.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ limit: number, idleMs: number }} options
 * @returns {Promise<Buffer>}
 * @throws {AppError} `tooLarge` beyond `limit`, `invalidInput` when the client goes quiet.
 */
export function readBody(req, { limit, idleMs }) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(tooLarge());
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let timer = setTimeout(onIdle, idleMs);

    function finish() {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    }
    function onIdle() {
      finish();
      reject(invalidInput("The request took too long to arrive."));
    }
    /** @param {Buffer} chunk */
    function onData(chunk) {
      total += chunk.length;
      if (total > limit) {
        finish();
        // Keep reading and dropping what is left, so the answer reaches a client that is still sending.
        req.resume();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
      clearTimeout(timer);
      timer = setTimeout(onIdle, idleMs);
    }
    function onEnd() {
      finish();
      resolve(Buffer.concat(chunks, total));
    }
    /** @param {Error} error */
    function onError(error) {
      finish();
      reject(error);
    }
    function onClose() {
      if (!req.complete) {
        finish();
        reject(invalidInput("The request was cut off."));
      }
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function tooLarge() {
  return new AppError("tooLarge", "That request is too large.");
}

/**
 * Read a JSON body; an empty body is `null`.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ limit?: number, idleMs: number }} options
 * @returns {Promise<unknown>}
 */
export async function readJson(req, { limit = MAX_JSON_BYTES, idleMs }) {
  const text = (await readBody(req, { limit, idleMs })).toString("utf8");
  if (text.trim() === "") return null;
  try {
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    throw invalidInput("The request body is not valid JSON.");
  }
}

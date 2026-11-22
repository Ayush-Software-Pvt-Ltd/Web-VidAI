// Sending one file with HTTP Range support (used by the UI files, thumbnails, finals and previews).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";
import { notFound } from "../errors.js";
import { contentTypeOf } from "./mime.js";

/**
 * @typedef {{ kind: "whole" } | { kind: "unsatisfiable" } | { kind: "range", start: number, end: number }} RangeResult
 */

/**
 * Read a `Range` header against a file size. Only single `bytes` ranges are served; an unknown unit
 * or several ranges at once get the whole file; a malformed or unsatisfiable range is 416.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {RangeResult}
 */
export function parseRange(header, size) {
  if (header === undefined) return { kind: "whole" };
  const unit = /^\s*bytes\s*=(.*)$/i.exec(header);
  if (!unit) return { kind: "whole" };
  const spec = (unit[1] ?? "").trim();
  if (spec.includes(",")) return { kind: "whole" };
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: "unsatisfiable" };
  const [first = "", last = ""] = [parts[1], parts[2]];
  if (first === "" && last === "") return { kind: "unsatisfiable" };
  if (first === "") {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0)
      return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const requestedEnd = last === "" ? size - 1 : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) {
    return { kind: "unsatisfiable" };
  }
  if (start >= size || requestedEnd < start) return { kind: "unsatisfiable" };
  return { kind: "range", start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * A `Content-Disposition` for a download, safe for any file name.
 * @param {string} name
 */
function attachment(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * @param {string | undefined} header `If-None-Match`
 * @param {string} etag
 */
function etagMatches(header, etag) {
  if (header === undefined) return false;
  return header
    .split(",")
    .map((part) => part.trim())
    .some(
      (part) =>
        part === "*" || part === etag || part.replace(/^W\//, "") === etag.replace(/^W\//, ""),
    );
}

/**
 * Stream a file as the answer: `200`, `206` for a range, `304` when unchanged, `416` for a bad
 * range, no body for `HEAD`. Resolves when the answer is complete or the client went away; the file
 * is closed either way. Headers already set on `res` stay unless `headers` replaces them.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} filePath
 * @param {{ contentType?: string, headers?: Record<string, string>, download?: boolean | string }} [options]
 *   `download`: send as an attachment (true uses the file's own name, a string names it).
 * @returns {Promise<void>}
 * @throws {import("../errors.js").AppError} `notFound` when the path is not a file.
 */
export async function serveFile(req, res, filePath, { contentType, headers, download } = {}) {
  /** @type {import("node:fs").Stats} */
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw notFound("That file was not found.");
    throw error;
  }
  if (!stat.isFile()) throw notFound("That file was not found.");

  const size = stat.size;
  const etag = `W/"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader("Content-Type", contentType ?? contentTypeOf(filePath));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", stat.mtime.toUTCString());
  if (download) {
    res.setHeader(
      "Content-Disposition",
      attachment(typeof download === "string" ? download : path.basename(filePath)),
    );
  }
  for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);

  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const range = parseRange(req.headers.range, size);
  if (range.kind === "unsatisfiable") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.setHeader("Content-Length", 0);
    res.end();
    return;
  }
  const start = range.kind === "range" ? range.start : 0;
  const end = range.kind === "range" ? range.end : size - 1;
  if (range.kind === "range") {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", size === 0 ? 0 : end - start + 1);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { start, end });
    // pipeline destroys the file stream when the client goes away, which closes the descriptor.
    pipeline(stream, res, () => {
      resolve(undefined);
    });
  });
}

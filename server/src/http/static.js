// The built UI (docs/SPEC.md section 14: `dist/`, `index.html` for unknown paths).
import fsp from "node:fs/promises";
import path from "node:path";
import { notFound } from "../errors.js";
import { serveFile } from "./range.js";
import { sendError } from "./respond.js";

const ONE_YEAR = "public, max-age=31536000, immutable";

/**
 * @param {string} dist Directory of the built UI.
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string) => Promise<void>}
 */
export function createStaticHandler(dist) {
  const root = path.resolve(dist);

  /** @param {string} file */
  async function regularFile(file) {
    try {
      // Resolve links so one inside dist/ cannot lead out of it.
      const [real, realRoot] = await Promise.all([fsp.realpath(file), fsp.realpath(root)]);
      if (!real.startsWith(realRoot + path.sep)) return null;
      return (await fsp.stat(real)).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  return async function serveUi(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.statusCode = 405;
      res.end();
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendError(res, notFound("Not found."));
      return;
    }
    // Anything that could climb out of the folder is simply not there.
    const segments = decoded.split("/");
    if (decoded.includes("\0") || decoded.includes("\\") || segments.some((s) => s === "..")) {
      sendError(res, notFound("Not found."));
      return;
    }
    const wanted = path.join(root, decoded);
    let file =
      wanted.startsWith(root + path.sep) || wanted === root ? await regularFile(wanted) : null;
    if (file === null && (decoded.endsWith("/") || (await isDirectory(wanted)))) {
      file = await regularFile(path.join(wanted, "index.html"));
    }
    if (file === null) {
      const last = segments[segments.length - 1] ?? "";
      // A missing script or picture must not turn into the page, or the browser would parse HTML as code.
      const looksLikeFile = decoded.startsWith("/assets/") || /\.[^./]+$/.test(last);
      if (looksLikeFile) {
        sendError(res, notFound("Not found."));
        return;
      }
      file = await regularFile(path.join(root, "index.html"));
      if (file === null) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("The user interface has not been built. Run npm run build.\n");
        return;
      }
    }
    const hashed = decoded.startsWith("/assets/");
    await serveFile(req, res, file, {
      headers: { "Cache-Control": hashed ? ONE_YEAR : "no-cache" },
    });
  };
}

/** @param {string} dir */
async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

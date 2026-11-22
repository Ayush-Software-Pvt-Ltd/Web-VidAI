// The project preview: `GET /p/<token>/<path>` (docs/SPEC.md section 11, Preview, and section 14).
//
// What is served is written by an agent and is never trusted, so every answer carries a sandboxing
// Content-Security-Policy: the page runs in an opaque origin without the VidAI cookie, the VidAI
// origin or the network, even when opened in a tab of its own. The route reads no cookie; the
// token in the address is the whole permission.
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { AppError } from "../errors.js";
import { contentTypeOf } from "../http/mime.js";
import { serveFile } from "../http/range.js";
import { injectRuntimeScript } from "./previewHtml.js";
import { resolvePreviewFile, splitRequestedPath } from "./previewPaths.js";
import { createTokenStore } from "./previewTokens.js";

/** SPEC section 11: exactly this policy on every answer. */
export const PREVIEW_CSP =
  "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'";

/** The runtime is served under the token, at this path. */
const RUNTIME_PATH = "__hf/runtime.js";

/** The pinned package's runtime, found from the package and not from the working directory. */
export function defaultRuntimeFile() {
  const manifest = createRequire(import.meta.url).resolve("hyperframes/package.json");
  return path.join(path.dirname(manifest), "dist", "hyperframe.runtime.iife.js");
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {boolean} head No body for HEAD.
 */
function sendText(res, status, text, head) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : body);
}

/**
 * Headers every answer carries, errors included. They replace the server's defaults: the page's own
 * policy, no `X-Frame-Options: DENY` (the timeline screen frames it; other sites may not).
 * @param {import("node:http").ServerResponse} res
 */
function setPreviewHeaders(res) {
  res.setHeader("Content-Security-Policy", PREVIEW_CSP);
  // The content has no origin of its own, so its requests arrive as cross-origin ones.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * @typedef {object} PreviewDeps
 * @property {import("./previewTokens.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {string} [runtimeFile] The HyperFrames runtime script (default: the pinned package's).
 * @property {(realPath: string) => string | null} [proxyFor] A lighter copy of a media file, or null.
 * @property {number} [ttlMs] Token life (12 hours).
 * @property {(size: number) => Buffer} [random]
 */

/**
 * @param {PreviewDeps} deps
 */
export function createPreview(deps) {
  const { log } = deps;
  const runtimeFile = deps.runtimeFile ?? defaultRuntimeFile();
  const tokens = createTokenStore({
    clock: deps.clock,
    ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });

  /**
   * The copy to send instead of a heavy original, when one exists as a file.
   * @param {string} real
   * @returns {Promise<string>}
   */
  async function substitute(real) {
    if (!deps.proxyFor) return real;
    try {
      const copy = deps.proxyFor(real);
      if (copy === null) return real;
      return (await fsp.stat(copy)).isFile() ? copy : real;
    } catch (error) {
      log.warn("preview: the preview copy of a file could not be used", error);
      return real;
    }
  }

  /**
   * `index.html` with the runtime script added; no other byte changes.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {string} file
   * @param {string} token
   */
  async function sendPage(req, res, file, token) {
    const page = injectRuntimeScript(await fsp.readFile(file), `/p/${token}/${RUNTIME_PATH}`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": page.length,
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : page);
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {import("../http/types.js").RouteContext} ctx
   */
  async function handle(req, res, ctx) {
    setPreviewHeaders(res);
    const head = req.method === "HEAD";
    const notValid = () => sendText(res, 404, "This preview address is not valid any more.", head);
    const rest = ctx.params.rest ?? "";
    const slash = rest.indexOf("/");
    const token = slash < 0 ? rest : rest.slice(0, slash);
    const grant = tokens.lookup(token);
    if (!grant) return notValid();
    if (slash < 0) {
      // The page's relative addresses need the slash after the token.
      res.statusCode = 308;
      res.setHeader("Location", `/p/${token}/`);
      res.setHeader("Content-Length", 0);
      res.end();
      return;
    }

    const requested = rest.slice(slash + 1);
    if (requested === RUNTIME_PATH) {
      await serveFile(req, res, runtimeFile, {
        headers: { "Cache-Control": "private, max-age=3600" },
      });
      return;
    }
    const segments = splitRequestedPath(requested);
    const real = segments && (await resolvePreviewFile(segments, grant));
    if (!segments || !real) return notValid();

    const isHtml = path.extname(real).toLowerCase() === ".html";
    res.setHeader("Cache-Control", isHtml ? "no-store" : "no-cache");
    try {
      // Only the project's own root page gets the runtime; compositions are loaded by it.
      if (isHtml && real === (await resolvePreviewFile(["index.html"], grant))) {
        await sendPage(req, res, real, token);
        return;
      }
      const file = await substitute(real);
      await serveFile(req, res, file, real === file ? {} : { contentType: contentTypeOf(file) });
    } catch (error) {
      // The file vanished between the check and the read, or is not a file (a folder).
      if (error instanceof AppError && error.code === "notFound") return notValid();
      if (/** @type {{ code?: string }} */ (error).code === "ENOENT") return notValid();
      throw error;
    }
  }

  /** @type {import("../http/types.js").Route[]} */
  const routes = [{ method: "GET", path: "/p/*", auth: "none", handler: handle }];

  return {
    routes,

    /**
     * Give a session the preview address of a video.
     * @param {{ sessionId: string, userId: string, videoKey: string } & import("./previewTokens.js").PreviewTarget} info
     * @returns {{ token: string, url: string }} `url` is `/p/<token>/`.
     */
    open(info) {
      const token = tokens.open(info);
      return { token, url: `/p/${token}/` };
    },

    /** @param {string} sessionId The session ended: its addresses stop working. */
    closeSession(sessionId) {
      tokens.closeSession(sessionId);
    },

    /** @param {string} videoKey The video was removed or archived. */
    closeVideo(videoKey) {
      tokens.closeVideo(videoKey);
    },

    /** Drop expired tokens (run now and then; lookups also refuse expired ones). */
    sweep() {
      tokens.sweep();
    },

    /** Forget every token. */
    stop() {
      tokens.clear();
    },
  };
}

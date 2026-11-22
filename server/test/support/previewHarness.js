// Test support for the preview route: a plain HTTP server that routes the way the real one does
// (default security headers first, then the route, `AppError` as JSON), and a raw request helper
// that keeps odd paths (`..`, `%2e`, `%00`) exactly as written, which `fetch` would not.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AppError } from "../../src/errors.js";
import { applySecurityHeaders } from "../../src/http/headers.js";
import { createRouter } from "../../src/http/router.js";
import { sendError } from "../../src/http/respond.js";

/**
 * @param {import("../../src/http/types.js").Route[]} routes
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => boolean | void} [before]
 *   Sees every request first; returning true means it answered.
 * @returns {Promise<{ port: number, origin: string, close(): Promise<void> }>}
 */
export async function startRouteServer(routes, before) {
  const router = createRouter(routes);
  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);
    if (before?.(req, res) === true) return;
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = router.match(req.method ?? "GET", url.pathname);
        if (match.kind === "none") {
          res.statusCode = 404;
          res.end("none");
          return;
        }
        if (match.kind === "method") {
          res.statusCode = 405;
          res.end("method");
          return;
        }
        await match.route.handler(req, res, {
          session: null,
          url,
          params: match.params,
          address: "127.0.0.1",
        });
      } catch (error) {
        if (res.headersSent) res.destroy();
        else if (error instanceof AppError) sendError(res, error);
        else {
          res.statusCode = 500;
          res.end("boom");
        }
      }
    })();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * @param {number} port
 * @param {string} rawPath Sent as is.
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer }>}
 */
export function rawRequest(port, rawPath, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: rawPath, method, headers, agent: false },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * A channel with one video and a project, the way SPEC section 10 lays it out, plus files outside it.
 * `assets/media` holds links: `aroll.mp4` into the video folder, `broll.mp4` into another folder of
 * the channel, `evil.mp4` out of both.
 * @param {string} [prefix]
 * @returns {{ root: string, channelDir: string, videoDir: string, projectDir: string, outsideDir: string, cleanup(): void }}
 */
export function makePreviewProject(prefix = "vidai-preview-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const channelDir = path.join(root, "channel");
  const videoDir = path.join(channelDir, "Video One");
  const projectDir = path.join(videoDir, "output", "Video One.hf");
  const outsideDir = path.join(root, "outside");
  for (const dir of [
    path.join(projectDir, "compositions"),
    path.join(projectDir, "shared"),
    path.join(projectDir, "assets", "media"),
    path.join(projectDir, ".hyperframes"),
    path.join(videoDir, "aroll"),
    path.join(channelDir, "Other Video"),
    outsideDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  /** @param {string} file @param {string | Buffer} data */
  const write = (file, data) => fs.writeFileSync(file, data);
  write(
    path.join(projectDir, "index.html"),
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
  );
  write(path.join(projectDir, "compositions", "g-1.html"), "<template><div>g-1</div></template>\n");
  write(path.join(projectDir, "style.css"), "body { color: red }\n");
  write(path.join(projectDir, "data.json"), '{"a":1}\n');
  write(path.join(projectDir, "app.js"), "window.x = 1;\n");
  write(path.join(projectDir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(path.join(projectDir, ".hyperframes", "secret.json"), "{}\n");
  write(path.join(projectDir, "shared", "kit.woff2"), "woff2");
  write(path.join(videoDir, "aroll", "a.mp4"), Buffer.alloc(1000, 7));
  write(path.join(channelDir, "Other Video", "b.mp4"), Buffer.alloc(500, 8));
  write(path.join(outsideDir, "secret.txt"), "secret\n");
  write(path.join(outsideDir, "secret.mp4"), "secret");
  fs.symlinkSync(
    path.join(videoDir, "aroll", "a.mp4"),
    path.join(projectDir, "assets", "media", "aroll.mp4"),
  );
  fs.symlinkSync(
    path.join(channelDir, "Other Video", "b.mp4"),
    path.join(projectDir, "assets", "media", "broll.mp4"),
  );
  fs.symlinkSync(
    path.join(outsideDir, "secret.mp4"),
    path.join(projectDir, "assets", "media", "evil.mp4"),
  );
  return {
    root,
    channelDir,
    videoDir,
    projectDir,
    outsideDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

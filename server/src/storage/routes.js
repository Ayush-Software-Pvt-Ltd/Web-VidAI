// The HTTP routes of storage (docs/SPEC.md section 14): the upload bytes and the files of a video
// folder. All need a session and only ever reach the caller's own uploads and videos; a foreign
// id answers `notFound`, a path that leaves the video folder `forbidden`.

import { forbidden, invalidInput } from "../errors.js";
import { sendJson } from "../http/respond.js";
import { serveFile } from "../http/range.js";
import { contentTypeOf } from "../http/mime.js";
import { hasDotDot, isFullPath, pathApi, pathSegments } from "../platform/fsnames.js";
import { OffsetConflict } from "./uploads.js";

const UPLOAD_PATH = /^\/api\/upload\/(?<id>[0-9a-f]{32})$/;
const OUTSIDE_VIDEO = "That file is outside this video's folder.";

/**
 * What a browser may show in place; anything else (pages, scripts, SVG) is sent as a download so a
 * file an agent wrote can never run in the server's own origin.
 * @param {string} contentType
 */
function isShownInline(contentType) {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/svg+xml") return false;
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "text/plain" ||
    type === "application/json"
  );
}

/**
 * @param {{
 *   uploads: import("./uploads.js").Uploads,
 *   folders: import("./videoFolder.js").VideoFolders,
 *   guard: import("./paths.js").PathGuard,
 *   platform?: string,
 * }} deps
 * @returns {import("../http/types.js").Route[]}
 */
export function createStorageRoutes({ uploads, folders, guard, platform = process.platform }) {
  const api = pathApi(platform);

  /** @param {import("../http/types.js").RouteContext} ctx */
  const userOf = (ctx) => {
    if (!ctx.session) throw new Error("A route with a session was called without one.");
    return ctx.session.user.id;
  };

  return [
    {
      method: "PUT",
      path: UPLOAD_PATH,
      auth: "session",
      async handler(req, res, ctx) {
        const offsetText = ctx.url.searchParams.get("offset") ?? "";
        if (!/^\d{1,16}$/.test(offsetText)) {
          req.resume();
          throw invalidInput("The offset must be a whole number of bytes.");
        }
        const lengthText = req.headers["content-length"];
        const contentLength =
          typeof lengthText === "string" && /^\d+$/.test(lengthText) ? Number(lengthText) : null;
        try {
          const progress = await uploads.append(
            userOf(ctx),
            ctx.params.id ?? "",
            Number(offsetText),
            req,
            { contentLength },
          );
          sendJson(res, 200, progress);
        } catch (error) {
          // The browser continues from the right place without asking (it may also ask with GET).
          if (error instanceof OffsetConflict)
            res.setHeader("X-Upload-Received", String(error.received));
          throw error;
        }
      },
    },

    {
      method: "GET",
      path: UPLOAD_PATH,
      auth: "session",
      async handler(_req, res, ctx) {
        sendJson(res, 200, await uploads.state(userOf(ctx), ctx.params.id ?? ""));
      },
    },

    {
      method: "GET",
      path: "/api/file",
      auth: "session",
      async handler(req, res, ctx) {
        const video = await folders.resolveVideo(userOf(ctx), ctx.url.searchParams.get("video"));
        const relative = ctx.url.searchParams.get("path") ?? "";
        if (relative === "" || relative.includes("\0"))
          throw invalidInput("Say which file you want.");
        if (
          isFullPath(relative, platform) ||
          relative.startsWith("/") ||
          relative.startsWith("\\")
        ) {
          throw forbidden(OUTSIDE_VIDEO);
        }
        if (hasDotDot(relative, platform)) throw forbidden(OUTSIDE_VIDEO);
        const wanted = api.join(video.dir, ...pathSegments(relative, platform));
        const real = await guard.resolve(wanted);
        // Links are followed first, so a link that leads out of this folder (into another video, another
        // user's folder) is caught here, whatever it points at.
        if (!guard.isInside(video.dir, real) || guard.isSame(video.dir, real)) {
          throw forbidden(OUTSIDE_VIDEO);
        }
        const type = contentTypeOf(real);
        const inline = isShownInline(type);
        const download = ctx.url.searchParams.get("download") === "1" || !inline;
        // `sandbox` turns whatever the file is into an inert document with no origin of its own.
        res.setHeader("Content-Security-Policy", "sandbox");
        await serveFile(req, res, real, {
          contentType: inline ? type : "application/octet-stream",
          download,
          headers: { "Cache-Control": "private, no-cache" },
        });
      },
    },
  ];
}

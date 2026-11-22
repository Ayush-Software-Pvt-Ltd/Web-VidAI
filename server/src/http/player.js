// The HyperFrames player element's script for the timeline page: `GET /assets/hyperframes-player.js`
// (docs/SPEC.md sections 11 and 14), read from the pinned package so the page and the project
// preview always run the version the server was tested with.
//
// It is public like the UI's own files (the login page loads the same bundle), and a file of the
// installed package, never of the data directory, so there is nothing to protect. The address has no
// version in it, so a long cache time is only given to a request that names the package version
// (`?v=<version>`, which the page may add); the bare address is revalidated daily and answers
// `304` while the file is unchanged (the ETag comes from the file).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { serveFile } from "./range.js";

/** The route's address; the UI loads exactly this. */
export const PLAYER_PATH = "/assets/hyperframes-player.js";

const ONE_YEAR = "public, max-age=31536000, immutable";
const ONE_DAY = "public, max-age=86400";

/**
 * Where the pinned package keeps the player, and which version it is.
 * @returns {{ file: string, version: string } | null} Null when the package is not installed.
 */
export function findPlayer() {
  try {
    const manifest = createRequire(import.meta.url).resolve("hyperframes/package.json");
    const dir = path.dirname(manifest);
    const file = path.join(dir, "dist", "hyperframes-player.global.js");
    if (!fs.existsSync(file)) return null;
    const version = /** @type {{ version?: unknown }} */ (
      JSON.parse(fs.readFileSync(manifest, "utf8"))
    ).version;
    return { file, version: typeof version === "string" ? version : "0" };
  } catch {
    return null;
  }
}

/**
 * @param {{ file: string, version: string } | null} [player] Default: the pinned package's.
 * @returns {import("./types.js").Route[]} No route when the package is missing (the page then
 *   gets the UI's `404`, and the timeline screen says it has no player).
 */
export function createPlayerRoutes(player = findPlayer()) {
  if (player === null) return [];
  const { file, version } = player;
  return [
    {
      method: "GET",
      path: PLAYER_PATH,
      auth: "none",
      async handler(req, res, ctx) {
        const keyed = ctx.url.searchParams.get("v") === version;
        await serveFile(req, res, file, {
          contentType: "text/javascript; charset=utf-8",
          headers: { "Cache-Control": keyed ? ONE_YEAR : ONE_DAY },
        });
      },
    },
  ];
}

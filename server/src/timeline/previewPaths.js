// Which file a preview address may reach (docs/SPEC.md section 11, Preview).
// The content of a project is written by an agent and is never trusted: the path is checked as text,
// then its real location (symbolic links followed) must lie inside the project folder. The one
// exception is a link in `assets/media`, which points at the user's original footage.
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Split the already decoded path of a request into segments, refusing everything that is not a plain
 * relative path: empty segments, `.` and `..`, names that start with a dot (`.hyperframes`, `.git`),
 * backslashes, NUL, colons (drive letters, stream names) and absolute paths.
 * @param {string} requested The path after the token, decoded once; `""` is the project's page.
 * @returns {string[] | null} The segments (`["index.html"]` for `""`), or null when refused.
 */
export function splitRequestedPath(requested) {
  if (requested === "") return ["index.html"];
  if (requested.includes("\0") || requested.includes("\\") || requested.includes(":")) return null;
  const segments = requested.split("/");
  for (const segment of segments) {
    if (segment === "" || segment.startsWith(".")) return null;
  }
  return segments;
}

/**
 * @param {string} root A real (resolved) directory.
 * @param {string} target A real path.
 * @returns {boolean} Whether target is strictly inside root.
 */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * @param {string} dir
 * @returns {Promise<string | null>} Its real path, null when it does not exist.
 */
async function realOrNull(dir) {
  try {
    return await fsp.realpath(dir);
  } catch {
    return null;
  }
}

/**
 * The real file a request reaches, or null (the answer is 404 either way, so a caller cannot tell a
 * missing file from a refused one).
 * @param {string[]} segments From `splitRequestedPath`.
 * @param {import("./previewTokens.js").PreviewTarget} target
 * @returns {Promise<string | null>} A real path that is inside the real project folder, or for
 *   `assets/media/<name>` inside the real video folder or the real channel directory.
 */
export async function resolvePreviewFile(segments, target) {
  const project = await realOrNull(target.projectDir);
  if (project === null) return null;
  const real = await realOrNull(path.join(project, ...segments));
  if (real === null) return null;
  if (isInside(project, real)) return real;
  if (segments.length !== 3 || segments[0] !== "assets" || segments[1] !== "media") return null;
  for (const allowed of [target.videoDir, target.channelDir]) {
    const root = await realOrNull(allowed);
    if (root !== null && isInside(root, real)) return real;
  }
  return null;
}

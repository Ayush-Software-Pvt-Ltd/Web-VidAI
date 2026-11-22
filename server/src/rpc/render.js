// `renderFinal` of SPEC sections 12 and 14: queues a `render` job for the video's project. The
// job itself is run by `render/runner.js`; this file only refuses what cannot be rendered now,
// with sentences that say what to do.
//
// Refused: the video has an active job (a project is locked while one runs), it has change
// requests that are not applied yet, it has no project, the project fails the profile check
// (the first errors are named), or the disk that holds `cache/` is too small (the numbers are
// named). A video of another user is `notFound` (the library checks).

import { conflict, invalidInput, notReady } from "../errors.js";
import { diskRefusal } from "../render/diskSpace.js";
import { readProjectFacts } from "../render/projectFacts.js";
import { requireSession } from "./context.js";
import { object, oneOf, string, withDefault } from "./validate.js";

/** How many project errors are named in the refusal. */
const NAMED_ERRORS = 3;

/**
 * @typedef {object} RenderRpcDeps
 * @property {{
 *   videoByWireId(userId: string, videoId: unknown): Promise<{ key: string, dir: string, folderName: string }>,
 *   resolveVideoType(userId: string, videoId: unknown): Promise<{ videoType: import("../../../src/lib/wire/channels.ts").VideoType }>,
 * }} library `library.api`.
 * @property {{
 *   projectDir(videoKey: string): Promise<string>,
 *   projectExists(videoKey: string): Promise<boolean>,
 *   check(videoKey: string): Promise<{ violations: string[] }>,
 *   pendingNotes(videoKey: string): readonly unknown[],
 * }} timeline `timeline.api`.
 * @property {(videoKey: string) => { id: string, kind: string } | null | undefined} activeJob
 * @property {(job: { videoKey: string, userId: string, kind: "render", videoType: import("../../../src/lib/wire/channels.ts").VideoType, request: { resolution: import("../../../src/lib/wire/render.ts").RenderResolution } }) => import("../../../src/lib/wire/jobs.ts").JobView} enqueue
 *   `queueService.enqueue`; its `request` is stored in the job row as JSON.
 * @property {string} renderCacheDir `<data dir>/cache/render`.
 * @property {(dir: string) => Promise<number>} freeBytes
 * @property {() => boolean} [renderReady] `toolkit.api.renderReady`: false while the render browser
 *   or the test render of Prepare is not done; the render is then refused with `notReady`.
 *   Default: always ready.
 */

/**
 * @param {RenderRpcDeps} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function renderFunctions({
  library,
  timeline,
  activeJob,
  enqueue,
  renderCacheDir,
  freeBytes,
  renderReady = () => true,
}) {
  const input = object({
    videoId: string({ min: 3, max: 600 }),
    resolution: withDefault(oneOf(/** @type {const} */ ([1080, 2160])), 1080),
  });
  return [
    {
      name: "renderFinal",
      access: "user",
      async handler(raw, ctx) {
        const { videoId, resolution } = input(raw);
        const { user } = requireSession(ctx);
        if (!renderReady()) {
          throw notReady(
            "Rendering is not ready on this server yet: Prepare on the System page has not finished fetching the render browser and testing it. Ask an admin.",
          );
        }
        const video = await library.videoByWireId(user.id, videoId);
        const key = video.key;

        if (activeJob(key)) {
          throw conflict(
            "This video already has a job running or waiting. Wait for it to finish, or stop it, before rendering.",
          );
        }
        if (timeline.pendingNotes(key).length > 0) {
          throw conflict(
            "This video has change requests that are not applied yet. Wait until they are applied, or delete them, before rendering.",
          );
        }
        if (!(await timeline.projectExists(key))) {
          throw notReady("This video has no project yet. Start an edit first.");
        }
        const { violations } = await timeline.check(key);
        if (violations.length > 0) {
          const named = violations.slice(0, NAMED_ERRORS).join(" ");
          const more = violations.length - NAMED_ERRORS;
          throw invalidInput(
            `The project has errors, so it cannot be rendered: ${named}${more > 0 ? ` (and ${more} more)` : ""}`,
          );
        }

        const projectDir = await timeline.projectDir(key);
        /** @type {import("../render/projectFacts.js").ProjectFacts} */
        let project;
        try {
          project = await readProjectFacts(projectDir);
        } catch (error) {
          throw invalidInput(
            error instanceof Error ? error.message : "The project cannot be read.",
          );
        }
        /** @type {number | null} */
        let free = null;
        try {
          free = await freeBytes(renderCacheDir);
        } catch {
          // An unknown amount of room is not a reason to refuse; the runner checks again.
        }
        const refusal =
          free === null ? null : diskRefusal({ seconds: project.seconds, freeBytes: free });
        if (refusal !== null) throw conflict(refusal);

        const { videoType } = await library.resolveVideoType(user.id, videoId);
        return enqueue({
          videoKey: key,
          userId: user.id,
          kind: "render",
          videoType,
          request: { resolution },
        });
      },
    },
  ];
}

// Shared set-up of the timeline service tests: the library world (storage, library, two users), the
// timeline module on top of it with fake jobs, a fake preview and a fake lint, and projects copied
// from the fixtures. Not a test file itself.

import fs from "node:fs";
import path from "node:path";
import { createTimelineModule } from "../../src/timeline/index.js";
import { createLibraryWorld, rejectsCode } from "../library/support.js";
import { FIXTURES } from "./helpers.js";

export { rejectsCode };

/**
 * @param {object} [options]
 * @param {number} [options.keep]
 * @param {(projectDir: string) => Promise<import("../../src/timeline/lint.js").LintResult>} [options.runLint]
 */
export function createTimelineWorld({ keep, runLint } = {}) {
  const w = createLibraryWorld();
  /** @type {{ event: string, payload: any, userId: string | null, admins: boolean }[]} */
  const emitted = [];
  /** @type {Map<string, { id: string, kind: "edit" | "reEdit" | "timelineEdit" | "render" }>} */
  const jobs = new Map();
  /** @type {{ videoKey: string, userId: string }[]} */
  const requests = [];
  /** @type {unknown[]} */
  const previews = [];
  const behaviour = /** @type {{ requestFails: Error | null }} */ ({ requestFails: null });
  const timeline = createTimelineModule({
    db: w.db,
    clock: w.clock,
    log: { info: () => {}, warn: (m) => void w.warnings.push(m), error: () => {} },
    events: { emit: (e) => void emitted.push(/** @type {any} */ (e)) },
    dataDir: w.dataDir,
    library: w.library.api,
    activeJob: (key) => jobs.get(key) ?? null,
    requestTimelineEdit: (request) => {
      if (behaviour.requestFails) throw behaviour.requestFails;
      requests.push(request);
    },
    preview: {
      open: (request) => {
        previews.push(request);
        return { url: "/p/token/" };
      },
    },
    runLint: runLint ?? (async () => ({ errors: [], problem: null })),
    ...(keep === undefined ? {} : { keep }),
  });

  /**
   * A video of the user with a project copied from a fixture.
   * @param {{ id: string }} user
   * @param {{ folder?: string, fixture?: "long" | "short", channelName?: string, project?: boolean }} [options]
   */
  async function videoOf(
    user,
    { folder = "001 A", fixture = "long", channelName = "Main", project = true } = {},
  ) {
    const ch = await w.channelOf(user, channelName);
    const dir = ch.video(folder, "clip.mp4");
    const projectDir = path.join(dir, "output", `${folder}.hf`);
    if (project) fs.cpSync(path.join(FIXTURES, fixture), projectDir, { recursive: true });
    const videoId = `${ch.channel.id}/${folder}`;
    const key = (await w.library.api.videoByWireId(user.id, videoId)).key;
    return { videoId, key, dir, projectDir, channelDir: ch.dir };
  }

  /**
   * A job row (the revisions and notes tables point at jobs).
   * @param {string} key
   * @param {{ id: string }} user
   * @param {string} id
   */
  function makeJob(key, user, id) {
    w.db.run(
      `INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type)
       VALUES (?, ?, ?, 'timelineEdit', 'timeline', 'completed', 1, 'long')`,
      id,
      key,
      user.id,
    );
    return id;
  }

  /**
   * @param {{ id: string, email?: string }} user
   * @param {string} name
   * @param {unknown} input
   * @returns {Promise<any>}
   */
  async function call(user, name, input) {
    const fn = timeline.rpc.find((candidate) => candidate.name === name);
    if (!fn) throw new Error(`no RPC function ${name}`);
    return fn.handler(input, /** @type {never} */ (w.ctxOf(user)));
  }

  /** @param {string} event */
  const eventsNamed = (event) => emitted.filter((e) => e.event === event);

  return {
    ...w,
    timeline,
    emitted,
    eventsNamed,
    jobs,
    requests,
    previews,
    behaviour,
    videoOf,
    makeJob,
    call,
    cleanup: () => w.cleanup(),
  };
}

/** A delete of a clip that has nothing depending on it in the long fixture. @param {string} clipId */
export const del = (clipId) => ({ type: /** @type {const} */ ("delete"), clipId });

/** @param {string} projectDir */
export const readIndex = (projectDir) =>
  fs.readFileSync(path.join(projectDir, "index.html"), "utf8");

/** Whether a clip element with this id is in the text. @param {string} html @param {string} id */
export const hasClip = (html, id) => html.includes(`id="${id}"`);

// The timeline module (docs/SPEC.md sections 10, 11, 14 and 15): reading a project as a timeline,
// hand edits, revisions with undo and redo, change requests, and the check of a project (profile
// plus `hyperframes lint`). `createTimelineModule(deps)` is plugged into the composition root like
// the library module: `rpc` into `rpc.register`, `api` for the job manager and the preview.
//
// Deps (everything about jobs and the preview is injected: the job manager and the preview server
// are written separately):
// - `db`, `clock`, `log`, `events`, `dataDir` as everywhere;
// - `library`: `library.api` of the library module (`videoByWireId`, `describeKey`);
// - `activeJob(videoKey) => { id, kind } | null`: the active job of a video; while there is one the
//   project is locked (`JobView` fits). Default: never locked;
// - `requestTimelineEdit({ videoKey, userId }) => void | Promise<void>`: queue a `timelineEdit` job
//   for the video's pending change requests (the job manager takes them with `api.takeNotes`);
//   it may throw an `AppError` (not ready ...), which reaches the user who sent the request.
//   Default: does nothing;
// - `preview`: `{ open({ sessionId, userId, videoKey, projectDir, videoDir, channelDir }) => { url } }`;
//   default null: `openTimeline` answers `previewUrl: null`;
// - `hyperframesBin`: the CLI script for lint (default: the installed `hyperframes` package);
// - `runLint(projectDir) => Promise<{ errors: string[], problem: string | null }>`: replaces the CLI
//   (tests); `keep`: revisions kept per video (default 200).
//
// Wiring notes for the composition root (`app.js`):
//   const timeline = createTimelineModule({ db, clock, log, events, dataDir: paths.dataDir,
//     library: library.api, activeJob: jobs.api.activeJobOf, requestTimelineEdit: jobs.api.requestTimelineEdit,
//     preview: preview.api });
//   rpc.register(timeline.rpc);  // plus `timeline.stop`/`start` in the module list
// The job manager calls `timeline.api` (documented on each function in `service.js`): `check` after a
// job and in the agent's check, `saveRevision` when a job ends, `restoreTo` after a failed job,
// `takeNotes`/`finishNotes`/`clipsAt`/`noteDir` around a `timelineEdit`, `videoFreed` when a job of a
// video ended, `removeVideo` when a video is deleted.

import { createNotesRepo } from "../db/notes.js";
import { createRevisionsRepo } from "../db/revisions.js";
import { createUsersRepo } from "../db/users.js";
import { dataPaths } from "../config.js";
import { timelineFunctions } from "../rpc/timeline.js";
import { createProjectCheck } from "./check.js";
import { createLint } from "./lint.js";
import { createTimelineService } from "./service.js";

/**
 * @typedef {object} TimelineDeps
 * @property {import("../db/open.js").Database} db
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {string} dataDir
 * @property {import("./service.js").ServiceDeps["library"]} library
 * @property {import("./service.js").ServiceDeps["activeJob"]} [activeJob]
 * @property {import("./service.js").ServiceDeps["requestTimelineEdit"]} [requestTimelineEdit]
 * @property {import("./service.js").ServiceDeps["preview"]} [preview]
 * @property {import("./service.js").ServiceDeps["previewCopies"]} [previewCopies]
 * @property {string | null} [hyperframesBin]
 * @property {(projectDir: string) => Promise<import("./lint.js").LintResult>} [runLint]
 * @property {number} [keep]
 */

/** @param {TimelineDeps} deps */
export function createTimelineModule({
  db,
  clock,
  log,
  events,
  dataDir,
  library,
  activeJob = () => null,
  requestTimelineEdit = () => {},
  preview = null,
  previewCopies = null,
  hyperframesBin,
  runLint,
  keep,
}) {
  const lint = runLint ?? createLint(hyperframesBin === undefined ? {} : { cli: hyperframesBin });
  const service = createTimelineService({
    revisionsRepo: createRevisionsRepo(db, { clock }),
    notesRepo: createNotesRepo(db, { clock }),
    users: createUsersRepo(db, { clock }),
    library,
    events,
    log,
    projectsDir: dataPaths(dataDir).projectsDir,
    activeJob,
    requestTimelineEdit,
    preview,
    previewCopies,
    check: createProjectCheck({ lint }),
    ...(keep === undefined ? {} : { keep }),
  });

  return {
    name: "timeline",
    rpc: timelineFunctions({ service }),
    api: service.api,
  };
}

/** @typedef {ReturnType<typeof createTimelineModule>} TimelineModule */

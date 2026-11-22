// Shared typedefs of the job manager files, and `requestOf`.

/** @typedef {import("../db/jobs.js").JobRecord} JobRecord */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobView} JobView */
/** @typedef {import("./keepgoing.js").JobKind} JobKind */
/** @typedef {import("../../../src/lib/wire/channels.ts").VideoType} VideoType */

/**
 * The parts of the request column the manager keeps (all optional; set along the way).
 * @typedef {object} JobRequest
 * @property {string} [text] Re-Edit: the user's text.
 * @property {number} [resolution] Render: 1080 or 2160.
 * @property {number | null} [beforeRevision] The revision saved before the job.
 * @property {string | null} [beforeFingerprint] The project's content before the job.
 * @property {import("./promptTimeline.js").PromptRequest[]} [notes] The taken, described change requests.
 * @property {import("./promptFollowUp.js").AgentKind} [afterFailure] Set by Continue of a failed job.
 */

/**
 * What the manager may ask of a render.
 * @typedef {object} RenderFacts
 * @property {string} videoKey
 * @property {string} videoId
 * @property {string} userId
 * @property {string} videoDir
 * @property {string} channelDir
 * @property {string} projectDir
 * @property {string} folderName
 * @property {1080 | 2160} resolution
 * @property {VideoType} videoType
 * @property {(patch: { lastActivity?: string, progress?: { view: NonNullable<import("../../../src/lib/wire/jobs.ts").JobView["progress"]>, memory: null, persist: boolean } }) => void} onUpdate
 */

/**
 * @typedef {object} RenderRunner
 * @property {(job: JobRecord & { onUpdate: RenderFacts["onUpdate"] }, facts: RenderFacts) => { done: Promise<import("./driver.js").AgentOutcome>, stop(): void }} run
 */

/**
 * @typedef {object} EditLogEntry
 * @property {string} userId
 * @property {string} videoKey
 * @property {"started" | "completed" | "failed" | "stopped" | "paused" | "continued"} event
 * @property {string} message
 */

/**
 * @param {JobRecord} job
 * @returns {import("./managerTypes.js").JobRequest}
 */
export function requestOf(job) {
  const request = job.request;
  return typeof request === "object" && request !== null && !Array.isArray(request)
    ? /** @type {JobRequest} */ (request)
    : {};
}

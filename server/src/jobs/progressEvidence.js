// Evidence from the output folder (docs/SPEC-desktop.md section 6 "Progress", evidence 2, and
// docs/SPEC.md section 10): the project folder `<video>/output/<video folder name>.hf/` with its
// `index.html`, the thumbnails and `meta.txt`, written after the job started. Files that were
// there, unchanged, when the run started never count, so a file the previous job wrote a moment
// before this one started is not this job's work.
//
// The engine never touches the disk: it is fed an `OutputProbe` by a function. `createDiskProbe`
// is the real one; tests pass their own.

import fs from "node:fs";
import path from "node:path";

/**
 * What the files of a video show at one moment. Times are epoch milliseconds.
 * @typedef {object} OutputProbe
 * @property {boolean} projectExists `output/<video>.hf/index.html` exists.
 * @property {number | null} projectModifiedAt Its modification time.
 * @property {number | null} thumbnailsModifiedAt The newest `thumbnail-*` picture in `output/`.
 * @property {number | null} metaModifiedAt `output/meta.txt`.
 */

/** A file time with a second of tolerance for file systems that store whole seconds. */
const TOLERANCE_MS = 1000;

/** @returns {OutputProbe} */
export function emptyProbe() {
  return {
    projectExists: false,
    projectModifiedAt: null,
    thumbnailsModifiedAt: null,
    metaModifiedAt: null,
  };
}

/**
 * Which files of the project are new since the job started.
 *
 * The project counts when `index.html` exists and is not the very file that was there when this
 * run started; for `reEdit` and `timelineEdit`, which change a project that already exists, it
 * must also have been modified after the job started. The thumbnails and `meta.txt` count when
 * they were written since the job started and changed since the run started.
 * @param {OutputProbe} probe
 * @param {object} context
 * @param {import("./progressModels.js").AgentKind} context.kind
 * @param {number} context.since When the job first started (epoch ms).
 * @param {OutputProbe | null} [context.known] The probe taken when this run started.
 * @returns {import("./progressEngine.js").OutputEvidence}
 */
export function outputEvidence(probe, { kind, since, known = null }) {
  const from = since - TOLERANCE_MS;
  const fresh = (
    /** @type {number | null} */ time,
    /** @type {number | null | undefined} */ before,
  ) => time !== null && time >= from && time !== before;
  const projectUnchanged =
    known !== null && known.projectExists && known.projectModifiedAt === probe.projectModifiedAt;
  const project =
    probe.projectExists &&
    !projectUnchanged &&
    (kind === "edit" || fresh(probe.projectModifiedAt, known?.projectModifiedAt));
  return {
    project,
    thumbnails: fresh(probe.thumbnailsModifiedAt, known?.thumbnailsModifiedAt),
    meta: fresh(probe.metaModifiedAt, known?.metaModifiedAt),
  };
}

/**
 * @param {string} file
 * @returns {number | null}
 */
function modifiedAt(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The pictures a thumbnail can be, by extension. */
const THUMBNAIL = /^thumbnail-.*\.(png|jpe?g)$/iu;

/**
 * The real probe of a video folder: looks at the disk each time it is called.
 * @param {string} videoDir The video folder (its name is the name of the project folder).
 * @returns {() => OutputProbe}
 */
export function createDiskProbe(videoDir) {
  const output = path.join(videoDir, "output");
  const index = path.join(output, `${path.basename(videoDir)}.hf`, "index.html");
  return () => {
    const project = modifiedAt(index);
    /** @type {number | null} */
    let thumbnails = null;
    let metaName = null;
    try {
      for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        if (THUMBNAIL.test(entry.name)) {
          const time = modifiedAt(path.join(output, entry.name));
          if (time !== null && (thumbnails === null || time > thumbnails)) thumbnails = time;
        } else if (entry.name.toLowerCase() === "meta.txt") {
          metaName = entry.name;
        }
      }
    } catch {
      // No output folder yet: nothing to see.
    }
    return {
      projectExists: project !== null,
      projectModifiedAt: project,
      thumbnailsModifiedAt: thumbnails,
      metaModifiedAt: metaName === null ? null : modifiedAt(path.join(output, metaName)),
    };
  };
}

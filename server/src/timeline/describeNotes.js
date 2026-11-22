// `describeNotes(videoKey, notes)` for the job manager (docs/SPEC.md section 11, Change requests):
// turns the change requests a `timelineEdit` job has just taken into what `composeTimelineEdit`
// needs per request: the clips at the frame, the picture files, the words spoken around the time.
//
// The pictures are made in one run for all requests (`notePictures.js`); a request whose pictures
// could not be made goes out with `pictures: { frame: null, closeup: null, marked: null }` and the message says
// so. Nothing here ever throws because of a picture, a transcript or a project that cannot be read:
// the request is still sent, with less.
//
// Wiring (composition root, see the report): the result also carries `removeFor(videoKey, noteId)`,
// `sweep(videoKey, keepNoteIds)` and `stop()`.

import path from "node:path";
import fsp from "node:fs/promises";
import { createNoteFolders } from "./noteFolders.js";
import { parseProject } from "./document.js";
import { loadWords, spokenAround } from "./spoken.js";
import { frameMiddle } from "./noteTimes.js";

/** @typedef {import("../jobs/promptTimeline.js").PromptRequest} PromptRequest */
/** @typedef {import("./service.js").PromptNote} PromptNote */

/**
 * @typedef {object} DescribeNotesDeps
 * @property {(videoKey: string, frame: number) => Promise<import("./clipsAt.js").ClipAt[]>} clipsAt `timeline.api.clipsAt`.
 * @property {(videoKey: string) => Promise<string>} projectDir `timeline.api.projectDir`.
 * @property {(videoKey: string, noteId: string) => string} noteDir `timeline.api.noteDir`.
 * @property {ReturnType<typeof import("./notePictures.js").createNotePictures>} pictures The ONE capturer of the server
 *   (a second one would allow two captures at a time).
 * @property {Pick<import("../log.js").Logger, "info" | "warn">} [log]
 */

/**
 * @typedef {object} ProjectFacts
 * @property {import("./frames.js").Fps} fps
 * @property {number} width
 * @property {number} height
 */

/**
 * The frame rate and size the pictures need, from the root element of `index.html`.
 * @param {string} projectDir
 * @returns {Promise<ProjectFacts | null>} Null when `index.html` has no usable root.
 */
export async function readProjectFacts(projectDir) {
  let html;
  try {
    html = await fsp.readFile(path.join(projectDir, "index.html"), "utf8");
  } catch {
    return null;
  }
  const root = parseProject(html).root;
  if (!root || !root.fps || !root.width || !root.height) return null;
  return { fps: root.fps, width: root.width, height: root.height };
}

/**
 * @typedef {((videoKey: string, notes: PromptNote[]) => Promise<PromptRequest[]>) & {
 *   removeFor(videoKey: string, noteId: string): Promise<void>,
 *   sweep(videoKey: string, keepNoteIds: Iterable<string>): Promise<string[]>,
 *   stop(): Promise<void>,
 * }} DescribeNotes
 */

/**
 * @param {DescribeNotesDeps} deps
 * @returns {DescribeNotes}
 */
export function createDescribeNotes({
  clipsAt,
  projectDir,
  noteDir,
  pictures,
  log = { info() {}, warn() {} },
}) {
  const folders = createNoteFolders({ noteDir });

  /**
   * @param {string} videoKey
   * @param {PromptNote[]} notes
   * @returns {Promise<PromptRequest[]>}
   */
  async function describeNotes(videoKey, notes) {
    if (notes.length === 0) return [];
    /** @type {string | null} */
    let dir = null;
    /** @type {ProjectFacts | null} */
    let facts = null;
    try {
      dir = await projectDir(videoKey);
      facts = await readProjectFacts(dir);
    } catch (error) {
      log.warn(`Change requests: the project of ${videoKey} could not be read (${error}).`);
    }
    if (facts === null) log.warn(`Change requests: the project of ${videoKey} has no frame size.`);

    /** @type {import("./notePictures.js").NotePictureFiles[]} */
    let made = notes.map(() => ({ frame: null, closeup: null, marked: null }));
    if (dir !== null && facts !== null) {
      made = await pictures.capture({
        projectDir: dir,
        fps: facts.fps,
        width: facts.width,
        height: facts.height,
        requests: notes.map((note) => ({
          frame: note.frame,
          shape: note.shape,
          folder: path.resolve(note.folder),
        })),
      });
    }
    const words = dir === null ? [] : await loadWords(dir);

    return Promise.all(
      notes.map(async (note, index) => {
        const files = made[index];
        const spoken =
          facts === null ? "" : spokenAround(words, frameMiddle(note.frame, facts.fps));
        return {
          frame: note.frame,
          shape: note.shape,
          elementId: note.elementId,
          prompt: note.prompt,
          pictures: {
            frame: files?.frame ?? null,
            closeup: files?.closeup ?? null,
            marked: files?.marked ?? null,
          },
          clips: (await clipsAt(videoKey, note.frame)).map((clip) => ({
            id: clip.id,
            kind: clip.kind,
            label: clip.label,
            track: clip.track,
            file: clip.file,
          })),
          spoken,
        };
      }),
    );
  }

  return Object.assign(describeNotes, {
    removeFor: folders.removeFor,
    sweep: folders.sweep,
    stop: () => pictures.stop(),
  });
}

// Change requests, the pure part (docs/SPEC.md section 11, Change requests): checking what a user
// sends, and the wire shape of a stored request.

import { invalidInput } from "../errors.js";

/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineNote} TimelineNote */
/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteShape} NoteShape */
/** @typedef {import("../db/notes.js").NoteRecord} NoteRecord */

/** The longest request text, in characters. */
export const MAX_PROMPT_CHARS = 4000;

/**
 * @param {NoteRecord} note
 * @returns {TimelineNote}
 */
export function toNoteView(note) {
  return {
    id: note.id,
    frame: note.frame,
    shape: note.shape,
    elementId: note.elementId,
    prompt: note.prompt,
    state: note.state,
    jobId: note.jobId,
    error: note.error,
    createdAt: note.createdAt,
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {value is number} */
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Checks the input of `addTimelineNote`.
 * - `frame`: a whole number inside the video, `0 <= frame < duration`;
 * - `shape`: `null` or `{ cx, cy, rx, ry }` as fractions of the frame: the centre between 0 and 1,
 *   the radii above 0 and at most 1 (an ellipse may reach past the edge);
 * - `elementId`: `null` or the id of a clip of the project;
 * - `prompt`: 1 to 4000 characters after trimming.
 * @param {unknown} input
 * @param {{ duration: number, clipIds: ReadonlySet<string> }} project
 * @returns {{ frame: number, shape: NoteShape | null, elementId: string | null, prompt: string }}
 * @throws {import("../errors.js").AppError} `invalidInput` with a sentence.
 */
export function validateNote(input, { duration, clipIds }) {
  if (!isRecord(input)) throw invalidInput("The change request is missing.");
  const { frame, shape, elementId, prompt } = input;
  if (typeof frame !== "number" || !Number.isInteger(frame)) {
    throw invalidInput("The frame of a change request must be a whole number.");
  }
  if (frame < 0 || frame >= duration) {
    throw invalidInput(
      `The frame ${frame} is not inside the video, which has frames 0 to ${duration - 1}.`,
    );
  }
  /** @type {NoteShape | null} */
  let checked = null;
  if (shape !== null && shape !== undefined) {
    if (!isRecord(shape)) throw invalidInput("The marked area must be an ellipse or nothing.");
    const { cx, cy, rx, ry } = shape;
    if (!isNumber(cx) || !isNumber(cy) || !isNumber(rx) || !isNumber(ry)) {
      throw invalidInput("The marked area needs a centre (cx, cy) and radii (rx, ry) as numbers.");
    }
    if (cx < 0 || cx > 1 || cy < 0 || cy > 1) {
      throw invalidInput("The centre of the marked area must lie inside the frame.");
    }
    if (rx <= 0 || rx > 1 || ry <= 0 || ry > 1) {
      throw invalidInput(
        "The marked area must have a size above zero and at most the whole frame.",
      );
    }
    checked = { cx, cy, rx, ry };
  }
  /** @type {string | null} */
  let element = null;
  if (elementId !== null && elementId !== undefined) {
    if (typeof elementId !== "string" || !clipIds.has(elementId)) {
      throw invalidInput("The chosen clip is not in this video.");
    }
    element = elementId;
  }
  if (typeof prompt !== "string") throw invalidInput("Write what should change.");
  const text = prompt.trim();
  const length = [...text].length;
  if (length < 1) throw invalidInput("Write what should change.");
  if (length > MAX_PROMPT_CHARS) {
    throw invalidInput(
      `The text of a change request can have at most ${MAX_PROMPT_CHARS} characters.`,
    );
  }
  return { frame, shape: checked, elementId: element, prompt: text };
}

// The words spoken around a change request's time (docs/SPEC.md section 10, `transcript.json`, and
// section 11, Change requests), as one line for the message to the agent.
//
// `transcript.json` is `{"words":[{"word","start","end"}]}` in seconds on the EDITED timeline (the
// toolkit maps the source's words through the A-roll cuts when it writes the project, see
// `Project.transcript` in `toolkit/CLAUDE_VE_ALL/vekit/hfproject.py`), so the times are compared
// with the frame's time directly and no mapping through the clips is needed.
//
// The line holds the words from 4 seconds before to 4 seconds after the frame's time (a word is in
// when any part of it falls inside), in time order, joined by spaces. The word being said at the
// frame is marked in the line as `[at this frame: word]`, a stretch of silence at the frame as
// `[at this frame: silence]`; the marker is plain text the agent reads without a legend.

import fsp from "node:fs/promises";
import path from "node:path";
import { frameMiddle } from "./noteTimes.js";

/** @typedef {import("./frames.js").Fps} Fps */

/** Seconds before and after the frame's time that are included. */
export const SPOKEN_WINDOW_SECONDS = 4;

/** The file name in the project folder. */
export const TRANSCRIPT_FILE = "transcript.json";

/** The biggest transcript that is read, in bytes (a damaged or foreign file is not loaded whole). */
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {object} SpokenWord
 * @property {string} word
 * @property {number} start Seconds on the timeline.
 * @property {number} end
 */

/**
 * The usable words of a parsed transcript, sorted by start. Entries that are not a word with a
 * finite start and end (end not before start) are dropped, so a damaged file gives fewer words,
 * never an error.
 * @param {unknown} value
 * @returns {SpokenWord[]}
 */
export function readWords(value) {
  if (typeof value !== "object" || value === null) return [];
  const list = /** @type {{ words?: unknown }} */ (value).words;
  if (!Array.isArray(list)) return [];
  /** @type {SpokenWord[]} */
  const words = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { word, start, end } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const text = word.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    words.push({ word: text, start, end });
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The line of words around a time.
 * @param {SpokenWord[]} words Sorted by start.
 * @param {number} seconds The frame's time (its middle).
 * @returns {string} `""` when no word is in the window.
 */
export function spokenAround(words, seconds) {
  const from = seconds - SPOKEN_WINDOW_SECONDS;
  const to = seconds + SPOKEN_WINDOW_SECONDS;
  const inside = words.filter((w) => w.end > from && w.start < to);
  if (inside.length === 0) return "";
  /** @type {string[]} */
  const parts = [];
  let marked = false;
  for (const w of inside) {
    // Silence at the frame: the first word after the frame's time comes after a gap that holds it.
    if (!marked && w.start > seconds) {
      parts.push("[at this frame: silence]");
      marked = true;
    }
    if (!marked && w.start <= seconds && seconds < w.end) {
      parts.push(`[at this frame: ${w.word}]`);
      marked = true;
    } else {
      parts.push(w.word);
    }
  }
  // The frame is after the last word of the window.
  if (!marked) parts.push("[at this frame: silence]");
  return parts.join(" ");
}

/**
 * The words around a frame of a project; `""` without a readable transcript.
 * @param {string} projectDir
 * @param {number} frame
 * @param {Fps} fps
 * @returns {Promise<string>}
 */
export async function spokenAtFrame(projectDir, frame, fps) {
  const words = await loadWords(projectDir);
  return spokenAround(words, frameMiddle(frame, fps));
}

/**
 * Reads `transcript.json` of a project. A missing, too big or damaged file gives no words.
 * @param {string} projectDir
 * @returns {Promise<SpokenWord[]>}
 */
export async function loadWords(projectDir) {
  const file = path.join(projectDir, TRANSCRIPT_FILE);
  try {
    const info = await fsp.stat(file);
    if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) return [];
    return readWords(JSON.parse(await fsp.readFile(file, "utf8")));
  } catch {
    return [];
  }
}

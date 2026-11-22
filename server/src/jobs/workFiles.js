// Evidence in the working folder of a video (docs/SPEC.md section 8, "Progress",
// evidence 2).
//
// A model may never write its progress markers while it works (the OpenCode models of the owner's
// real edits wrote all of them in their last message), and a model without sub-agents gives the
// stream no milestone to see. What an edit leaves on disk does not depend on the program or the
// model: the audio that was extracted, the transcript, the plan or timeline file, the graphics
// sources and renders, the quality-check output. This module looks at the video folder
// (`CLAUDE_VE/` and the rest, `output/` aside, which the project check reads) and says which
// kinds of files appeared since the job started.
//
// The kinds come from what the real edits wrote and when, by folder and file *names* only, never
// from content, and not tied to one toolkit's exact names:
//
// | Kind          | Looks like                                                                  |
// | audio         | an audio file (wav, mp3, m4a, ...)                                          |
// | transcript    | a text file in a folder or with a name that says transcript, any srt / vtt  |
// | plan          | a text or script file named plan, timeline, spec, cue sheet, EDL, storyboard |
// | graphics      | any file in a folder named gfx..., graphic..., hyperframes, remotion, compositions, cards, overlays |
// | quality check | any file or folder named qa, qa_..., ...-qa                                 |
//
// Everything here is pure except `scan`, which reads the folder, bounded in depth, entries and
// time so a folder with ten thousands of frames stays cheap, and never follows a link.

import fs from "node:fs";
import path from "node:path";

/** @typedef {{ now(): number }} Clock */

/** Folders that are never looked into: tool caches and dependencies that hold thousands of files. */
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".hyperframes",
  ".cache",
  ".whisper",
]);
/** Folders that belong to the toolkit, not to the video (a link normally; never read). */
const TOOLKIT_DIRS = new Set(["claude_ve_all", "claude_ve_all_own"]);
/** The folder of the video where the edit keeps its working files. */
const WORK_DIR = "claude_ve";

const MAX_DEPTH = 8;
const MAX_ENTRIES = 20_000;
const MAX_SCAN_MS = 300;

const AUDIO_EXT = new Set(["wav", "mp3", "m4a", "aac", "flac", "aif", "aiff", "ogg", "opus"]);
const TRANSCRIPT_EXT = new Set(["json", "txt", "md", "srt", "vtt", "tsv", "csv"]);
const PLAN_EXT = new Set([
  "md",
  "txt",
  "json",
  "py",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "js",
  "ts",
]);
const PLAN_WORDS = ["plan", "timeline", "spec", "cue", "edl", "storyboard", "shotlist"];

/**
 * A file of the video folder, as the scan found it.
 * @typedef {object} WorkFile
 * @property {string} path Relative to the video folder, lower case, `/` as separator.
 * @property {number} modified Modification time, epoch ms.
 */

/**
 * The kinds of files a path belongs to (usually none or one).
 * @typedef {object} Kinds
 * @property {boolean} audio
 * @property {boolean} transcript
 * @property {boolean} plan
 * @property {boolean} graphics
 * @property {boolean} qualityCheck
 */

/**
 * Which kinds appeared since the job started, and how many files did.
 * @typedef {Kinds & { files: number }} WorkEvidence `files` counts the files in the video folder
 *   written since the job started, `output/` included: how much the job has done, whatever it is
 *   (the stuck-model rule of `keepgoing.js` counts it).
 */

/** @returns {Kinds} */
const noKinds = () => ({
  audio: false,
  transcript: false,
  plan: false,
  graphics: false,
  qualityCheck: false,
});

/**
 * The path components after the working folder (`CLAUDE_VE`) when the path is inside one, else
 * all of them for a relative path; lower case. An absolute path of the stream with no working
 * folder in it is judged by its file name alone (and the folder it is in, when that is
 * `output`), so a video named "Best plan for graphics" never changes the kind of its files.
 * @param {string} filePath
 * @returns {string[]}
 */
export function componentsInWork(filePath) {
  const parts = filePath
    .split(/[/\\]/)
    .filter((c) => c !== "" && c !== ".")
    .map((c) => c.toLowerCase());
  const work = parts.lastIndexOf(WORK_DIR);
  if (work >= 0) return parts.slice(work + 1);
  const absolute = /^[/\\]/.test(filePath) || filePath[1] === ":";
  if (!absolute) return parts;
  const keep = parts.length >= 2 && parts[parts.length - 2] === "output" ? 2 : 1;
  return parts.slice(Math.max(0, parts.length - keep));
}

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * Whether a name (a folder, or a file without its extension) says it belongs to a quality check:
 * `qa`, `qa_sheet_1`, `qa-frames`, `transcripts_qa`.
 * @param {string} name
 * @returns {boolean}
 */
function isQualityCheck(name) {
  if (name.startsWith("qa")) {
    const third = Array.from(name)[2];
    if (third === undefined || !ALNUM.test(third)) return true;
  }
  return (
    name.endsWith("_qa") || name.endsWith("-qa") || name.includes("_qa_") || name.includes("-qa-")
  );
}

/**
 * The words of a file name, split at everything that is not a letter or digit.
 * @param {string} stem
 * @returns {string[]}
 */
function wordsOf(stem) {
  return stem.split(/[^\p{L}\p{N}]/u).filter((w) => w !== "");
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isGraphicsDir(name) {
  return (
    name.startsWith("gfx") ||
    name.startsWith("graphic") ||
    ["hyperframes", "remotion", "compositions", "cards", "overlays"].includes(name)
  );
}

/**
 * Whether a file name (without its extension, lower case) names a plan: a word that starts with
 * plan, timeline, spec, cue, edl, storyboard or shotlist, or the two words "shot list".
 * @param {string} stem
 * @returns {boolean}
 */
export function isPlanName(stem) {
  const words = wordsOf(stem);
  return (
    words.some((w) => PLAN_WORDS.some((p) => w.startsWith(p))) ||
    words.some((w, i) => w === "shot" && words[i + 1] === "list")
  );
}

/**
 * The kinds of a path given as components (see `componentsInWork`); the last one is the file
 * name. A path in `output/` has none: the project and the thumbnails are the business of the
 * project check.
 * @param {readonly string[]} components
 * @returns {Kinds}
 */
export function kindsOf(components) {
  const file = components[components.length - 1];
  if (file === undefined) return noKinds();
  const dirs = components.slice(0, -1);
  if (dirs[0] === "output") return noKinds();
  const dot = file.lastIndexOf(".");
  const stem = dot < 0 ? file : file.slice(0, dot);
  const ext = dot < 0 ? "" : file.slice(dot + 1);
  if (dirs.some((d) => TOOLKIT_DIRS.has(d))) return noKinds();
  if (dirs.some(isQualityCheck) || isQualityCheck(stem)) {
    return { ...noKinds(), qualityCheck: true };
  }
  if (dirs.some(isGraphicsDir)) return { ...noKinds(), graphics: true };
  const transcripty = dirs.some((d) => d.includes("transcri")) || stem.includes("transcri");
  if (ext === "srt" || ext === "vtt" || (transcripty && TRANSCRIPT_EXT.has(ext))) {
    return { ...noKinds(), transcript: true };
  }
  if (AUDIO_EXT.has(ext)) return { ...noKinds(), audio: true };
  if (PLAN_EXT.has(ext) && isPlanName(stem)) return { ...noKinds(), plan: true };
  return noKinds();
}

/**
 * The kinds of a path of the tool stream (absolute or relative).
 * @param {string} filePath
 * @returns {Kinds}
 */
export function kindsOfPath(filePath) {
  return kindsOf(componentsInWork(filePath));
}

/**
 * What the files written at or after `since` say (with a second of tolerance for file systems
 * that store whole seconds).
 * @param {readonly WorkFile[]} files
 * @param {number} since Epoch ms.
 * @returns {WorkEvidence}
 */
export function evidence(files, since) {
  const from = since - 1000;
  /** @type {WorkEvidence} */
  const out = { ...noKinds(), files: 0 };
  for (const file of files) {
    if (file.modified < from) continue;
    out.files += 1;
    const kinds = kindsOf(componentsInWork(file.path));
    out.audio ||= kinds.audio;
    out.transcript ||= kinds.transcript;
    out.plan ||= kinds.plan;
    out.graphics ||= kinds.graphics;
    out.qualityCheck ||= kinds.qualityCheck;
  }
  return out;
}

/**
 * Every regular file of the video folder (links are not followed and not listed), within the
 * limits above; what the limits cut off is simply not seen.
 * @param {string} videoDir
 * @param {{ clock?: Clock, maxMs?: number }} [options]
 * @returns {WorkFile[]}
 */
export function scan(videoDir, { clock = { now: () => Date.now() }, maxMs = MAX_SCAN_MS } = {}) {
  const started = clock.now();
  /** @type {WorkFile[]} */
  const out = [];
  /** @type {{ dir: string, prefix: string, depth: number }[]} */
  const stack = [{ dir: videoDir, prefix: "", depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_ENTRIES || clock.now() - started > maxMs) return out;
      const name = entry.name.toLowerCase();
      const rel = item.prefix === "" ? name : `${item.prefix}/${name}`;
      if (entry.isDirectory()) {
        if (item.depth < MAX_DEPTH && !SKIPPED_DIRS.has(name)) {
          stack.push({ dir: path.join(item.dir, entry.name), prefix: rel, depth: item.depth + 1 });
        }
      } else if (entry.isFile()) {
        try {
          const modified = fs.statSync(path.join(item.dir, entry.name)).mtimeMs;
          out.push({ path: rel, modified });
        } catch {
          // Gone between the listing and the look: not evidence.
        }
      }
    }
  }
  return out;
}

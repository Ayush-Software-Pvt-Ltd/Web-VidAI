// Inference from the stream (docs/SPEC-desktop.md section 6 "Progress", evidence 4 and "Setup is
// not the work"): generic keywords in tool calls, background tasks and sub-agents, never tied to
// one toolkit's file names.

/**
 * What a background task or sub-agent works on, from its description.
 * `setup` is installing or testing tools: it says nothing about any step of the work.
 * @typedef {"transcription" | "graphics" | "broll" | "extras" | "setup" | "other"} Group
 */

/**
 * @param {string} haystack Lower case.
 * @param {readonly string[]} needles
 * @returns {boolean}
 */
export function containsAny(haystack, needles) {
  return needles.some((n) => haystack.includes(n));
}

const TRANSCRIPTION_WORDS = ["whisper", "transcrib", "transcript"];
const GRAPHICS_WORDS = [
  "graphic",
  "gfx",
  "hyperframes",
  "remotion",
  "animat",
  "motion",
  "composition",
  "cards",
  "pop-up",
  "popup",
  "overlay",
  "lower third",
  "title card",
];
const BROLL_WORDS = [
  "b-roll",
  "broll",
  "b roll",
  "conform",
  "stabili",
  "mezzanine",
  "product",
  "cut-out",
  "cutout",
  "packshot",
];
const EXTRAS_WORDS = ["thumbnail", "meta.txt", "metadata"];

/**
 * Words of commands and tasks that prepare the computer instead of doing the work: installing a
 * transcriber, creating its environment, downloading its model, a smoke test. Seen on an Intel
 * Mac, where a job spent half an hour on them; none of it is transcribing, however often it names
 * Whisper.
 */
const SETUP_WORDS = [
  "install",
  "venv",
  "virtualenv",
  "brew ",
  "apt-get",
  "smoke",
  "pip ",
  "pip3 ",
  "--help",
  "--version",
];
/** What a download is of, to count as setup. */
const SETUP_DOWNLOADS = ["model", "whisper", "ffmpeg", "node", "python", "tarball", "weights"];

/**
 * Whether a command or task description (lower case) prepares tools rather than works.
 * @param {string} text
 * @returns {boolean}
 */
export function isSetup(text) {
  return (
    containsAny(text, SETUP_WORDS) ||
    (containsAny(text, ["download", "curl ", "wget "]) && containsAny(text, SETUP_DOWNLOADS)) ||
    (text.includes("check ") && containsAny(text, ["import", "binar", "packages", "available"]))
  );
}

/**
 * Classifies a task or sub-agent description (lower case). Setup first (it names the very tools
 * it is not using), then extras (a "thumbnail graphics" agent makes thumbnails), then the step
 * after the plan, then transcription.
 * @param {string} description
 * @returns {Group}
 */
export function classify(description) {
  if (isSetup(description)) return "setup";
  if (containsAny(description, EXTRAS_WORDS)) return "extras";
  if (containsAny(description, GRAPHICS_WORDS)) return "graphics";
  if (containsAny(description, BROLL_WORDS)) return "broll";
  if (containsAny(description, TRANSCRIPTION_WORDS)) return "transcription";
  return "other";
}

/**
 * A string field of a tool input, `""` when it is missing or not a string.
 * @param {unknown} input
 * @param {string} key
 * @returns {string}
 */
export function inputStr(input, key) {
  if (typeof input !== "object" || input === null) return "";
  const value = /** @type {Record<string, unknown>} */ (input)[key];
  return typeof value === "string" ? value : "";
}

/**
 * A flag of a tool input; Claude Code has sent it as a boolean and as the string "true".
 * @param {unknown} input
 * @param {string} key
 * @returns {boolean}
 */
export function flag(input, key) {
  if (typeof input !== "object" || input === null) return false;
  const value = /** @type {Record<string, unknown>} */ (input)[key];
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.toLowerCase() === "true";
}

/** The words that start transcription in a shell command (`inspected` is learned from them). */
export const TRANSCRIBING_COMMAND_WORDS = ["whisper", "transcrib"];

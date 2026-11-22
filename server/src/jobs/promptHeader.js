// The header of the first message of an edit and the helpers every message shares (docs/SPEC.md
// section 8, "Prompt"): the absolute paths, the video type, the check command, one MACHINE line
// and one LIMITS line, and the program and setup blocks. Pure: every fact comes in as a parameter.

import { KEEP_WORKING, OPENCODE2_PROGRAM } from "./promptTexts.js";

/** @typedef {import("../platform/machine.js").MachineFacts} MachineFacts */
/** @typedef {import("../agents/harness.js").Setup} Setup */
/** @typedef {import("../agents/harness.js").Harness} Harness */
/** @typedef {import("../../../src/lib/wire/channels.ts").VideoType} VideoType */

/**
 * What the CPU and GPU budget of the job is (docs/SPEC.md section 9).
 * @typedef {object} PromptLimits
 * @property {number} cpuCores Processor cores the job may use (`VE_CPU_CORES`).
 * @property {number} gpuTasks GPU tasks the job may run at once (`gpuSlotsPerEdit`).
 */

/**
 * The facts every message of a job is composed from. The server fills it once per launch.
 * @typedef {object} PromptContext
 * @property {string} mainFolder Absolute path of the video folder (the agent's working directory).
 * @property {string} channelFolder Absolute path of the channel directory.
 * @property {string} channelName The channel's name.
 * @property {string} toolkitFolder Absolute path of `<data dir>/toolkit/CLAUDE_VE_ALL`.
 * @property {string} python Absolute path of the toolkit's Python (`venv/bin/python` or
 *   `venv\Scripts\python.exe`), computed by the caller.
 * @property {VideoType} videoType The effective type of the video.
 * @property {string} brollFolder Absolute path of the B-roll folder.
 * @property {string} projectFolder Absolute path of `output/<video folder name>.hf`.
 * @property {string} checkCommand The command line that checks the project, for example
 *   `node <server>/src/timeline/checkCli.js "<project folder>"`.
 * @property {MachineFacts | null} machine This computer, or `null` for no MACHINE line.
 * @property {PromptLimits} limits
 * @property {Setup} setup What the job runs on; the Claude subscription gets no keep-working text.
 * @property {Harness} harness The program; OpenCode 2 gets its own block in the first message.
 */

/**
 * "Long" or "Short" for the header.
 * @param {VideoType} videoType
 * @returns {string}
 */
export function typeWord(videoType) {
  return videoType === "short" ? "Short" : "Long";
}

/**
 * The CHANNEL_STYLE heading label.
 * @param {VideoType} videoType
 * @returns {string}
 */
export function styleLabel(videoType) {
  return videoType === "short" ? "Short 9:16" : "Long 16:9";
}

/**
 * Removes blank lines around a user text without touching anything inside it.
 * @param {string} text
 * @returns {string}
 */
export function trimBlock(text) {
  return text.replace(/^[\r\n]+/u, "").trimEnd();
}

/**
 * The separator a path uses (backslash only for a Windows path that has no slash).
 * @param {string} path
 * @returns {string}
 */
export function separatorOf(path) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/**
 * `name` inside the folder `base`, written with the separator of `base`.
 * @param {string} base
 * @param {string} name
 * @returns {string}
 */
export function joinPath(base, name) {
  const sep = separatorOf(base);
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

/**
 * The folder that holds `path` (the toolkit folder's parent holds CLAUDE.md and MEMORY.md).
 * @param {string} path
 * @returns {string}
 */
export function parentOf(path) {
  const sep = separatorOf(path);
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf(sep);
  return at <= 0 ? sep : trimmed.slice(0, at);
}

/**
 * True when the server runs on Windows, told from its paths (a drive letter or a network share),
 * so the texts stay pure.
 * @param {PromptContext} ctx
 * @returns {boolean}
 */
export function isWindows(ctx) {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(ctx.python);
}

/**
 * A command line in the form the agent copies into its shell. On Windows the backslashes of the
 * paths become slashes: every Windows shell and program accepts them, and inside double quotes
 * they never need escaping (a trailing backslash before a quote breaks PowerShell arguments).
 * Elsewhere the line is unchanged.
 * @param {PromptContext} ctx
 * @param {string} line
 * @returns {string}
 */
export function shellLine(ctx, line) {
  return isWindows(ctx) ? line.replaceAll("\\", "/") : line;
}

/**
 * The command line that writes the project: `"<python>" "<toolkit>/ve.py" hf "<video folder>"`,
 * in the form of `shellLine`.
 * @param {PromptContext} ctx
 * @returns {string}
 */
export function hfCommandLine(ctx) {
  return shellLine(
    ctx,
    `"${ctx.python}" "${joinPath(ctx.toolkitFolder, "ve.py")}" hf "${ctx.mainFolder}"`,
  );
}

/**
 * The MACHINE line: operating system and version, processor and logical processors, memory,
 * graphics adapter. A part that is unknown is left out.
 * @param {MachineFacts} facts
 * @returns {string}
 */
export function machineLine(facts) {
  /** @type {string[]} */
  const parts = [facts.osVersion === null ? facts.os : `${facts.os} ${facts.osVersion}`];
  const cores =
    facts.logicalCores === null
      ? null
      : `${facts.logicalCores} logical processor${facts.logicalCores === 1 ? "" : "s"}`;
  const cpu = [facts.cpu === null ? null : `CPU ${facts.cpu}`, cores].filter((x) => x !== null);
  if (cpu.length > 0) parts.push(cpu.join(", "));
  if (facts.memoryGb !== null) parts.push(`memory ${facts.memoryGb} GB`);
  if (facts.gpu !== null) parts.push(`GPU ${facts.gpu}`);
  return `MACHINE: ${parts.join("; ")}`;
}

/**
 * A count that is at least 1, whole.
 * @param {number} n
 * @returns {number}
 */
const atLeastOne = (n) => (Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1);

/**
 * The LIMITS line, from the job's budget (docs/SPEC.md section 9).
 * @param {PromptLimits} limits
 * @returns {string}
 */
export function limitsLine(limits) {
  const cores = atLeastOne(limits.cpuCores);
  const tasks = atLeastOne(limits.gpuTasks);
  return `LIMITS: Use at most ${cores} processor ${cores === 1 ? "core" : "cores"} and ${tasks} GPU ${tasks === 1 ? "task" : "tasks"} at a time; the toolkit already obeys this through VE_CPU_CORES and the GPU slot files, so do not start heavy programs in parallel yourself.`;
}

/**
 * The header of the first message of an edit.
 * @param {PromptContext} ctx
 * @returns {string}
 */
export function headerBlock(ctx) {
  const lines = [
    `MAIN_FOLDER = ${ctx.mainFolder}`,
    `CHANNEL_FOLDER = ${ctx.channelFolder}`,
    `TOOLKIT_FOLDER = ${ctx.toolkitFolder}`,
    `PYTHON = ${ctx.python}`,
    `Channel Name: ${ctx.channelName}`,
    `VIDEO_TYPE = ${typeWord(ctx.videoType)}`,
    `BROLL_FOLDER = ${ctx.brollFolder}`,
    `PROJECT_FOLDER = ${ctx.projectFolder}`,
    `CHECK_COMMAND = ${shellLine(ctx, ctx.checkCommand)}`,
  ];
  if (ctx.machine !== null) lines.push(machineLine(ctx.machine));
  lines.push(limitsLine(ctx.limits));
  return lines.join("\n");
}

/**
 * The blocks that depend on the program and the setup, in the order they follow the VidAI
 * paragraph: the OpenCode 2 block, then the keep-working paragraph.
 * @param {Setup} setup
 * @param {Harness} harness
 * @returns {string[]}
 */
export function programBlocks(setup, harness) {
  /** @type {string[]} */
  const blocks = [];
  if (harness === "opencode2") blocks.push(OPENCODE2_PROGRAM);
  if (setup !== "claudeSubscription") blocks.push(KEEP_WORKING);
  return blocks;
}

/**
 * A follow-up message for a session that goes on: on the Claude subscription the body as it is;
 * on any other setup the body followed by the keep-working paragraph.
 * @param {string} body
 * @param {Setup} setup
 * @returns {string}
 */
export function followUpOn(body, setup) {
  return setup === "claudeSubscription" ? body : `${body}\n\n${KEEP_WORKING}`;
}

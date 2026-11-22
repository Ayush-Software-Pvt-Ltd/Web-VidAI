// `hyperframes lint` as a check of a project (docs/SPEC.md section 10: "`hyperframes lint` must also
// report no errors"). Runs the pinned CLI of the `hyperframes` package with Node, never a global
// install: `node <package>/bin/hyperframes.mjs lint <project> --json`, with telemetry and the
// update check switched off (so it uses no network) and a time limit.
//
// What its JSON looks like (HyperFrames 0.9.80, recorded in
// `server/test/support/fixtures/hyperframes-lint/`):
//   { "ok": false, "errorCount": 3, "warningCount": 0, "infoCount": 0, "filesScanned": 2,
//     "findings": [ { "code": "missing_local_asset", "severity": "error" | "warning" | "info",
//                     "file": "<absolute path>", "line": 7, "column": 47,   // line and column are optional
//                     "message": "...", "fixHint": "...", "elementId": "root", "snippet": "..." } ],
//     "_meta": { ... } }
// It exits 1 when there are errors, 0 otherwise. A call that cannot run at all (a folder that is
// not there) answers `{ "ok": false, "error": { "code": "runtime_error", "message": "..." }, "findings": [] }`.
//
// Decisions: warnings and infos are not errors and are dropped. When the CLI cannot be run (not
// installed, time limit, output that is not JSON, `error` in the answer) there is no verdict: the
// result has `problem` set and no errors, so a broken tool never makes an agent chase violations
// that do not exist; the caller logs it.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { runHelper } from "../platform/process.js";

/** The longest the CLI may run. */
export const LINT_TIMEOUT_MS = 60_000;

/**
 * @typedef {object} LintResult
 * @property {string[]} errors One sentence per error finding.
 * @property {string | null} problem Why there is no verdict (the CLI could not run), else null.
 */

/**
 * Finds the CLI inside the installed `hyperframes` package.
 * @returns {string | null}
 */
export function findHyperframesCli() {
  try {
    const manifest = createRequire(import.meta.url).resolve("hyperframes/package.json");
    const cli = path.join(path.dirname(manifest), "bin", "hyperframes.mjs");
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file An absolute path from the CLI's answer.
 * @param {string[]} roots The project folder as given and as resolved.
 * @returns {string} The path relative to the project, `/` separators, when it is inside.
 */
function relativeTo(file, roots) {
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }
  return file;
}

/**
 * Reads the CLI's JSON answer.
 * @param {string} stdout
 * @param {string} projectDir
 * @returns {LintResult}
 */
export function parseLintOutput(stdout, projectDir) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { errors: [], problem: "its answer was not JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { errors: [], problem: "its answer was not what was expected" };
  }
  const answer = /** @type {Record<string, unknown>} */ (value);
  const failure = answer.error;
  if (typeof failure === "object" && failure !== null) {
    const message = /** @type {{ message?: unknown }} */ (failure).message;
    return { errors: [], problem: typeof message === "string" ? message : "it reported an error" };
  }
  if (!Array.isArray(answer.findings)) {
    return { errors: [], problem: "its answer had no findings list" };
  }
  let real = projectDir;
  try {
    real = fs.realpathSync(projectDir);
  } catch {
    // The folder is gone; the names stay as the CLI wrote them.
  }
  /** @type {string[]} */
  const errors = [];
  for (const entry of answer.findings) {
    const finding = /** @type {Record<string, unknown>} */ (entry ?? {});
    if (finding.severity !== "error") continue;
    const message = typeof finding.message === "string" ? finding.message.trim() : "";
    const file =
      typeof finding.file === "string" ? relativeTo(finding.file, [projectDir, real]) : "";
    const line = typeof finding.line === "number" ? ` line ${finding.line}` : "";
    const hint = typeof finding.fixHint === "string" ? ` ${finding.fixHint.trim()}` : "";
    const where = file === "" ? "" : `${file}${line}: `;
    errors.push(`HyperFrames lint, ${where}${message}${hint}`.trim());
  }
  return { errors, problem: null };
}

/**
 * @typedef {object} LintOptions
 * @property {string | null} [cli] The CLI script (default: the installed package's); null: not installed.
 * @property {string} [node] The Node program that runs it (default: this one).
 * @property {number} [timeoutMs]
 * @property {typeof runHelper} [run] Test seam.
 * @property {Readonly<Record<string, string | undefined>>} [env] Base environment (default: this process's).
 */

/**
 * @param {LintOptions} [options]
 * @returns {(projectDir: string) => Promise<LintResult>}
 */
export function createLint({
  cli = findHyperframesCli(),
  node = process.execPath,
  timeoutMs = LINT_TIMEOUT_MS,
  run = runHelper,
  env = process.env,
} = {}) {
  return async function lint(projectDir) {
    if (cli === null) return { errors: [], problem: "the hyperframes package is not installed" };
    let result;
    try {
      result = await run({
        command: node,
        args: [cli, "lint", projectDir, "--json"],
        cwd: projectDir,
        env: { ...env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1" },
        timeoutMs,
      });
    } catch (error) {
      return {
        errors: [],
        problem: `it could not be started (${error instanceof Error ? error.message : error})`,
      };
    }
    if (result.timedOut) return { errors: [], problem: "it did not finish in time" };
    const parsed = parseLintOutput(result.stdout, projectDir);
    return parsed.problem === null
      ? parsed
      : { ...parsed, problem: `The HyperFrames lint did not give an answer: ${parsed.problem}.` };
  };
}

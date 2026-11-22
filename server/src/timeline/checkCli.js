// The check the editing agent runs itself (docs/SPEC.md section 10):
//
//   node server/src/timeline/checkCli.js <project folder>
//
// Prints "The project is fine." and exits 0, or prints each violation (VidAI's profile, then
// `hyperframes lint` errors) on its own line and exits 1. Exit 2 is a wrong call (no folder, too
// many arguments, a folder that is not there). It works from any working directory: every path it
// uses is resolved from this file or from the argument.
//
// `VIDAI_HYPERFRAMES_BIN` (a script run with Node) replaces the pinned CLI; tests use it. When lint
// cannot run at all the profile verdict still counts and a note goes to the error output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectCheck } from "./check.js";
import { createLint, findHyperframesCli } from "./lint.js";

/**
 * @param {string[]} args The program's arguments after the script name.
 * @param {{ env?: Readonly<Record<string, string | undefined>>, write?: (line: string) => void, writeError?: (line: string) => void, lint?: (projectDir: string) => Promise<import("./lint.js").LintResult> }} [io]
 * @returns {Promise<number>} The exit code.
 */
export async function runCheckCli(args, io = {}) {
  const env = io.env ?? process.env;
  const write = io.write ?? ((line) => void process.stdout.write(`${line}\n`));
  const writeError = io.writeError ?? ((line) => void process.stderr.write(`${line}\n`));
  if (args.length !== 1 || !args[0]) {
    writeError("Usage: node checkCli.js <project folder>");
    return 2;
  }
  const projectDir = path.resolve(args[0]);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    writeError(`The folder ${projectDir} does not exist.`);
    return 2;
  }
  const lint =
    io.lint ?? createLint({ cli: env.VIDAI_HYPERFRAMES_BIN || findHyperframesCli(), env });
  const { violations, lintProblem } = await createProjectCheck({ lint })(projectDir);
  if (lintProblem !== null) writeError(`Note: ${lintProblem}`);
  if (violations.length === 0) {
    write("The project is fine.");
    return 0;
  }
  for (const violation of violations) write(violation.replace(/\s*\n\s*/g, " "));
  return 1;
}

/** Whether this file is the program that was started (also through a symbolic link). */
function isMainScript() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainScript()) {
  runCheckCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`The check failed: ${error instanceof Error ? error.message : error}\n`);
      process.exit(2);
    },
  );
}

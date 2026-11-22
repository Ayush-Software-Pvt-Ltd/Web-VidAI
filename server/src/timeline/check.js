// The whole check of a project (docs/SPEC.md section 10): VidAI's profile (rules 1 to 10) plus
// `hyperframes lint` without errors. Used by the job manager (`api.check`) and by the command-line
// program the agent runs itself (`checkCli.js`).

import { checkProject } from "./profile.js";
import { createLint } from "./lint.js";

/**
 * @typedef {object} CheckResult
 * @property {string[]} violations One sentence each: the profile first, then lint errors.
 * @property {string | null} lintProblem Why lint gave no verdict, else null (never a violation).
 */

/**
 * @param {{ lint?: (projectDir: string) => Promise<import("./lint.js").LintResult> }} [deps]
 * @returns {(projectDir: string) => Promise<CheckResult>}
 */
export function createProjectCheck({ lint = createLint() } = {}) {
  return async function check(projectDir) {
    const profile = await checkProject(projectDir);
    const linted = await lint(projectDir);
    return {
      violations: [...profile.map((violation) => violation.message), ...linted.errors],
      lintProblem: linted.problem,
    };
  };
}

// The agent program that does an edit (docs/SPEC.md section 5, "Harness, program and model"):
// Claude Code or OpenCode 2, as the selected setup says.
//
// `forNewJob` is the one place that decides the program of a new job. `AgentProcess` is what
// the job engine needs from a running agent, whichever program it is. Both speak the same
// event vocabulary (`SessionEvent` in `claude/session.js`; OpenCode 2's events are translated
// into it), so only starting them differs.

/** @typedef {"claudeSubscription" | "opencodeGo" | "anthropicApi" | "openaiApi"} Setup */
/** @typedef {"claudeCode" | "opencode2"} Harness */

/**
 * What the job engine does with a running agent. Events arrive through the callback given
 * when it was started.
 *
 * @typedef {object} AgentProcess
 * @property {number} pid The process (and process group) whose tree belongs to the job.
 * @property {(text: string) => void} sendUser Sends one user message; throws when the agent
 *   can no longer take input.
 * @property {() => string} interrupt Interrupts the running turn; the returned id comes back
 *   in a `controlResponse` event. Throws when the agent can no longer take input.
 * @property {() => void} close Lets the agent end: Claude Code exits when its input closes
 *   while idle, the OpenCode server is told to end. Its `exited` event follows. Idempotent.
 */

/** @type {Record<Setup, Harness>} */
const PROGRAM = {
  claudeSubscription: "claudeCode",
  anthropicApi: "claudeCode",
  opencodeGo: "opencode2",
  openaiApi: "opencode2",
};

/** @type {readonly Setup[]} */
export const SETUPS = ["claudeSubscription", "opencodeGo", "anthropicApi", "openaiApi"];

/**
 * THE decision of which program does a new job: the one of the selected setup.
 * @param {Setup} setup
 * @returns {Harness}
 */
export function forNewJob(setup) {
  return PROGRAM[setup];
}

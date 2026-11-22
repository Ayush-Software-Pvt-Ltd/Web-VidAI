// The steps of Prepare and which of them block what (docs/SPEC.md section 7).
//
// Decision (the SPEC says only "edits cannot start until it has succeeded"): a step that every
// edit needs blocks `editing`; a step that only rendering needs blocks `rendering`.
//
//  - editing: Python, the environment, the packages (every toolkit command), ffmpeg and ffprobe
//    (every build), the toolkit's own check, the speech model (every edit transcribes; a failed
//    download shown on the System page is better than an edit that fails half way).
//  - rendering only: the renderer's browser and the test render. An edit produces the project
//    (`ve.py hf`) and never renders, so people can edit while the browser could not be fetched.

/** @typedef {import("../../../src/lib/wire/system.ts").PrepareStepId} PrepareStepId */
/** @typedef {import("../../../src/lib/wire/system.ts").PrepareBlocks} PrepareBlocks */

/**
 * @typedef {object} StepDefinition
 * @property {PrepareStepId} id
 * @property {string} label
 * @property {PrepareBlocks} blocks
 * @property {readonly PrepareStepId[]} needs Steps that must be `done` first; otherwise this one
 *   is not run (it stays `pending` with a message that names what it waits for).
 */

/** @type {readonly StepDefinition[]} */
export const STEPS = [
  { id: "python", label: "Python", blocks: "editing", needs: [] },
  { id: "venv", label: "Python environment", blocks: "editing", needs: ["python"] },
  { id: "packages", label: "Python packages", blocks: "editing", needs: ["venv"] },
  { id: "ffmpeg", label: "ffmpeg and ffprobe", blocks: "editing", needs: [] },
  { id: "doctor", label: "Toolkit check", blocks: "editing", needs: ["packages", "ffmpeg"] },
  { id: "speech", label: "Speech model", blocks: "editing", needs: ["packages"] },
  { id: "browser", label: "Renderer browser", blocks: "rendering", needs: [] },
  { id: "render", label: "Test render", blocks: "rendering", needs: ["browser", "ffmpeg"] },
];

/**
 * @param {PrepareStepId} id
 * @returns {StepDefinition}
 */
export function stepDefinition(id) {
  const found = STEPS.find((step) => step.id === id);
  if (!found) throw new Error(`Unknown Prepare step ${id}`);
  return found;
}

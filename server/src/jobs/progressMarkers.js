// Progress markers (docs/SPEC-desktop.md section 6 "Progress", evidence 1): the agent writes
// `[VIDAI_PROGRESS <name>]` on a line by itself in a normal message of the main session each time
// a milestone is finished. The prompt lists the names (`markerInstructions`) and the activity log
// shows such lines as compact status entries (`markerRules`, the `MarkerRules` of `log.js`).

import { milestoneOf, modelOf } from "./progressModels.js";

/** What a marker line looks like: `[VIDAI_PROGRESS transcribed]`. */
export const MARKER_TAG = "VIDAI_PROGRESS";

/**
 * The prompt lines that list the markers of a kind's model, one line each with what counts as
 * finished. The paragraph around them is `markerInstructions`.
 * @param {import("./progressModels.js").AgentKind} kind
 * @returns {string}
 */
export function markerLines(kind) {
  return modelOf(kind)
    .steps.map((s) => {
      const m = milestoneOf(s.milestone);
      return `[${MARKER_TAG} ${s.milestone}] - ${m === null ? "" : m.hint}`;
    })
    .join("\n");
}

/**
 * The "Progress markers" paragraph of the first message of a job of `kind`.
 * @param {import("./progressModels.js").AgentKind} kind
 * @returns {string}
 */
export function markerInstructions(kind) {
  return `Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.\n${markerLines(kind)}`;
}

/** Characters a marker line may hold besides markers: Markdown emphasis, code, quote, bullet. */
const FILLER = /^[\s*_`>-]*$/u;

/**
 * The marker names of a line that holds nothing else (besides spaces and `*`, `_`, `` ` ``, `>`,
 * `-`), or `null` when the line is prose.
 * @param {string} line
 * @returns {string[] | null}
 */
function lineMarkers(line) {
  /** @type {string[]} */
  const names = [];
  let rest = line;
  for (let open = rest.indexOf("["); open !== -1; open = rest.indexOf("[")) {
    if (!FILLER.test(rest.slice(0, open))) return null;
    const after = rest.slice(open + 1);
    const close = after.indexOf("]");
    if (close === -1) return null;
    const inner = after.slice(0, close).trim();
    const split = /^(\S+)\s+([\s\S]+)$/u.exec(inner);
    if (split === null || split[1].toUpperCase() !== MARKER_TAG) return null;
    const name = split[2].trim().toLowerCase().replaceAll("-", "_");
    if (!/^[a-z0-9_]+$/u.test(name)) return null;
    names.push(name);
    rest = after.slice(close + 1);
  }
  return names.length > 0 && FILLER.test(rest) ? names : null;
}

/**
 * Splits an agent's text into what is left after removing marker lines, and the marker names
 * found (lower case, `-` read as `_`), in order. A marker line holds only markers, optionally
 * wrapped in Markdown emphasis or code; a marker inside a sentence is prose, not a marker.
 * @param {string} text
 * @returns {{ text: string, markers: string[] }}
 */
export function splitMarkers(text) {
  /** @type {string[]} */
  const markers = [];
  /** @type {string[]} */
  const kept = [];
  for (const line of text.split(/\r?\n/u)) {
    const found = lineMarkers(line);
    if (found === null) kept.push(line);
    else markers.push(...found);
  }
  if (markers.length === 0) return { text, markers };
  return { text: kept.join("\n").trim(), markers };
}

/**
 * The activity log line of a marker: the milestone's done text, or the raw name for one VidAI
 * does not know.
 * @param {string} name
 * @returns {string}
 */
export function markerLogLine(name) {
  const m = milestoneOf(name);
  return m === null ? `Progress: ${name}` : m.doneText;
}

/**
 * The rules `createDescriber` of `log.js` takes (`MarkerRules`).
 * @type {import("./logDescribe.js").MarkerRules}
 */
export const markerRules = Object.freeze({ split: splitMarkers, logLine: markerLogLine });

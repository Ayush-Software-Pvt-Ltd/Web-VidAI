// The sentence for a failed render (docs/SPEC.md section 12). The renderer ends with code 1 and
// prints, after its progress,
//
//   @hf-diagnostic {"version":1,"operation":"render","code":"VIDEO_SOURCE_UNRENDERABLE"}
//   ✗  Render failed
//      Video extraction failed for 3 source(s) [VIDEO_SOURCE_UNRENDERABLE; source_missing=3] (assets/media/aroll.mp4)
//      The video file is not there. Check the `src` of the <video> against the project folder.
//      Try --docker for containerized rendering
//
// A known code gets a sentence made from its detail; any other failure shows the last lines.

/** The most characters of renderer output shown in a sentence. */
const MAX_DETAIL = 400;

// eslint-disable-next-line no-control-regex -- the escape character starts ANSI sequences
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

/** @param {string} line @returns {string} The line without colour codes, trimmed. */
export function cleanLine(line) {
  return line.replace(ANSI, "").trim();
}

/** @param {string} text @returns {string} At most `MAX_DETAIL` characters, cut at a space. */
function shorten(text) {
  if (text.length <= MAX_DETAIL) return text;
  const cut = text.slice(0, MAX_DETAIL);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_DETAIL / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/** @param {string} text @returns {string} The text ending in one full stop. */
function sentence(text) {
  const trimmed = text.trim().replace(/[.:;,\s]+$/u, "");
  return `${trimmed}.`;
}

/**
 * The code of the `@hf-diagnostic` line, if the output has one (the last wins).
 * @param {readonly string[]} lines
 * @returns {string | null}
 */
export function diagnosticCode(lines) {
  let code = null;
  for (const raw of lines) {
    const match = /@hf-diagnostic\s+(\{.*\})/u.exec(cleanLine(raw));
    if (match === null) continue;
    try {
      const value = /** @type {unknown} */ (JSON.parse(match[1] ?? ""));
      const found = /** @type {{ code?: unknown }} */ (value).code;
      if (typeof found === "string") code = found;
    } catch {
      // A damaged line says nothing.
    }
  }
  return code;
}

/**
 * The lines the renderer printed under its `Render failed` heading (without the docker hint).
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
export function failureDetail(lines) {
  const cleaned = lines.map(cleanLine);
  const at = cleaned.findLastIndex((line) => /Render failed/u.test(line));
  if (at === -1) return [];
  return cleaned
    .slice(at + 1)
    .filter((line) => line !== "" && !/^Try --docker/u.test(line) && !line.includes("@hf-"));
}

/**
 * The sources named in the parentheses at the end of a VIDEO_SOURCE_UNRENDERABLE detail.
 * @param {string} detail
 * @returns {string | null}
 */
function sourcesOf(detail) {
  const found = /\(([^()]*)\)\s*$/u.exec(detail)?.[1]?.trim();
  return found ? found : null;
}

/**
 * The graphic and its error out of a SUB_TIMELINE_SCRIPT_FAILURE detail such as
 * `- sub_timeline_script_failure: ... (still unregistered: mg0) (runtime-error:mg0 ReferenceError: x is not defined). Fix ...`
 * or `(runtime-error:Error: boom [thrown at: hyperframes-composition://body:3:46])`.
 * @param {string} detail
 * @returns {{ graphic: string | null, error: string | null }}
 */
function graphicOf(detail) {
  const graphic = /still unregistered:\s*([^)]+)\)/u.exec(detail)?.[1]?.trim() ?? null;
  const raw = /\(runtime-error:([^)]*?)(?:\s*\[thrown at:[^\]]*\])?\)/u.exec(detail)?.[1]?.trim();
  let error = raw ?? null;
  if (error !== null && graphic !== null && error.startsWith(`${graphic} `)) {
    error = error.slice(graphic.length + 1);
  }
  return { graphic, error: error === "" ? null : error };
}

/**
 * @param {readonly string[]} lines The renderer's output lines (without its progress lines).
 * @param {number | null} [exitCode]
 * @returns {string} A full sentence for the user.
 */
export function failureMessage(lines, exitCode = null) {
  const code = diagnosticCode(lines);
  const detail = failureDetail(lines);
  const first = detail[0] ?? "";
  if (code === "VIDEO_SOURCE_UNRENDERABLE" || code === "VIDEO_EXTRACTION_FAILED") {
    const sources = sourcesOf(first);
    if (/source_missing/u.test(first) || code === "VIDEO_SOURCE_UNRENDERABLE") {
      return sentence(
        `A source file is missing: ${sources ?? "see the log"}. Check that the original files ` +
          "the project links to are still where they were",
      );
    }
    return sentence(
      `A source video cannot be read: ${sources ?? shorten(first)}. Check that the file is not damaged`,
    );
  }
  if (code === "SUB_TIMELINE_SCRIPT_FAILURE") {
    const { graphic, error } = graphicOf(detail.join(" "));
    return sentence(
      `The graphic ${graphic ?? "(unknown)"} has an error: ${error ?? shorten(first)}`,
    );
  }
  if (code === "PLAN_TOO_LARGE" || code === "COMPOSITION_TOO_LARGE") {
    return sentence("The video is too long or too complex for the renderer to plan in one piece");
  }
  if (code === "RENDER_TOO_SLOW" || code === "RENDER_STAGE_STALLED") {
    return sentence(
      "The renderer stopped making progress, usually because the server is overloaded. Try again later",
    );
  }
  if (code === "PAGE_NEVER_READY") {
    return sentence(
      "The project's page never became ready in the renderer's browser, so it has an error that stops it from loading",
    );
  }
  if (code === "OUTPUT_DIMENSIONS_MISMATCH") {
    return sentence("The rendered video does not have the size of the project");
  }
  const text = shorten(detail.slice(0, 3).join(" ") || tailText(lines));
  const why = text === "" ? "it gave no reason" : text;
  const ending = exitCode === null ? "" : ` (exit code ${exitCode})`;
  return sentence(`The renderer failed${ending}: ${why}`);
}

/**
 * The last useful lines of the output, for a failure the renderer did not explain.
 * @param {readonly string[]} lines
 * @returns {string}
 */
function tailText(lines) {
  const useful = lines
    .map(cleanLine)
    .filter((line) => line !== "" && !line.startsWith("[INFO]") && !line.includes("@hf-"));
  return useful.slice(-3).join(" ");
}

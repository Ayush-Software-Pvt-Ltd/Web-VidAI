import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanLine,
  diagnosticCode,
  failureDetail,
  failureMessage,
} from "../../src/render/diagnostics.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "support",
  "fixtures",
  "hyperframes-render",
);
/** @param {string} name */
const fixture = (name) => fs.readFileSync(path.join(fixtures, `${name}.log`), "utf8").split("\n");

/** @param {string} code @param {string[]} detail */
const failing = (code, detail) => [
  `@hf-diagnostic {"version":1,"operation":"render","code":"${code}"}`,
  "",
  "✗  Render failed",
  "",
  ...detail.map((d) => `   ${d}`),
];

describe("failure sentences", () => {
  it("names the missing source file from the real output", () => {
    assert.equal(
      failureMessage(fixture("fail-source"), 1),
      "A source file is missing: assets/media/aroll.mp4. Check that the original files the project links to are still where they were.",
    );
  });

  it("names the graphic and its error from the real output", () => {
    const text = failureMessage(fixture("fail-graphic"), 1);
    assert.match(
      text,
      /^The graphic mg0 has an error: ReferenceError: nonexistentFunction is not defined\.$/u,
    );
  });

  it("reads a thrown error with its location", () => {
    const text = failureMessage(
      failing("SUB_TIMELINE_SCRIPT_FAILURE", [
        "- sub_timeline_script_failure: A composition script threw (still unregistered: title) (runtime-error:Error: boom [thrown at: hyperframes-composition://body:3:46]). Fix it.",
      ]),
    );
    assert.equal(text, "The graphic title has an error: Error: boom.");
  });

  const fixed = /** @type {const} */ ([
    ["PLAN_TOO_LARGE", /too long or too complex/u],
    ["COMPOSITION_TOO_LARGE", /too long or too complex/u],
    ["RENDER_TOO_SLOW", /stopped making progress/u],
    ["RENDER_STAGE_STALLED", /stopped making progress/u],
    ["PAGE_NEVER_READY", /never became ready/u],
    ["OUTPUT_DIMENSIONS_MISMATCH", /does not have the size/u],
  ]);
  for (const [code, pattern] of fixed) {
    it(`has a sentence for ${code}`, () => {
      assert.match(failureMessage(failing(code, ["some detail"]), 1), pattern);
    });
  }

  it("says a source cannot be read for an extraction failure that is not a missing file", () => {
    const text = failureMessage(
      failing("VIDEO_EXTRACTION_FAILED", ["Extraction failed [decode_error=1] (assets/a.mp4)"]),
    );
    assert.equal(
      text,
      "A source video cannot be read: assets/a.mp4. Check that the file is not damaged.",
    );
  });

  it("uses the last lines when there is no code", () => {
    const text = failureMessage(["[INFO] started", "Error: it broke", "  at x"], 2);
    assert.equal(text, "The renderer failed (exit code 2): Error: it broke at x.");
  });

  it("uses the detail under the heading when there is a heading but an unknown code", () => {
    const text = failureMessage(
      failing("SOMETHING_NEW", ["It went wrong.", "Try --docker for containerized rendering"]),
      1,
    );
    assert.equal(text, "The renderer failed (exit code 1): It went wrong.");
  });

  it("copes with no output at all and shortens long text", () => {
    assert.equal(failureMessage([], 1), "The renderer failed (exit code 1): it gave no reason.");
    const long = failureMessage(["x ".repeat(400)], null);
    assert.ok(long.length < 450);
    assert.ok(long.endsWith(".") && long.length > 100);
  });
});

describe("reading the output", () => {
  it("strips colour codes", () => {
    assert.equal(cleanLine("\u001b[31m  red \u001b[0m"), "red");
  });
  it("finds the last diagnostic code", () => {
    assert.equal(
      diagnosticCode(['@hf-diagnostic {"code":"A"}', '@hf-diagnostic {"code":"B"}']),
      "B",
    );
    assert.equal(diagnosticCode(["@hf-diagnostic {broken"]), null);
    assert.equal(diagnosticCode([]), null);
  });
  it("takes the detail under the last heading and drops the docker hint", () => {
    const lines = ["Render failed", "old", "Render failed", "", "one", "Try --docker for x", "two"];
    assert.deepEqual(failureDetail(lines), ["one", "two"]);
    assert.deepEqual(failureDetail(["nothing"]), []);
  });
});

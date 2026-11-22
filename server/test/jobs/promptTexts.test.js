// What no text may say: the old review software, a review file, rendering by the agent, and the
// character that ESLint rejects (docs/SPEC.md section 8 "Prompt", section 10 rule 11).

import assert from "node:assert/strict";
import test from "node:test";
import { composeEdit } from "../../src/jobs/promptEdit.js";
import {
  composeContinue,
  composeProfileFix,
  composeReEdit,
} from "../../src/jobs/promptFollowUp.js";
import { composeTimelineEdit } from "../../src/jobs/promptTimeline.js";
import * as texts from "../../src/jobs/promptTexts.js";
import { editInput, timelineInput } from "./promptSupport.js";

/** The em dash and the horizontal bar, built from code points so this file has neither. */
const DASHES = new RegExp(`[${String.fromCodePoint(0x2014)}${String.fromCodePoint(0x2015)}]`, "u");

/** Every message the composition can produce, for every setup and program. */
function everyMessage() {
  /** @type {string[]} */
  const out = [];
  const pairs = /** @type {const} */ ([
    ["claudeSubscription", "claudeCode"],
    ["anthropicApi", "claudeCode"],
    ["opencodeGo", "opencode2"],
    ["openaiApi", "opencode2"],
  ]);
  for (const [setup, harness] of pairs) {
    const edit = { ...editInput(), setup, harness };
    const base = { setup, harness, newSession: edit, hasProject: true };
    const resumed = { ...base, newSession: null };
    out.push(composeEdit(edit));
    for (const afterFailure of /** @type {const} */ ([null, "edit", "reEdit", "timelineEdit"])) {
      out.push(
        composeContinue({ ...resumed, afterFailure }),
        composeContinue({ ...base, afterFailure }),
      );
    }
    out.push(
      composeReEdit({ ...resumed, changes: "Shorter." }),
      composeReEdit({ ...base, changes: "Shorter." }),
    );
    out.push(composeProfileFix(["Clip a1 is wrong."], 1, { setup }));
    out.push(composeProfileFix(["Clip a1 is wrong."], 2, { setup }));
    const timeline = timelineInput();
    out.push(
      composeTimelineEdit({ ...timeline, ...resumed }),
      composeTimelineEdit({ ...timeline, ...base }),
    );
  }
  return out;
}

test("no message mentions Final Cut, Premiere, a review file or a review project", () => {
  for (const message of everyMessage()) {
    assert.doesNotMatch(
      message,
      /final cut|premiere|fcpxml|prproj|review file|review project|REVIEW_OUTPUT_SOFTWARE|MAIN_AROLL_ROTATION/iu,
    );
  }
});

test("rendering is mentioned only to forbid it", () => {
  for (const message of everyMessage()) {
    for (const line of message.split("\n")) {
      if (/render/iu.test(line)) {
        assert.match(
          line,
          /never render|Never render|renders it from the project later|renders it from the project/u,
          line,
        );
      }
    }
  }
});

test("no text contains the em dash or its look-alikes", () => {
  for (const message of everyMessage()) assert.doesNotMatch(message, DASHES);
  for (const [name, value] of Object.entries(texts)) {
    const flat = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof value === "function") continue;
    assert.doesNotMatch(flat, DASHES, name);
  }
});

test("the completion marker is the one the server looks for", () => {
  assert.equal(texts.COMPLETION_MARKER, "[OUTPUT COMPLETED]");
  assert.equal(texts.PROFILE_FIX_ATTEMPTS, 2);
});

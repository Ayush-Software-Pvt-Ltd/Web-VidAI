// Continue, Re-Edit, the fallback of a lost session and the project fix (docs/SPEC.md section 8).

import assert from "node:assert/strict";
import test from "node:test";
import { markerInstructions } from "../../src/jobs/progressMarkers.js";
import { composeEdit } from "../../src/jobs/promptEdit.js";
import {
  composeContinue,
  composeProfileFix,
  composeReEdit,
} from "../../src/jobs/promptFollowUp.js";
import { KEEP_WORKING } from "../../src/jobs/promptTexts.js";
import { editInput } from "./promptSupport.js";

/** @type {import("../../src/jobs/promptFollowUp.js").FollowUpBase} */
const resumed = {
  setup: "claudeSubscription",
  harness: "claudeCode",
  newSession: null,
  hasProject: true,
};

const CONTINUE_MARKERS =
  "Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, also for steps that finished before the pause and were not marked yet.";

test("continue messages, exact text", () => {
  const start =
    "Continue the video edit from where it was paused. Background tasks that were running were stopped, so check what finished and redo what did not. Work until the project in PROJECT_FOLDER is complete and passes CHECK_COMMAND.";
  assert.equal(
    composeContinue({ ...resumed, afterFailure: null }),
    `${start}\n\n${CONTINUE_MARKERS}`,
  );
  assert.equal(
    composeContinue({ ...resumed, afterFailure: "edit" }),
    `${start} The last attempt ended without a project in PROJECT_FOLDER that passes CHECK_COMMAND.\n\n${CONTINUE_MARKERS}`,
  );
  for (const kind of /** @type {const} */ (["reEdit", "timelineEdit"])) {
    assert.ok(
      composeContinue({ ...resumed, afterFailure: kind }).endsWith(
        `The last attempt ended without a changed project in PROJECT_FOLDER that passes CHECK_COMMAND.\n\n${CONTINUE_MARKERS}`,
      ),
    );
  }
});

test("in the OpenCode 2 program a pause stopped commands and sub-agents, not background tasks", () => {
  const text = composeContinue({
    ...resumed,
    harness: "opencode2",
    setup: "opencodeGo",
    afterFailure: "edit",
  });
  assert.ok(
    text.startsWith(
      "Continue the video edit from where it was paused. The commands and sub-agents that were running were stopped, so check what finished and redo what did not.",
    ),
  );
  assert.ok(!text.includes("Background tasks"));
  assert.ok(text.endsWith(`\n\n${KEEP_WORKING}`));
  // Claude Code with an API keeps its wording and gets the paragraph.
  const api = composeContinue({ ...resumed, setup: "anthropicApi", afterFailure: null });
  assert.ok(api.includes("Background tasks that were running were stopped"));
  assert.ok(api.endsWith(KEEP_WORKING));
});

test("the re-edit message, exact text", () => {
  assert.equal(
    composeReEdit({ ...resumed, changes: "\nMake the intro shorter.\nRemove the cat.\n" }),
    `RE-EDIT REQUEST. I reviewed the edit and want these changes:

Make the intro shorter.
Remove the cat.

Apply these changes and keep everything else as it is. Update the project in PROJECT_FOLDER in place (keep the ids of the clips that stay, and do not make a second project folder), update the thumbnails and meta.txt only if the changes affect them, add the re-edit to info.txt, and run CHECK_COMMAND until it reports no errors. Never render a video file. Write [OUTPUT COMPLETED] when done.

Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.
[VIDAI_PROGRESS changes_applied] - the requested changes are made
[VIDAI_PROGRESS project_saved] - the project is saved in the output folder`,
  );
});

test("a follow-up on an API setup ends with the keep-working paragraph, the subscription does not", () => {
  const body = composeReEdit({ ...resumed, changes: "Cut 2s." });
  assert.ok(!body.includes(KEEP_WORKING));
  const api = composeReEdit({
    ...resumed,
    setup: "openaiApi",
    harness: "opencode2",
    changes: "Cut 2s.",
  });
  assert.equal(api, `${body}\n\n${KEEP_WORKING}`);
});

test("a lost session gets the full instructions, the earlier-work paragraph, then the follow-up", () => {
  const edit = editInput();
  const text = composeReEdit({ ...resumed, newSession: edit, changes: "Cut 2s." });
  const plain = composeReEdit({ ...resumed, changes: "Cut 2s." });
  assert.equal(
    text,
    `${composeEdit(edit)}\n\nThis video was already edited in an earlier session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, and the current project is in PROJECT_FOLDER. Build on that work instead of starting over.\n\n${plain}`,
  );
  const noProject = composeContinue({
    ...resumed,
    newSession: edit,
    hasProject: false,
    afterFailure: null,
  });
  assert.ok(
    noProject.includes(
      "This video was already worked on in an earlier session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, but there is no project yet. Reuse the work that is there instead of starting over.",
    ),
  );
  assert.ok(noProject.startsWith(composeEdit(edit)));
});

test("the fallback carries the keep-working paragraph once, inside the first message", () => {
  const edit = {
    ...editInput(),
    setup: /** @type {const} */ ("opencodeGo"),
    harness: /** @type {const} */ ("opencode2"),
  };
  const text = composeContinue({
    setup: "opencodeGo",
    harness: "opencode2",
    newSession: edit,
    hasProject: true,
    afterFailure: null,
  });
  assert.equal(text.split(KEEP_WORKING).length - 1, 1);
  assert.equal(text.split("OPENCODE:").length - 1, 1);
  assert.equal(text.split("MAIN_FOLDER = ").length - 1, 1);
  // A fallback on the subscription has none.
  const subscription = composeContinue({ ...resumed, newSession: editInput(), afterFailure: null });
  assert.ok(!subscription.includes(KEEP_WORKING));
  // The follow-up part of the fallback has no header of its own.
  assert.ok(!composeContinue({ ...resumed, afterFailure: null }).includes("MAIN_FOLDER = "));
});

test("the project fix lists the errors and asks for the marker again", () => {
  assert.equal(
    composeProfileFix(
      ["Clip a3 overlaps clip a4 on track 0.", "Clip g1 has no data-vidai-label."],
      1,
    ),
    `The project in PROJECT_FOLDER does not pass CHECK_COMMAND (request 1 of 2 to fix it).
Errors:
- Clip a3 overlaps clip a4 on track 0.
- Clip g1 has no data-vidai-label.

Fix every error in the project files and keep everything else as it is. Never render a video file. Run CHECK_COMMAND again until it reports no errors, then write [OUTPUT COMPLETED] again.`,
  );
});

test("the second project fix says it is the last, a long list is cut, an API setup keeps working", () => {
  const many = Array.from({ length: 45 }, (_, i) => `Error number ${i + 1}.`);
  const second = composeProfileFix(many, 2, { setup: "anthropicApi" });
  assert.ok(second.includes("(request 2 of 2 to fix it). This is the last time you are asked"));
  assert.ok(second.includes("- Error number 40."));
  assert.ok(!second.includes("- Error number 41."));
  assert.ok(
    second.includes(
      "(5 more not listed: fix these first, then run CHECK_COMMAND again to see the rest.)",
    ),
  );
  assert.ok(second.endsWith(`\n\n${KEEP_WORKING}`));
  assert.ok(!composeProfileFix(many, 1).includes("last time"));
  assert.ok(composeProfileFix([], 1).includes("errors without details"));
  assert.ok(!composeProfileFix(["x."], 1, { setup: "claudeSubscription" }).includes(KEEP_WORKING));
});

test("the progress markers of a re-edit come from the shared marker text", () => {
  assert.ok(composeReEdit({ ...resumed, changes: "x" }).includes(markerInstructions("reEdit")));
});

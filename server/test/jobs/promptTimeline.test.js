// The message for change requests made on the timeline (docs/SPEC.md section 11, "Change
// requests").

import assert from "node:assert/strict";
import test from "node:test";
import { markerInstructions } from "../../src/jobs/progressMarkers.js";
import { composeEdit } from "../../src/jobs/promptEdit.js";
import {
  composeTimelineEdit,
  describeArea,
  describeEllipse,
  fpsText,
  regionName,
  timeOfFrame,
} from "../../src/jobs/promptTimeline.js";
import { KEEP_WORKING, TIMELINE_RULES } from "../../src/jobs/promptTexts.js";
import { editInput, timelineInput } from "./promptSupport.js";

test("times are written as m:ss.mmm and in seconds, from the frame rate as a fraction", () => {
  assert.deepEqual(timeOfFrame(374, { num: 30, den: 1 }), { clock: "0:12.467", seconds: "12.467" });
  assert.deepEqual(timeOfFrame(0, { num: 30, den: 1 }), { clock: "0:00.000", seconds: "0.000" });
  assert.deepEqual(timeOfFrame(3600, { num: 30, den: 1 }), {
    clock: "2:00.000",
    seconds: "120.000",
  });
  assert.deepEqual(timeOfFrame(30000, { num: 30000, den: 1001 }), {
    clock: "16:41.000",
    seconds: "1001.000",
  });
  assert.equal(timeOfFrame(30 * 3725, { num: 30, den: 1 }).clock, "1:02:05.000");
  assert.equal(fpsText({ num: 30, den: 1 }), "30");
  assert.equal(fpsText({ num: 30000, den: 1001 }), "29.97");
});

test("an ellipse is described by region, centre, size and pixel box", () => {
  assert.equal(
    describeEllipse({ cx: 0.23, cy: 0.31, rx: 0.06, ry: 0.1 }, 1920, 1080),
    "an ellipse around the upper left: centre 23% from the left and 31% from the top, 12% of the width wide and 20% of the height high, in pixels x 326 to 557, y 227 to 443 of 1920x1080",
  );
  assert.equal(
    describeEllipse({ cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25 }, 1080, 1920),
    "an ellipse around the centre of the frame: centre 50% from the left and 50% from the top, 50% of the width wide and 50% of the height high, in pixels x 270 to 810, y 480 to 1440 of 1080x1920",
  );
});

test("an ellipse at the edges is clamped to the frame in pixels", () => {
  assert.equal(
    describeEllipse({ cx: 0, cy: 0, rx: 0.1, ry: 0.1 }, 1920, 1080),
    "an ellipse around the upper left: centre 0% from the left and 0% from the top, 20% of the width wide and 20% of the height high, in pixels x 0 to 192, y 0 to 108 of 1920x1080",
  );
  assert.equal(
    describeEllipse({ cx: 1, cy: 1, rx: 0.1, ry: 0.1 }, 1920, 1080),
    "an ellipse around the lower right: centre 100% from the left and 100% from the top, 20% of the width wide and 20% of the height high, in pixels x 1728 to 1920, y 972 to 1080 of 1920x1080",
  );
  assert.throws(
    () => describeEllipse({ cx: Number.NaN, cy: 0.5, rx: 0.1, ry: 0.1 }, 1920, 1080),
    (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
  );
});

test("regions are the thirds of the frame", () => {
  assert.equal(regionName(0.1, 0.1), "the upper left");
  assert.equal(regionName(0.9, 0.9), "the lower right");
  assert.equal(regionName(0.5, 0.1), "the upper centre");
  assert.equal(regionName(0.5, 0.9), "the lower centre");
  assert.equal(regionName(0.1, 0.5), "the middle left");
  assert.equal(regionName(0.9, 0.5), "the middle right");
  assert.equal(regionName(0.5, 0.5), "the centre of the frame");
  // The thirds themselves belong to the middle.
  assert.equal(regionName(1 / 3, 2 / 3), "the centre of the frame");
});

test("the area is the whole frame, a clip, an ellipse, or a clip and an ellipse", () => {
  const input = timelineInput();
  const [first, second] = /** @type {[typeof input.requests[0], typeof input.requests[0]]} */ (
    input.requests
  );
  assert.equal(
    describeArea({ ...first, shape: null, elementId: null }, 1920, 1080),
    "the whole frame",
  );
  assert.equal(describeArea(second, 1920, 1080), "the clip b7 (Desk shot)");
  assert.ok(describeArea(first, 1920, 1080).startsWith("an ellipse around the upper left"));
  assert.equal(describeArea({ ...second, clips: [] }, 1920, 1080), "the clip b7");
  const both = describeArea({ ...first, elementId: "g12" }, 1920, 1080);
  assert.ok(both.startsWith("the clip g12 (Title card); within the frame: an ellipse around"));
});

test("the message with two requests, exact text", () => {
  const text = composeTimelineEdit(timelineInput());
  const expected = `TIMELINE CHANGE REQUESTS. I looked at the timeline of this video and want 2 changes in the project in PROJECT_FOLDER. The frame is 1920x1080 pixels and the frame rate is 30 fps. Times and frames are positions on the project's timeline, where frame 0 is the start of the video; they are not positions in the source files. Open the picture files of a request (they are images) to see the frame.

REQUEST 1 OF 2
Time: 0:12.467 (12.467 seconds), frame 374
Area: an ellipse around the upper left: centre 23% from the left and 31% from the top, 12% of the width wide and 20% of the height high, in pixels x 326 to 557, y 227 to 443 of 1920x1080
Pictures:
- Full frame: /data/projects/k1/notes/n1/frame.jpg
- Full frame with my ellipse drawn on it (shows where the close-up sits): /data/projects/k1/notes/n1/marked.jpg
- Close-up of the area (read the detail from this one): /data/projects/k1/notes/n1/area.jpg
Clips at this frame, from the top layer down (id | kind | label | track | file):
- g12 | graphic | "Title card" | track 2 | compositions/g12.html
- a3 | aroll | "A-roll 3" | track 0 | assets/media/A001.mp4
Words spoken around this time: "so this is the box"
Text of the request:
Make the title smaller.

REQUEST 2 OF 2
Time: 2:00.000 (120.000 seconds), frame 3600
Area: the clip b7 (Desk shot)
Pictures:
- Full frame: /data/projects/k1/notes/n2/frame.jpg
Clips at this frame, from the top layer down (id | kind | label | track | file):
- b7 | broll | "Desk shot" | track 1 | assets/media/B002.mp4
Words spoken around this time: none
Text of the request:
Use a calmer clip here.

${TIMELINE_RULES}

${markerInstructions("timelineEdit")}`;
  assert.equal(text, expected);
});

test("a single request, a missing picture and no clips", () => {
  const input = timelineInput();
  const only = /** @type {typeof input.requests[0]} */ (input.requests[1]);
  input.requests = [
    { ...only, elementId: null, pictures: { frame: null, closeup: null, marked: null }, clips: [] },
  ];
  const text = composeTimelineEdit(input);
  assert.ok(text.includes("want one change in the project"));
  assert.ok(text.includes("REQUEST 1 OF 1"));
  assert.ok(text.includes("Area: the whole frame\n"));
  assert.ok(
    text.includes(
      "Pictures: none could be made for this request; use the time and the clips below.\n",
    ),
  );
  assert.ok(text.includes("Clips at this frame: none.\n"));
  assert.ok(!text.includes("Close-up"));
});

test("the rules carry the motion graphic rule and forbid rendering", () => {
  assert.ok(
    TIMELINE_RULES.includes(
      "re-create only that graphic's file compositions/<id>.html from its earlier instructions (its template and variables are in edit.json, under graphics) plus the new text of the request, and keep its id, its place on the timeline and its length unless the request says otherwise",
    ),
  );
  assert.ok(TIMELINE_RULES.includes("Never render a video file of the edit"));
  assert.ok(TIMELINE_RULES.includes("write [OUTPUT COMPLETED]"));
  assert.ok(TIMELINE_RULES.includes("Keep the ids of the clips that stay"));
});

test("a graphic request names the graphic and its file", () => {
  const input = timelineInput();
  const first = /** @type {typeof input.requests[0]} */ (input.requests[0]);
  input.requests = [{ ...first, shape: null, elementId: "g12", prompt: "Make it blue." }];
  const text = composeTimelineEdit(input);
  assert.ok(text.includes("Area: the clip g12 (Title card)\n"));
  assert.ok(text.includes('- g12 | graphic | "Title card" | track 2 | compositions/g12.html'));
});

test("a clip without a file has no file column", () => {
  const input = timelineInput();
  const first = /** @type {typeof input.requests[0]} */ (input.requests[0]);
  input.requests = [
    { ...first, clips: [{ id: "h1", kind: "hit", label: "Word", track: 3, file: null }] },
  ];
  assert.ok(composeTimelineEdit(input).includes('\n- h1 | hit | "Word" | track 3\n'));
});

test("the user's text is kept as written and blank edges are trimmed", () => {
  const input = timelineInput();
  const first = /** @type {typeof input.requests[0]} */ (input.requests[0]);
  input.requests = [{ ...first, prompt: "\n\nLine one.\n\n  Line two [OUTPUT COMPLETED]  \n\n" }];
  assert.ok(
    composeTimelineEdit(input).includes(
      "Text of the request:\nLine one.\n\n  Line two [OUTPUT COMPLETED]\n\nRULES FOR THESE CHANGES:",
    ),
  );
});

test("an API setup is asked to keep working; no requests are refused", () => {
  const input = { ...timelineInput(), setup: /** @type {const} */ ("anthropicApi") };
  assert.ok(composeTimelineEdit(input).endsWith(`\n\n${KEEP_WORKING}`));
  assert.throws(
    () => composeTimelineEdit({ ...timelineInput(), requests: [] }),
    (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
  );
});

test("a new session gets the full instructions, the earlier work, then the requests", () => {
  const edit = {
    ...editInput(),
    setup: /** @type {const} */ ("opencodeGo"),
    harness: /** @type {const} */ ("opencode2"),
  };
  const input = { ...timelineInput(), setup: edit.setup, harness: edit.harness };
  const resumed = composeTimelineEdit(input);
  const fresh = composeTimelineEdit({ ...input, newSession: edit });
  assert.ok(fresh.startsWith(composeEdit(edit)));
  assert.ok(fresh.includes("the current project is in PROJECT_FOLDER. Build on that work"));
  assert.ok(fresh.includes("TIMELINE CHANGE REQUESTS."));
  assert.equal(fresh.split(KEEP_WORKING).length - 1, 1);
  assert.equal(resumed.split(KEEP_WORKING).length - 1, 1);
  assert.equal(fresh.split("REQUEST 1 OF 2").length - 1, 1);
});

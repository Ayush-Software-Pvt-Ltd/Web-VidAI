// The first message (order of parts, blank
// lines, trimming, product links, notes, styles, slots, refusals, per-program differences), for
// the new header and project paragraph (docs/SPEC.md section 8, "Prompt").

import assert from "node:assert/strict";
import test from "node:test";
import { composeEdit, selectSlots, vidaiParagraph } from "../../src/jobs/promptEdit.js";
import { markerInstructions } from "../../src/jobs/progressMarkers.js";
import {
  KEEP_WORKING,
  OPENCODE2_PROGRAM,
  PRODUCT_LINKS_STEP,
  STYLE_EMPTY,
  STYLE_GIVEN,
} from "../../src/jobs/promptTexts.js";
import { editInput, profile } from "./promptSupport.js";

const HEADER = `MAIN_FOLDER = /Users/e/Editing/Tech Reviews/2026-11-01 Unboxing
CHANNEL_FOLDER = /Users/e/Editing/Tech Reviews
TOOLKIT_FOLDER = /srv/vidai/toolkit/CLAUDE_VE_ALL
PYTHON = /srv/vidai/toolkit/venv/bin/python
Channel Name: Tech Reviews
VIDEO_TYPE = Long
BROLL_FOLDER = /Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/B-Roll
PROJECT_FOLDER = /Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/output/2026-11-01 Unboxing.hf
CHECK_COMMAND = node /srv/vidai/server/src/timeline/checkCli.js "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/output/2026-11-01 Unboxing.hf"
MACHINE: macOS 15.4.1; CPU Apple M3 Max, 16 logical processors; memory 48 GB; GPU Apple M3 Max
LIMITS: Use at most 6 processor cores and 2 GPU tasks at a time; the toolkit already obeys this through VE_CPU_CORES and the GPU slot files, so do not start heavy programs in parallel yourself.`;

const HF =
  '"/srv/vidai/toolkit/venv/bin/python" "/srv/vidai/toolkit/CLAUDE_VE_ALL/ve.py" hf "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing"';

const VIDAI_TOOLKIT = `The toolkit is in TOOLKIT_FOLDER and runs with the Python in PYTHON. Every command takes the absolute video folder, so call it as ${HF} (replace "hf" with the command you need); do not use any other Python or toolkit folder and never write into TOOLKIT_FOLDER. Where older notes (for example MEMORY.md) say CLAUDE_VE_ALL, they mean TOOLKIT_FOLDER. Read /srv/vidai/toolkit/CLAUDE.md (short rules), the section "Writing the edit" of /srv/vidai/toolkit/README.md (the timeline.py contract, the graphic templates and the layouts) and /srv/vidai/toolkit/MEMORY.md (lessons from earlier edits; append a new lesson to it only when you learned one worth keeping) before you start.`;

const VIDAI_PROJECT = `The result of this edit is a HyperFrames project in PROJECT_FOLDER (the folder output/<video folder name>.hf inside MAIN_FOLDER). ${HF} writes it following the channel profile; you may then change its files. Keep working files in CLAUDE_VE inside MAIN_FOLDER, and make sure nothing the project needs to play lies there.
The project must pass CHECK_COMMAND: run it before you finish, and fix every error it reports.
Original footage is linked into the project under assets/media, never copied, and the original files are never changed, moved or deleted. Every motion graphic is its own file compositions/<id>.html; index.html holds no animation.
Never render a video file of the edit (no hyperframes render, no ffmpeg export of the timeline, no screen capture): VidAI renders it from the project later.`;

/** @param {string} styleRule */
const vidai = (styleRule) => `VidAI:
This edit was started from the VidAI app. There is no terminal and nobody can answer questions, so make your best guess and never wait for input.
${VIDAI_TOOLKIT}
${styleRule}
${VIDAI_PROJECT}
When the project in PROJECT_FOLDER is fully done and passes CHECK_COMMAND, clearly write "[OUTPUT COMPLETED]" in your last message.`;

test("the first message of an edit has exactly these parts in this order", () => {
  const expected = `${HEADER}

PRODUCT_LINKS =
https://a.example/1
https://b.example/2

${PRODUCT_LINKS_STEP}

NOTES FOR THIS VIDEO:
Use the red mug shot.

Edit this video tightly.

Keep jokes.

CHANNEL_STYLE (Long 16:9):
Bold yellow captions.

${vidai(STYLE_GIVEN)}

${markerInstructions("edit")}`;
  assert.equal(composeEdit(editInput()), expected);
});

test("no links, no notes and no style: the empty forms, for a Short video", () => {
  const input = editInput();
  input.videoType = "short";
  input.productLinks = "";
  input.notes = "  \n";
  input.profile.styles[0].text = " \n";
  const text = composeEdit(input);
  const expected = `${HEADER.replace("VIDEO_TYPE = Long", "VIDEO_TYPE = Short")}

PRODUCT_LINKS =

Edit this video tightly.

Keep jokes.

CHANNEL_STYLE (Short 9:16):
(empty)

${vidai(STYLE_EMPTY)}

${markerInstructions("edit")}`;
  assert.equal(text, expected);
});

test("blank lines around the channel prompt and notes are trimmed, the inside is untouched", () => {
  const input = editInput();
  input.profile.prompts[0].text = "\r\n\n  First line\n\n\nThird line   \n\n";
  input.notes = "\n\nNote A\n\nNote B\n";
  const text = composeEdit(input);
  assert.ok(
    text.includes(
      "NOTES FOR THIS VIDEO:\nNote A\n\nNote B\n\n  First line\n\n\nThird line\n\nCHANNEL_STYLE",
    ),
  );
});

test("the product step comes only with links,, and no part is empty", () => {
  const withLinks = composeEdit(editInput());
  const input = editInput();
  input.productLinks = "";
  const without = composeEdit(input);
  assert.ok(withLinks.includes("PRODUCT_LINKS STEP (required):"));
  assert.ok(withLinks.includes("CLAUDE_VE/product_images/"));
  assert.ok(!without.includes("PRODUCT_LINKS STEP"));
  for (const part of withLinks.split("\n\n")) assert.notEqual(part, "", "no double blank line");
});

test("the style rule depends on whether the channel has a style", () => {
  const given = composeEdit(editInput());
  const input = editInput();
  input.profile.styles[0].text = "";
  const empty = composeEdit(input);
  assert.ok(given.includes("Never create a Style folder"));
  assert.ok(!given.includes("CHANNEL_FOLDER/Style/STYLE.md ("));
  assert.ok(empty.includes("save it in CHANNEL_FOLDER/Style/STYLE.md"));
  assert.ok(!empty.includes("Never create a Style folder"));
});

test("the selected slots are used: prompt and style of slot 3", () => {
  const input = editInput();
  input.profile.prompts[2] = { name: "Fast cuts", text: "Cut fast." };
  input.profile.styles[2] = { name: "Neon", text: "Neon colors." };
  input.promptSlot = 2;
  input.styleSlot = 2;
  const text = composeEdit(input);
  assert.ok(text.includes("\n\nCut fast.\n\nCHANNEL_STYLE (Long 16:9):\nNeon colors.\n\n"));
  assert.ok(!text.includes("Keep jokes."));
});

test("an empty selected prompt is refused with invalidInput that names the slot and the type", () => {
  const input = editInput();
  input.promptSlot = 1;
  assert.throws(
    () => composeEdit(input),
    (error) =>
      error instanceof Error &&
      /** @type {{ code?: string }} */ (error).code === "invalidInput" &&
      error.message.includes('"Prompt 2"') &&
      error.message.includes("Long"),
  );
  input.videoType = "short";
  assert.throws(() => composeEdit(input), /Short videos/);
  // A prompt of only blanks is empty too.
  input.promptSlot = 0;
  input.profile.prompts[0].text = " \n \n";
  assert.throws(() => composeEdit(input), /is empty/);
});

test("a slot outside 0 to 4 is refused", () => {
  for (const bad of [-1, 5, 1.5, Number.NaN]) {
    const input = editInput();
    input.promptSlot = bad;
    assert.throws(
      () => composeEdit(input),
      (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
    );
    const style = editInput();
    style.styleSlot = bad;
    assert.throws(
      () => composeEdit(style),
      (error) =>
        /** @type {{ code?: string }} */ (error).code === "invalidInput" &&
        /** @type {Error} */ (error).message.includes("style slot"),
    );
  }
  assert.deepEqual(selectSlots(profile(), 0, 4, "long"), {
    prompt: "\nEdit this video tightly.\n\nKeep jokes.\n",
    style: "",
  });
});

test("the channel prompt is user data: it is never altered", () => {
  const input = editInput();
  const odd = "Use {MAIN_FOLDER} as is.\n\tTabbed [OUTPUT COMPLETED] line  inside   text";
  input.profile.prompts[0].text = odd;
  assert.ok(composeEdit(input).includes(`\n\n${odd}\n\nCHANNEL_STYLE`));
});

test("the OpenCode 2 program block sits right before the keep-working paragraph", () => {
  const claudeCodeApi = { ...editInput(), setup: /** @type {const} */ ("anthropicApi") };
  const program2 = { ...claudeCodeApi, harness: /** @type {const} */ ("opencode2") };
  assert.equal(
    composeEdit(program2),
    composeEdit(claudeCodeApi).replace(
      `\n\n${KEEP_WORKING}`,
      `\n\n${OPENCODE2_PROGRAM}\n\n${KEEP_WORKING}`,
    ),
  );
  assert.ok(OPENCODE2_PROGRAM.startsWith("OPENCODE:\nThis edit runs in the OpenCode 2 program"));
  assert.ok(!composeEdit(editInput()).includes("OPENCODE:"));
});

test("every setup but the Claude subscription is asked to keep working", () => {
  const base = composeEdit(editInput());
  assert.ok(!base.includes(KEEP_WORKING));
  for (const setup of /** @type {const} */ (["opencodeGo", "anthropicApi", "openaiApi"])) {
    const text = composeEdit({ ...editInput(), setup });
    // Between the VidAI paragraph and the progress markers.
    assert.equal(
      text,
      base.replace(
        `\n\n${markerInstructions("edit")}`,
        `\n\n${KEEP_WORKING}\n\n${markerInstructions("edit")}`,
      ),
    );
  }
});

test("without machine facts there is no MACHINE line, and the header is otherwise the same", () => {
  const input = { ...editInput(), machine: null };
  const text = composeEdit(input);
  assert.ok(!text.includes("MACHINE:"));
  assert.ok(text.includes("PROJECT_FOLDER ="));
  assert.ok(text.includes("CHECK_COMMAND ="));
  assert.ok(text.includes("\nLIMITS: Use at most 6 processor cores"));
});

test("on Windows the VidAI paragraph gives the toolkit command with slashes and says where PowerShell needs &", () => {
  const input = {
    ...editInput(),
    toolkitFolder: "C:\\Users\\Ed\\AppData\\Roaming\\VidAI Server\\toolkit\\CLAUDE_VE_ALL",
    python: "C:\\Users\\Ed\\AppData\\Roaming\\VidAI Server\\toolkit\\venv\\Scripts\\python.exe",
    mainFolder: "D:\\Editing\\Tech\\Video",
  };
  const line =
    '"C:/Users/Ed/AppData/Roaming/VidAI Server/toolkit/venv/Scripts/python.exe" "C:/Users/Ed/AppData/Roaming/VidAI Server/toolkit/CLAUDE_VE_ALL/ve.py" hf "D:/Editing/Tech/Video"';
  const paragraph = vidaiParagraph(input, true);
  assert.ok(
    paragraph.includes(
      `call it as ${line} (replace "hf" with the command you need). In PowerShell`,
    ),
  );
  assert.ok(paragraph.includes(`In PowerShell write the same line with & in front (& ${line});`));
  assert.ok(paragraph.includes("in Git Bash or cmd.exe write it without."));
  assert.ok(paragraph.includes("and do the same for CHECK_COMMAND."));
  // The files to read are named with the separator of the toolkit folder.
  assert.ok(
    paragraph.includes("C:\\Users\\Ed\\AppData\\Roaming\\VidAI Server\\toolkit\\CLAUDE.md"),
  );
  assert.ok(
    paragraph.includes("C:\\Users\\Ed\\AppData\\Roaming\\VidAI Server\\toolkit\\MEMORY.md"),
  );
});

test("on macOS the toolkit command is plain and PowerShell is not mentioned", () => {
  const paragraph = vidaiParagraph(editInput(), true);
  assert.ok(paragraph.includes('hf "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing" (replace'));
  assert.ok(!paragraph.includes("PowerShell"));
});

test("the message ends with the progress markers of an edit and names the completion marker once in the paragraph", () => {
  const text = composeEdit(editInput());
  assert.ok(text.endsWith(markerInstructions("edit")));
  assert.ok(text.includes("[VIDAI_PROGRESS project_saved]"));
  assert.ok(!text.includes("review_saved"));
  assert.equal(vidaiParagraph(editInput(), true).split("[OUTPUT COMPLETED]").length - 1, 1);
});

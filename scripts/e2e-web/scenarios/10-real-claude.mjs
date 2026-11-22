// Smoke test with the real local Claude Code (`npm run e2e:web -- --real`, never part of the
// default run): proves the real stream-json protocol works through the real `vidai-web` and a
// browser. Uses the model haiku and a trivial channel prompt, on two videos:
// - the second edit is held by a short start delay (one minute lasting 30 s, shortened by the core's
//   debug-build override `VIDAI_E2E_DELAY_MINUTE_MS`) and then starts by itself, so both run at
//   once, each in its own Claude session (state.json and the session chip);
// - the progress marker lines the real Claude writes are understood and move the bar;
// - the first edit goes through the background task hand-off, pause, continue, completion with a
//   review file, and one re-edit.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL } from "../../e2e/library.mjs";
import {
  barValue,
  currentStatus,
  openPanel,
  outputFiles,
  realClaude,
  savedJob,
  submitSheet,
} from "../jobs.mjs";
import { row, startEditing, status } from "../ui.mjs";

const VIDEOS = ["001 Smoke Test", "002 Smoke Twin"];
/** One minute of the start delay lasts this long, and the delay is one minute. */
const MINUTE_MS = 30_000;
const MIN = 60_000;

const PROMPT = `This is an automated test of the VidAI app, not a real video edit. Do exactly these steps and nothing else: 1. Write a short message whose only content is these three lines: [VIDAI_PROGRESS inspected], [VIDAI_PROGRESS transcribed] and [VIDAI_PROGRESS planned], each on a line by itself. 2. Start the bash command \`sleep 25\` as a background task (run_in_background) and wait for its completion notification. 3. Create the folder "output" inside MAIN_FOLDER (inside CHANNEL_FOLDER) if it is missing. 4. Write a minimal valid FCPXML 1.11 document (an empty project, no media) to output/<MAIN_FOLDER>_review_v1.fcpxml. If a _review_vN file already exists, write the next version number instead and keep the old ones. 5. Write a one-line info.txt in MAIN_FOLDER. Do not transcribe, do not run ffmpeg, do not create a virtual environment, do not read MEMORY.md, do not start sub-agents.`;

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "real-claude",
  title:
    "The real Claude Code (haiku): start delay, one session per video, progress markers, pause, continue, re-edit",
  real: true,
  timeout: 25 * MIN,
  async run(t) {
    const [video, twin] = VIDEOS;
    if (!video || !twin) throw new Error("two videos");
    await t.seedLibrary(
      VIDEOS.map((v) => /** @type {[string, "landscape"]} */ ([v, "landscape"])),
      { model: "haiku", startDelayMinutes: 1 },
    );
    // The smoke prompt replaces the channel's Long prompt.
    const file = path.join(t.data, "settings.json");
    const settings = JSON.parse(await readFile(file, "utf8"));
    settings.channels[0].long.prompts[0].text = PROMPT;
    await writeFile(file, JSON.stringify(settings, null, 2));

    const started = Date.now();
    /** @param {string} what */
    const at = (what) => t.note(`${((Date.now() - started) / 1000).toFixed(1)} s: ${what}`);
    /** @param {string} name */
    const info = (name) => existsSync(path.join(t.editing, CHANNEL, name, "info.txt"));

    const server = await t.startServer({
      env: { VIDAI_CLAUDE_BIN: await realClaude(), VIDAI_E2E_DELAY_MINUTE_MS: String(MINUTE_MS) },
    });
    const page = await t.open(server);
    const row1 = row(page, video);
    const row2 = row(page, twin);
    await row1.waitFor({ timeout: 60_000 });
    await row2.waitFor();

    // The model picker and the usage meters fill from the real Claude Code.
    await page.getByRole("button", { name: /^Model: Haiku/ }).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: /^Model: / }).click();
    const models = await page.getByRole("menuitemradio").count();
    t.assert(models > 2, `the model list came from Claude Code (${models} entries)`);
    await page.keyboard.press("Escape");
    await page
      .getByText(/5h|Week/)
      .first()
      .waitFor({ timeout: 60_000 })
      .then(
        async () => {
          const text = await page.locator("body").innerText();
          at(
            `usage meters: ${(/5h\s+\d+%[\s\S]*?Week\s+\d+%/.exec(text) ?? ["?"])[0].replace(/\s+/g, " ")}`,
          );
        },
        () => at("no usage meters (the plan reports no limits)"),
      );
    await t.shot(page, "real-library");

    // Two edits started together: the first starts at once, the second waits for the delay.
    await startEditing(page, video);
    await startEditing(page, twin);
    await status(row1, "Editing");
    await status(row2, "Queued");
    const launched = (await savedJob(t, video)).startedAt ?? NaN;
    const waiting = await savedJob(t, twin);
    t.equal(waiting.startsAt, launched + MINUTE_MS, "the second edit's startsAt");
    await row2.getByText(/Starts in \d+ s/).waitFor();
    at("second edit held by the start delay");
    await t.shot(page, "real-second-edit-waits");
    await status(row2, "Editing", 2 * MIN);
    const startedTwin = await savedJob(t, twin);
    t.assert(
      (startedTwin.startedAt ?? 0) >= (waiting.startsAt ?? Infinity),
      `the second edit started ${(waiting.startsAt ?? 0) - (startedTwin.startedAt ?? 0)} ms before its startsAt`,
    );
    at("second edit started by itself after the delay");

    // Each video in its own Claude session.
    const ids = await t.waitFor(async () => {
      const a = (await savedJob(t, video)).sessionId;
      const b = (await savedJob(t, twin)).sessionId;
      return a && b ? [a, b] : null;
    }, "both edits have a session");
    const [sessionA = "", sessionB = ""] = ids;
    t.assert(sessionA !== sessionB, `two edits share the session ${sessionA}`);
    let panel = await openPanel(page, row2, twin);
    await panel.getByText(sessionB.slice(0, 8)).first().waitFor();
    panel = await openPanel(page, row1, video);
    await panel.getByText(sessionA.slice(0, 8)).first().waitFor();
    at(`sessions ${sessionA.slice(0, 8)} and ${sessionB.slice(0, 8)}`);

    // The marker lines of step 1 move the bar to the plan (30%) before the background task.
    await panel
      .getByText("Transcription done")
      .first()
      .waitFor({ timeout: 4 * MIN });
    const value = await t.waitFor(
      async () => {
        const [inRow, inPanel] = [await barValue(row1), await barValue(panel)];
        return inRow >= 30 && inPanel >= 30 ? inRow : 0;
      },
      "the progress bars at 30% or more after the marker lines",
      30_000,
    );
    t.assert(value < 74, `the bar shows ${value}% before the graphics milestone`);
    t.assert(!(await panel.innerText()).includes("VIDAI_PROGRESS"), "no raw markers in the log");
    at(`markers understood: ${value}%`);
    await panel
      .getByText(/Waiting for (a background task|\d+ background tasks)/)
      .first()
      .waitFor({ timeout: 4 * MIN });
    at("background task hand-off");
    await t.shot(page, "real-background-task");

    await row1.getByRole("button", { name: "Pause Editing" }).click();
    await status(row1, "Paused", 2 * MIN);
    const pausedAt = await barValue(row1);
    at(`paused at ${pausedAt}%`);
    await t.shot(page, "real-paused");

    await row1.getByRole("button", { name: "Continue Editing" }).click();
    await status(row1, "Editing");
    t.assert((await barValue(row1)) >= pausedAt, "the bar went back after Continue");
    at("continued");
    await status(row1, /Edited|Needs attention/, 8 * MIN);
    at(`after continue: ${await currentStatus(row1)}`);
    const first = { files: await outputFiles(t, video), info: info(video) };
    t.note(`outputs: ${JSON.stringify(first)}`);
    await status(row1, "Edited");
    t.assert(
      first.files.some((f) => f.endsWith(".fcpxml")),
      "a review project exists",
    );
    await status(row2, /Edited|Needs attention/, 8 * MIN);
    at(`second edit: ${await currentStatus(row2)}`);
    await status(row2, "Edited");
    await t.shot(page, "real-edited");

    await submitSheet(page, row1, {
      button: "Re-Edit",
      field: "What should change",
      text: 'Rename the project inside the FCPXML to "Smoke Test v2" and save it as the next review version.',
    });
    await status(row1, /Re-editing/);
    at("re-editing");
    t.equal(
      (await savedJob(t, video)).sessionId,
      sessionA,
      "the re-edit resumes the video's own session",
    );
    await status(row1, /Edited|Needs attention/, 8 * MIN);
    at(`after re-edit: ${await currentStatus(row1)}`);
    const second = { files: await outputFiles(t, video), info: info(video) };
    t.note(`outputs: ${JSON.stringify(second)}`);
    await status(row1, "Edited");
    t.assert(
      second.files.filter((f) => f.endsWith(".fcpxml")).length >= 2,
      "a second review version exists",
    );
    await t.shot(page, "real-re-edited");
  },
};

// Smoke test with the real local Claude Code (`npm run e2e -- --real`, never part of the default
// run): proves the real stream-json protocol works through the real app. Uses the model haiku
// and a trivial channel prompt, on two videos:
// - the second edit is held by a short start delay (one minute lasting 30 s) and then starts by
//   itself, so both run at once, each in its own Claude session (state.json and the session chip);
// - the progress marker lines the real Claude writes are understood and move the bar;
// - the first edit goes through the background task hand-off, pause, continue, completion with a
//   review file, and one re-edit.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL, CHANNEL_ID, outputFiles, seedLibrary } from "../library.mjs";

const VIDEOS = ["001 Smoke Test", "002 Smoke Twin"];
/** One minute of the start delay lasts this long, and the delay is one minute. */
const MINUTE_MS = 30_000;

const PROMPT = `This is an automated test of the VidAI app, not a real video edit. Do exactly these steps and nothing else: 1. Write a short message whose only content is these three lines: [VIDAI_PROGRESS inspected], [VIDAI_PROGRESS transcribed] and [VIDAI_PROGRESS planned], each on a line by itself. 2. Start the bash command \`sleep 25\` as a background task (run_in_background) and wait for its completion notification. 3. Create the folder "output" inside MAIN_FOLDER (inside CHANNEL_FOLDER) if it is missing. 4. Write a minimal valid FCPXML 1.11 document (an empty project, no media) to output/<MAIN_FOLDER>_review_v1.fcpxml. If a _review_vN file already exists, write the next version number instead and keep the old ones. 5. Write a one-line info.txt in MAIN_FOLDER. Do not transcribe, do not run ffmpeg, do not create a virtual environment, do not read MEMORY.md, do not start sub-agents.`;

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "real-claude",
  title:
    "The real Claude Code (haiku): start delay, one session per video, progress markers, pause, continue, re-edit",
  real: true,
  timeout: 25 * 60_000,
  env: { VIDAI_E2E_DELAY_MINUTE_MS: String(MINUTE_MS) },
  async prepare(ctx) {
    await seedLibrary(
      ctx,
      VIDEOS.map((v) => /** @type {[string, "landscape"]} */ ([v, "landscape"])),
      { model: "haiku", startDelayMinutes: 1 },
    );
    // The smoke prompt replaces the channel's Long prompt.
    const file = path.join(ctx.data, "settings.json");
    const settings = JSON.parse(await readFile(file, "utf8"));
    settings.channels[0].long.prompts[0].text = PROMPT;
    await writeFile(file, JSON.stringify(settings, null, 2));
    ctx.params.videos = VIDEOS;
    ctx.params.delayMs = MINUTE_MS;
  },
  ops: {
    async outputs(ctx, args) {
      const info = existsSync(path.join(ctx.editing, CHANNEL, args.video, "info.txt"));
      return { files: await outputFiles(ctx, args.video), info };
    },
    /** The saved job of a video: state, session, startedAt and startsAt (ms since the epoch). */
    async job(ctx, args) {
      const state = JSON.parse(await readFile(path.join(ctx.data, "state.json"), "utf8"));
      const job = state.videos?.[`${CHANNEL_ID}/${args.video}`]?.latestJob;
      if (!job) throw new Error(`${args.video} has no job`);
      const ms = (/** @type {string | null} */ t) => (t === null ? null : Date.parse(t));
      return {
        state: job.state,
        sessionId: job.sessionId,
        startedAt: ms(job.startedAt),
        startsAt: ms(job.startsAt),
      };
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const [video, twin] = p.videos;
        const t0 = Date.now();
        const at = (/** @type {string} */ what) =>
          ui.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: ${what}`);
        const MIN = 60_000;
        /** The value of the first progress bar in `scope` (NaN while there is none). */
        const barIn = (/** @type {import("../types.mjs").Scope} */ scope) =>
          Number(scope.all("progressbar")[0]?.getAttribute("aria-valuenow") ?? NaN);

        const row = await ui.row(video, 60_000);
        const twinRow = await ui.row(twin);
        // The model picker and the usage meters fill from the real Claude Code.
        await ui.find("button", /^Model: Haiku/, 60_000);
        await ui.click("button", /^Model: /);
        const models = ui.all("menuitemradio").length;
        ui.assert(models > 2, `the model list came from Claude Code (${models} entries)`);
        await ui.key("Escape");
        await ui.text(/5h \d+%|Week \d+%/, 60_000).then(
          () => at(`usage meters: ${(/5h \d+%.*?Week \d+%/.exec(ui.content()) ?? ["?"])[0]}`),
          () => at("no usage meters (the plan reports no limits)"),
        );
        await host.shot("real-library");

        // Two edits started together: the first starts at once, the second waits for the delay.
        for (const r of [row, twinRow]) {
          await r.press("Start Editing");
          await (await ui.dialog("Start Editing")).press("Start Editing");
        }
        await row.status("Editing");
        await twinRow.status("Queued");
        const launched = (await host.call("job", { video })).startedAt;
        const waiting = await host.call("job", { video: twin });
        ui.equal(waiting.startsAt, launched + p.delayMs, "the second edit's startsAt");
        await twinRow.text(/Starts in \d+ s/);
        at("second edit held by the start delay");
        await host.shot("real-second-edit-waits");
        await twinRow.status("Editing", 2 * MIN);
        const started = await host.call("job", { video: twin });
        ui.assert(
          started.startedAt >= waiting.startsAt,
          `the second edit started ${waiting.startsAt - started.startedAt} ms before its startsAt`,
        );
        at("second edit started by itself after the delay");

        // Each video in its own Claude session.
        const sessions = await ui.waitFor(async () => {
          const a = await host.call("job", { video });
          const b = await host.call("job", { video: twin });
          return a.sessionId && b.sessionId ? [a.sessionId, b.sessionId] : null;
        }, "both edits have a session");
        ui.assert(sessions[0] !== sessions[1], `two edits share the session ${sessions[0]}`);
        await twinRow.click("button", twin);
        let panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text(sessions[1].slice(0, 8));
        await row.click("button", video);
        panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text(sessions[0].slice(0, 8));
        at(`sessions ${sessions[0].slice(0, 8)} and ${sessions[1].slice(0, 8)}`);

        // The marker lines of step 1 move the bar to the plan (30%) before the background task.
        await panel.text("Transcription done", 4 * MIN);
        const value = await ui.waitFor(
          () => (barIn(row) >= 30 && barIn(panel) >= 30 ? barIn(row) : 0),
          "the progress bars at 30% or more after the marker lines",
          30_000,
        );
        ui.assert(value < 74, `the bar shows ${value}% before the graphics milestone`);
        ui.assert(!panel.content().includes("VIDAI_PROGRESS"), "no raw markers in the log");
        at(`markers understood: ${value}%`);
        await panel.text(/Waiting for (a background task|\d+ background tasks)/, 4 * MIN);
        at("background task hand-off");
        await host.shot("real-background-task");

        await row.press("Pause Editing");
        await row.status("Paused", 2 * MIN);
        const paused = barIn(row);
        at(`paused at ${paused}%`);
        await host.shot("real-paused");

        await row.press("Continue Editing");
        await row.status("Editing");
        ui.assert(barIn(row) >= paused, "the bar went back after Continue");
        at("continued");
        await row.status(/Edited|Needs attention/, 8 * MIN);
        at(`after continue: ${row.currentStatus()}`);
        const first = await host.call("outputs", { video });
        ui.log(`outputs: ${JSON.stringify(first)}`);
        await row.status("Edited");
        ui.assert(
          first.files.some((/** @type {string} */ f) => f.endsWith(".fcpxml")),
          "a review project exists",
        );
        await twinRow.status(/Edited|Needs attention/, 8 * MIN);
        at(`second edit: ${twinRow.currentStatus()}`);
        await twinRow.status("Edited");
        await host.shot("real-edited");

        await row.press("Re-Edit");
        const sheet = await ui.dialog("Re-Edit");
        await sheet.fill(
          "What should change",
          'Rename the project inside the FCPXML to "Smoke Test v2" and save it as the next review version.',
        );
        await sheet.press("Re-Edit");
        await row.status(/Re-editing/);
        at("re-editing");
        ui.equal(
          (await host.call("job", { video })).sessionId,
          sessions[0],
          "the re-edit resumes the video's own session",
        );
        await row.status(/Edited|Needs attention/, 8 * MIN);
        at(`after re-edit: ${row.currentStatus()}`);
        const second = await host.call("outputs", { video });
        ui.log(`outputs: ${JSON.stringify(second)}`);
        await row.status("Edited");
        ui.assert(
          second.files.filter((/** @type {string} */ f) => f.endsWith(".fcpxml")).length >= 2,
          "a second review version exists",
        );
        await host.shot("real-re-edited");
      },
    },
  ],
};

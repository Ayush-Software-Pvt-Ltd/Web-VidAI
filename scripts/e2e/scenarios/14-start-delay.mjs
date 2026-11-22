// The start delay between edit starts (SPEC section 6, "Start delay"), with one delay minute
// shortened to half a second by VIDAI_E2E_DELAY_MINUTE_MS: the second edit waits with a
// startsAt and starts by itself when the delay has passed, "Start now" skips the wait, and a
// first job that finishes releases the waiting one at once.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL_ID, seedLibrary } from "../library.mjs";

const VIDEOS = ["001 First", "002 Second", "003 Third", "004 Fourth", "005 Fifth"];
const MINUTE_MS = 500;
const DELAY_MINUTES = 30;
/** The whole delay: 15 s, well beyond the time a job takes to finish (its settle time is 4 s). */
const DELAY_MS = MINUTE_MS * DELAY_MINUTES;

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "start-delay",
  title: "The start delay holds the next edit, Start now skips it, a finished job releases it",
  timeout: 180_000,
  env: { VIDAI_E2E_DELAY_MINUTE_MS: String(MINUTE_MS) },
  async prepare(ctx) {
    await seedLibrary(
      ctx,
      VIDEOS.map((v) => /** @type {[string, "landscape"]} */ ([v, "landscape"])),
      { startDelayMinutes: DELAY_MINUTES, maxConcurrentEdits: 3 },
    );
    ctx.params.videos = VIDEOS;
    ctx.params.delayMs = DELAY_MS;
    await ctx.fakeSet("scenario", "live");
  },
  ops: {
    /** The saved job of a video: state, startedAt, startsAt (times in ms since the epoch). */
    async job(ctx, args) {
      const state = JSON.parse(await readFile(path.join(ctx.data, "state.json"), "utf8"));
      const job = state.videos?.[`${CHANNEL_ID}/${args.video}`]?.latestJob;
      if (!job) throw new Error(`${args.video} has no job`);
      const ms = (/** @type {string | null} */ t) => (t === null ? null : Date.parse(t));
      return { state: job.state, startedAt: ms(job.startedAt), startsAt: ms(job.startsAt) };
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const [first, second, third, fourth, fifth] = p.videos;
        /** @param {string} video */
        const start = async (video) => {
          const row = await ui.row(video, 30_000);
          await row.press("Start Editing");
          await (await ui.dialog("Start Editing")).press("Start Editing");
          return row;
        };
        /** Releases a running edit and waits until it is done. @param {string} video */
        const finish = async (video) => {
          await host.call("fake", { name: `release.${video}` });
          await (await ui.row(video)).status("Edited", 60_000);
        };

        // The first edit starts at once; the second waits for the delay, with a startsAt.
        const row1 = await start(first);
        await row1.status("Editing");
        const row2 = await start(second);
        await row2.status("Queued");
        const launched1 = (await host.call("job", { video: first })).startedAt;
        const waiting2 = await host.call("job", { video: second });
        ui.equal(waiting2.state, "queued", "the second edit's state");
        ui.equal(waiting2.startsAt, launched1 + p.delayMs, "the second edit's startsAt");
        await row2.find("button", "Start now");
        ui.assert(!row1.has("button", "Start now"), "a running edit offers no Start now");
        await host.shot("second-edit-waits");

        // It starts by itself when the delay has passed, not before.
        await row2.status("Editing", p.delayMs + 20_000);
        const started2 = await host.call("job", { video: second });
        ui.assert(
          started2.startedAt >= waiting2.startsAt,
          `the second edit started ${waiting2.startsAt - started2.startedAt} ms early`,
        );
        ui.equal(started2.startsAt, null, "startsAt of a running edit");
        await row2.gone("button", "Start now");

        // A third edit waits for one delay after the second; Start now skips the wait.
        const row3 = await start(third);
        await row3.status("Queued");
        const waiting3 = await host.call("job", { video: third });
        ui.equal(waiting3.startsAt, started2.startedAt + p.delayMs, "the third edit's startsAt");
        await row3.press("Start now");
        await row3.status("Editing");
        const started3 = await host.call("job", { video: third });
        ui.assert(
          started3.startedAt < waiting3.startsAt,
          "Start now did not start the third edit before its startsAt",
        );
        await host.shot("start-now");
        for (const video of [first, second, third]) await finish(video);

        // Nothing runs: the fourth starts at once, the fifth waits for it...
        const row4 = await start(fourth);
        await row4.status("Editing");
        const row5 = await start(fifth);
        await row5.status("Queued");
        const waiting5 = await host.call("job", { video: fifth });
        ui.assert(waiting5.startsAt !== null, "the fifth edit waits for the delay");
        // ...until the fourth is finished: with no edit running, the fifth starts at once.
        await host.call("fake", { name: `release.${fourth}` });
        await row4.status("Edited", 60_000);
        await row5.status("Editing", 30_000);
        const started5 = await host.call("job", { video: fifth });
        ui.assert(
          started5.startedAt < waiting5.startsAt,
          "the fifth edit waited for the delay although nothing else was running",
        );
        await host.shot("released-by-the-finished-edit");
        await finish(fifth);
      },
    },
  ],
};

// The start delay between edit starts (SPEC section 6, "Start delay") in the browser. One delay
// minute is shortened to half a second with `VIDAI_E2E_DELAY_MINUTE_MS`, which the core reads in
// debug builds (`jobs::setup`), so it also works in the debug `vidai-web`. The second edit waits
// with a startsAt ("Starts in N s", Start now) and starts by itself when the delay has passed,
// "Start now" skips the wait, and a first job that finishes releases the waiting one at once.
import { savedJob } from "../jobs.mjs";
import { row, startEditing, status } from "../ui.mjs";

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
  async run(t) {
    const [first, second, third, fourth, fifth] = VIDEOS;
    if (!first || !second || !third || !fourth || !fifth) throw new Error("five videos");
    await t.seedLibrary(
      VIDEOS.map((v) => /** @type {[string, "landscape"]} */ ([v, "landscape"])),
      { startDelayMinutes: DELAY_MINUTES, maxConcurrentEdits: 3 },
    );
    await t.fakeSet("scenario", "live");
    const server = await t.startServer({ env: { VIDAI_E2E_DELAY_MINUTE_MS: String(MINUTE_MS) } });
    const page = await t.open(server);
    await row(page, first).waitFor();

    /** Releases a running edit and waits until it is done. @param {string} video */
    const finish = async (video) => {
      await t.release(video);
      await status(row(page, video), "Edited", 60_000);
    };

    // The first edit starts at once; the second waits for the delay, with a startsAt.
    const row1 = row(page, first);
    await startEditing(page, first);
    await status(row1, "Editing");
    const row2 = row(page, second);
    await startEditing(page, second);
    await status(row2, "Queued");
    const launched1 = (await savedJob(t, first)).startedAt ?? NaN;
    const waiting2 = await savedJob(t, second);
    t.equal(waiting2.state, "queued", "the second edit's state");
    t.equal(waiting2.startsAt, launched1 + DELAY_MS, "the second edit's startsAt");
    await row2.getByText(/Starts in \d+ s/).waitFor();
    await row2.getByRole("button", { name: "Start now" }).waitFor();
    t.equal(
      await row1.getByRole("button", { name: "Start now" }).count(),
      0,
      "a running edit offers Start now",
    );
    await t.shot(page, "second-edit-waits");

    // It starts by itself when the delay has passed, not before.
    await status(row2, "Editing", DELAY_MS + 20_000);
    const started2 = await savedJob(t, second);
    t.assert(
      (started2.startedAt ?? 0) >= (waiting2.startsAt ?? Infinity),
      `the second edit started ${(waiting2.startsAt ?? 0) - (started2.startedAt ?? 0)} ms early`,
    );
    t.equal(started2.startsAt, null, "startsAt of a running edit");
    await row2.getByRole("button", { name: "Start now" }).waitFor({ state: "detached" });

    // A third edit waits for one delay after the second; Start now skips the wait.
    const row3 = row(page, third);
    await startEditing(page, third);
    await status(row3, "Queued");
    const waiting3 = await savedJob(t, third);
    t.equal(waiting3.startsAt, (started2.startedAt ?? NaN) + DELAY_MS, "the third edit's startsAt");
    await row3.getByRole("button", { name: "Start now" }).click();
    await status(row3, "Editing");
    const started3 = await savedJob(t, third);
    t.assert(
      (started3.startedAt ?? Infinity) < (waiting3.startsAt ?? 0),
      "Start now did not start the third edit before its startsAt",
    );
    await t.shot(page, "start-now");
    for (const video of [first, second, third]) await finish(video);

    // Nothing runs: the fourth starts at once, the fifth waits for it...
    const row4 = row(page, fourth);
    await startEditing(page, fourth);
    await status(row4, "Editing");
    const row5 = row(page, fifth);
    await startEditing(page, fifth);
    await status(row5, "Queued");
    const waiting5 = await savedJob(t, fifth);
    t.assert(waiting5.startsAt !== null, "the fifth edit waits for the delay");
    // ...until the fourth is finished: with no edit running, the fifth starts at once.
    await t.release(fourth);
    await status(row4, "Edited", 60_000);
    await status(row5, "Editing", 30_000);
    const started5 = await savedJob(t, fifth);
    t.assert(
      (started5.startedAt ?? Infinity) < (waiting5.startsAt ?? 0),
      "the fifth edit waited for the delay although nothing else was running",
    );
    await t.shot(page, "released-by-the-finished-edit");
    await finish(fifth);
  },
};

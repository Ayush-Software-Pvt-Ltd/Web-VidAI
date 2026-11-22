// The concurrency limit (SPEC section 6): with one edit allowed at a time, the second video waits
// as Queued (the sidebar counts "1 editing, 1 queued"), does not start before the first one is
// done, and starts by itself afterwards.
import { existsSync } from "node:fs";
import path from "node:path";
import { row, startEditing, status } from "../ui.mjs";

const FIRST = "001 First";
const SECOND = "002 Second";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "failures-concurrency",
  title: "Concurrency limit 1: the second video is Queued and starts after the first",
  async run(t) {
    await t.seedLibrary(
      [
        [FIRST, "landscape"],
        [SECOND, "landscape"],
      ],
      { maxConcurrentEdits: 1 },
    );
    await t.fakeSet("scenario", "live");
    const server = await t.startServer();
    const page = await t.open(server);
    const first = row(page, FIRST);
    const second = row(page, SECOND);
    await first.waitFor();
    await second.waitFor();

    await startEditing(page, FIRST);
    await status(first, "Editing");
    await startEditing(page, SECOND);
    await status(second, "Queued");
    await second.getByRole("button", { name: "Stop Editing" }).waitFor();
    await page.getByText("1 editing, 1 queued").first().waitFor();
    await t.shot(page, "queued");

    // The first one works; the second has not started (it needs the first one's place).
    await t.waitFake(`started.${FIRST}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    t.equal(existsSync(path.join(t.fake, `started.${SECOND}`)), false, "the second started early");

    await t.release(FIRST);
    await status(first, "Edited", 30_000);
    await status(second, "Editing", 15_000);
    await t.waitFake(`started.${SECOND}`);
    await t.release(SECOND);
    await status(second, "Edited", 30_000);
  },
};

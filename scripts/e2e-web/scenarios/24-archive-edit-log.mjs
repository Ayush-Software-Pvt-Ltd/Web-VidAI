// List sorting, Archive and the edit log (desktop 23-archive-edit-log): the list sorts by Age, by
// Name (A-Z, then Z-A) and back; an edited video is archived, leaves the main list, shows in
// Archive and comes back with Unarchive; the Edit Log lists what happened; and the same lines are
// mirrored to `VidAI-edit-log.txt` in the Editing Folder, one per line.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL_ID } from "../../e2e/library.mjs";
import { row, status } from "../ui.mjs";

const FIRST = "001 Alpha Clip";
const SECOND = "002 Beta Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "archive-edit-log",
  title: "Sorting, Archive and Unarchive, the edit log and its mirror in the Editing Folder",
  timeout: 150_000,
  async run(t) {
    await t.seedLibrary([
      [FIRST, "landscape"],
      [SECOND, "landscape"],
    ]);
    const server = await t.startServer();
    const page = await t.open(server);
    const first = row(page, FIRST);
    await first.waitFor({ timeout: 30_000 });
    await row(page, SECOND).waitFor({ timeout: 30_000 });
    await first.getByRole("button", { name: "Start Editing" }).click();
    await page
      .getByRole("dialog", { name: "Start Editing" })
      .getByRole("button", { name: "Start Editing" })
      .click();
    await status(first, "Edited", 30_000);

    // Sorting: Age newest first by default, then Name (A-Z, then Z-A on a second pick), then Age.
    const titles = () =>
      page
        .getByRole("button", { name: /^00[12] (Alpha|Beta) Clip$/ })
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
        );
    const sortBy = async (/** @type {string} */ name) => {
      await page.getByRole("button", { name: /^Sort videos/ }).click();
      await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
    };
    t.equal((await titles()).join(" | "), `${SECOND} | ${FIRST}`, "the default order");
    await sortBy("Name");
    await t.waitFor(async () => (await titles())[0] === FIRST, "the A-Z order");
    await t.shot(page, "sorted-a-z");
    await sortBy("Name");
    await t.waitFor(async () => (await titles())[0] === SECOND, "the Z-A order");
    await sortBy("Age");
    await t.waitFor(async () => (await titles())[0] === SECOND, "the Age order");

    // Archive the edited video: it leaves the main list, nothing else does.
    await first.getByRole("button", { name: "Archive" }).click();
    await first.waitFor({ state: "detached", timeout: 20_000 });
    await row(page, SECOND).waitFor();
    await t.shot(page, "archived");

    // Archive (sidebar footer) lists it; Unarchive brings it back.
    const footer = page.getByRole("navigation", { name: /^Archive, Edit Log/ });
    await footer.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByText(FIRST).first().waitFor({ timeout: 20_000 });
    await t.shot(page, "archive");
    await page.getByRole("button", { name: "Unarchive" }).click();
    await page.getByText("Nothing archived").first().waitFor({ timeout: 20_000 });

    // Edit Log: what happened to the video.
    await footer.getByRole("button", { name: "Edit Log", exact: true }).click();
    await page.getByText(FIRST).first().waitFor({ timeout: 20_000 });
    for (const message of ["Edit started (", "Finished (", "Archived", "Unarchived"]) {
      await page.getByText(message).first().waitFor({ timeout: 20_000 });
    }
    await t.shot(page, "edit-log");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await row(page, FIRST).waitFor({ timeout: 20_000 });

    // The mirror: every entry of the first video on a line of its own, in order.
    const text = await readFile(path.join(t.editing, "VidAI-edit-log.txt"), "utf8");
    t.assert(text.endsWith("\n"), "the mirror ends with a line ending");
    t.assert(!text.includes("\r"), "the mirror has no carriage return on this platform");
    const events = text
      .split("\n")
      .map((line) => new RegExp(`^\\[[^\\]]+\\] ${CHANNEL_ID}/${FIRST} (\\w+) - `).exec(line))
      .filter((m) => m !== null)
      .map((m) => m[1]);
    t.equal(events, ["started", "completed", "archived", "unarchived"], "the mirror's events");
  },
};

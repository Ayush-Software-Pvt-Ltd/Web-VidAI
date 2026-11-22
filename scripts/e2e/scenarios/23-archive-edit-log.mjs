// List sorting, Archive and the edit log (SPEC sections 4, 5 and 9): the list sorts by Age, by
// Name (A-Z, then Z-A) and back; an edited video is archived, leaves the main list, shows in Archive and comes
// back with Unarchive; the Edit Log lists what happened; and the same lines are mirrored to
// `VidAI-edit-log.txt` in the Editing Folder, one per line, with the line endings of the
// platform's text files (CRLF on Windows).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL_ID, seedLibrary } from "../library.mjs";

const FIRST = "001 Alpha Clip";
const SECOND = "002 Beta Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "archive-edit-log",
  title: "Sorting, Archive and Unarchive, the edit log and its mirror in the Editing Folder",
  timeout: 150_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [
      [FIRST, "landscape"],
      [SECOND, "landscape"],
    ]);
    Object.assign(ctx.params, { first: FIRST, second: SECOND });
  },
  ops: {
    /** The mirror: every entry of the first video on a line of its own, in order, CRLF on Windows. */
    async checkMirror(ctx) {
      const text = await readFile(path.join(ctx.editing, "VidAI-edit-log.txt"), "utf8");
      const eol = process.platform === "win32" ? "\r\n" : "\n";
      if (!text.endsWith(eol))
        throw new Error(`the mirror does not end with ${JSON.stringify(eol)}`);
      const lines = text.split(eol);
      lines.pop();
      if (text.split("\n").length - 1 !== lines.length) {
        throw new Error("the mirror has a line ending that is not " + JSON.stringify(eol));
      }
      const events = lines
        .map((line) => new RegExp(`^\\[[^\\]]+\\] ${CHANNEL_ID}/${FIRST} (\\w+) - `).exec(line))
        .filter((m) => m !== null)
        .map((m) => m?.[1]);
      const want = ["started", "completed", "archived", "unarchived"];
      if (JSON.stringify(events) !== JSON.stringify(want)) {
        throw new Error(
          `the mirror says ${JSON.stringify(events)}, wanted ${JSON.stringify(want)}`,
        );
      }
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const first = await ui.row(p.first, 30_000);
        await ui.row(p.second, 30_000);
        await first.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await first.status("Edited", 30_000);

        // Sorting: Age newest first by default, then Name (A-Z, then Z-A on a second pick), then Age.
        const titles = () =>
          /** @type {any[]} */ (ui.all("button", /^00[12] (Alpha|Beta) Clip$/)).map(
            (el) => el.getAttribute("aria-label") ?? el.textContent.trim(),
          );
        const sortBy = async (/** @type {string} */ name) => {
          await ui.click("button", /^Sort videos/);
          // Chosen with the keyboard, like the other menus here.
          /** @type {any} */ (await ui.find("menuitem", new RegExp(`^${name}`))).focus();
          await ui.key("Enter");
        };
        ui.equal(titles().join(" | "), `${p.second} | ${p.first}`, "the default order");
        await sortBy("Name");
        await ui.waitFor(() => titles()[0] === p.first, "the A-Z order");
        await host.shot("sorted-a-z");
        await sortBy("Name");
        await ui.waitFor(() => titles()[0] === p.second, "the Z-A order");
        await sortBy("Age");
        await ui.waitFor(() => titles()[0] === p.second, "the Age order");

        // Archive the edited video: it leaves the main list, nothing else does.
        // The list was reordered, so the row is looked up again.
        await (await ui.row(p.first)).press("Archive");
        await ui.gone("button", p.first, 20_000);
        await ui.row(p.second);
        await host.shot("archived");

        // Archive (sidebar footer) lists it; Unarchive brings it back.
        const footer = ui.within(await ui.find("navigation", /^Archive, Edit Log/));
        await footer.click("button", "Archive");
        await ui.text(p.first, 20_000);
        await host.shot("archive");
        await ui.press("Unarchive");
        await ui.text("Nothing archived", 20_000);

        // Edit Log: what happened to the video, newest first.
        await footer.click("button", "Edit Log");
        await ui.text(p.first, 20_000);
        for (const message of ["Edit started (", "Finished (", "Archived", "Unarchived"]) {
          await ui.text(message, 20_000);
        }
        await host.shot("edit-log");
        await ui.press("Done");
        await ui.row(p.first, 20_000);
        await host.call("checkMirror");
      },
    },
  ],
};

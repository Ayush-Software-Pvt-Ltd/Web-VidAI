// Render Final 4K (SPEC section 6): the sheet's notes reach Claude Code in the render message, the
// final file appears in output/ and in the Outputs tab, and the row says Final rendered.
import { expectParts } from "../../e2e/library.mjs";
import { outputFiles, openPanel, sessions, submitSheet } from "../jobs.mjs";
import { row, startEditing, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "render-final",
  title: "Render Final 4K creates the final file, status Final rendered",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const server = await t.startServer();
    const page = await t.open(server);
    const video = row(page, VIDEO);
    await video.waitFor();

    await startEditing(page, VIDEO);
    await status(video, "Edited", 30_000);
    t.assert(
      !(await outputFiles(t, VIDEO)).includes(`${VIDEO}_final.mp4`),
      "no final file before the render",
    );

    // From now on the fake writes a final render for the render request.
    await t.fakeSet("scenario", "render");
    await submitSheet(page, video, {
      button: "Render Final 4K",
      field: "Notes",
      text: "Use the 4K master.",
      shot: () => t.shot(page, "render-sheet"),
    });
    await status(video, "Final rendered", 30_000);

    const panel = await openPanel(page, video, VIDEO);
    await panel.getByRole("tab", { name: "Outputs" }).click();
    await panel.getByText(`${VIDEO}_final.mp4`).first().waitFor();
    await t.shot(page, "final-rendered");

    t.assert(
      (await outputFiles(t, VIDEO)).includes(`${VIDEO}_final.mp4`),
      "the final render is in output/",
    );
    const all = await sessions(t);
    t.equal(all.length, 2, "Claude Code processes (the edit and the render)");
    const [edit, render] = all;
    t.assert(edit && render && render.sid === edit.sid, "the render resumed the edit's session");
    expectParts(
      render?.messages[0] ?? "",
      [
        "I reviewed and approved the review project. Create the final output render now",
        "Use the 4K master.",
        "Write [OUTPUT COMPLETED] when the final render is done.",
      ],
      "The render message",
    );
  },
};

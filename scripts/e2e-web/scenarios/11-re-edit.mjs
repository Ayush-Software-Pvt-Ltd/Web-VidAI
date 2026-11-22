// Re-Edit with change text (SPEC section 6): the sheet takes what should change, the edit's own
// Claude Code session is resumed with the re-edit message, a new review project version appears in
// output/ and in the activity panel, and the row is Edited again.
import { expectParts, reviewFile } from "../../e2e/library.mjs";
import { outputFiles, openPanel, sessions, submitSheet } from "../jobs.mjs";
import { row, startEditing, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "re-edit",
  title: "Re-Edit resumes the session with the changes and adds a new review version",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const server = await t.startServer();
    const page = await t.open(server);
    const video = row(page, VIDEO);
    await video.waitFor();

    await startEditing(page, VIDEO);
    await status(video, "Edited", 30_000);
    t.assert((await outputFiles(t, VIDEO)).includes(reviewFile(VIDEO, 1)), "version 1 exists");

    await submitSheet(page, video, {
      button: "Re-Edit",
      field: "What should change",
      text: "Make the intro ten seconds shorter.",
      shot: () => t.shot(page, "re-edit-sheet"),
    });

    // The new version shows on the row's panel; the status goes back to Edited when it is done.
    const panel = await openPanel(page, video, VIDEO);
    await panel.getByText(reviewFile(VIDEO, 2)).first().waitFor({ timeout: 30_000 });
    await status(video, "Edited", 30_000);
    await t.shot(page, "re-edited");

    // On disk: both versions are there, and the very session of the edit was resumed with the
    // re-edit request.
    const files = await outputFiles(t, VIDEO);
    for (const name of [reviewFile(VIDEO, 1), reviewFile(VIDEO, 2)]) {
      t.assert(files.includes(name), `${name} is in output/: ${files.join(", ")}`);
    }
    const [edit, reEdit] = await sessions(t);
    t.assert(
      edit && reEdit && reEdit.mode === "resume" && reEdit.sid === edit.sid,
      "the re-edit resumed the edit's session",
    );
    expectParts(
      reEdit?.messages[0] ?? "",
      [
        "RE-EDIT REQUEST. I reviewed the edit and want these changes:",
        "Make the intro ten seconds shorter.",
        "Save a new review project version",
      ],
      "The re-edit message",
    );
    t.equal((await sessions(t)).length, 2, "Claude Code processes");
  },
};

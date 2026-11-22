// Pause Editing, then Continue Editing: the same session is resumed with `--resume` and the
// continue message, and the job completes.
import { expectParts, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "pause-continue",
  title: "Pause Editing, Continue Editing resumes the same session, then completes",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "live");
  },
  ops: {
    async checkResume(ctx) {
      const calls = await sessions(ctx);
      const [first, second] = calls;
      if (calls.length !== 2 || !first || !second) {
        throw new Error(`expected two Claude processes, got ${calls.length}`);
      }
      if (first.mode !== "new" || second.mode !== "resume" || first.sid !== second.sid) {
        throw new Error(
          `not resumed: ${first.mode} ${first.sid}, then ${second.mode} ${second.sid}`,
        );
      }
      expectParts(second.args, [`--resume ${first.sid}`], "The arguments of the continue");
      if (!first.stdin.some((l) => l.includes('"subtype":"interrupt"'))) {
        throw new Error("the pause did not interrupt Claude");
      }
      expectParts(
        second.messages[0] ?? "",
        ["Continue the video edit from where it was paused."],
        "The continue message",
      );
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await host.call("fake", { name: `started.${p.video}`, remove: true });

        await row.press("Pause Editing");
        await row.status("Paused", 20_000);
        await row.find("button", "Continue Editing");
        await row.find("button", "Stop Editing");
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text("Paused. Press Continue Editing to resume.");
        await host.shot("paused");

        await row.press("Continue Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await panel.text("Asked Claude to continue");
        await host.call("fake", { name: `release.${p.video}` });
        await row.status("Edited", 20_000);
        await host.call("checkResume");
        await host.shot("completed-after-continue");
      },
    },
  ],
};

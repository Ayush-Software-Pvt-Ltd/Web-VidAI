// Stop Editing: the confirmation, then the whole process tree of Claude is gone (also children
// in other process groups and one that ignores SIGTERM), and the row offers Start Editing again.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { seedLibrary } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "stop",
  title: "Stop Editing ends the whole process tree, the row returns to Start Editing",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "tree");
  },
  ops: {
    async treePids(ctx) {
      const text = await readFile(path.join(ctx.fake, "tree.pids"), "utf8");
      return text.split("\n").filter(Boolean).map(Number);
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: "fake/tree.ready" });
        /** @type {number[]} */
        const pids = await host.call("treePids");
        ui.equal((await host.call("fakeAlive", { pids })).length, 3, "live processes of the tree");
        // The same tree as the OS sees it: the fake Claude of the job (the process with the
        // session flag, not the model and usage helper) and everything below it.
        /** @type {import("../types.mjs").Proc[]} */
        const all = await host.call("processTree");
        const tree = all.filter((p) => p.command.includes("--session-id"));
        for (let grown = true; grown;) {
          const more = all.filter(
            (p) => !tree.includes(p) && tree.some((parent) => parent.pid === p.ppid),
          );
          tree.push(...more);
          grown = more.length > 0;
        }
        ui.assert(
          tree.length >= 3,
          `the job's process tree has ${tree.length} processes: ${JSON.stringify(all)}`,
        );
        ui.log(`the job's tree: ${tree.map((p) => `${p.pid} ${p.name}`).join(", ")}`);

        await row.press("Stop Editing");
        const confirm = await ui.dialog("Stop editing?");
        await confirm.text("working files");
        await host.shot("stop-confirmation");
        await confirm.press("Stop Editing");
        await row.status("Stopped", 20_000);
        await row.find("button", "Start Editing");
        ui.equal(await host.call("fakeAlive", { pids }), [], "processes left after Stop");
        ui.equal(
          await host.call("survivors", { procs: tree }),
          [],
          "processes of the job's tree left after Stop",
        );
        await host.shot("stopped");
      },
    },
  ],
};

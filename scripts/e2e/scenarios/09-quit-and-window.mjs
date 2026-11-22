// Quitting and the window: quit while an edit runs (confirmation, the job is paused, a relaunch
// shows it Paused and Continue works). On macOS closing the window only hides it while the edit
// goes on, the Dock icon brings it back, and quitting without running edits ends the app at once.
// On Windows closing the window quits (at once without edits, after asking while an edit runs).
import { currentInterface } from "../interface.mjs";
import { expectParts, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
const quit = {
  name: "quit-while-editing",
  title: "Quit while an edit runs: confirm, the job pauses, relaunch, Continue",
  timeout: 150_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "live");
  },
  ops: {
    async checkResumedAfterQuit(ctx) {
      const [first, second] = await sessions(ctx);
      if (!first || !second || second.mode !== "resume" || second.sid !== first.sid) {
        throw new Error("Continue after the relaunch did not resume the session");
      }
      if (!first.stdin.some((l) => l.includes('"subtype":"interrupt"'))) {
        throw new Error("quitting did not interrupt Claude");
      }
      expectParts(second.messages[0] ?? "", ["Continue the video edit"], "The continue message");
      return true;
    },
  },
  launches: [
    {
      exits: true,
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await host.call("fake", { name: `started.${p.video}`, remove: true });

        // Cmd+Q (the hook's `!quit` runs the same code as the menu item; on Windows, where
        // quitting is closing the window, the dialog says Close).
        await host.call("stdin", { line: "!quit" });
        const verb = ui.platform.quitVerb;
        const confirm = await ui.dialog(`${verb} VidAI?`);
        await confirm.text(
          "1 edit is in progress. It will be paused and you can continue it later.",
        );
        await host.shot("quit-confirmation");
        await confirm.press(`Pause and ${verb}`);
      },
    },
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.status("Paused");
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text("VidAI is quitting");
        await host.shot("paused-after-relaunch");
        await row.press("Continue Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await host.call("fake", { name: `release.${p.video}` });
        await row.status("Edited", 20_000);
        await host.call("checkResumedAfterQuit");
      },
    },
  ],
};

/** @type {import("../types.mjs").Scenario} */
const hideAndReopen = {
  name: "window-close-reopen",
  title: "Closing the window hides it, the edit goes on, the Dock icon brings it back",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "live");
  },
  launches: [
    {
      exits: true,
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });

        // The red close button (the hook closes the window the same way).
        await host.call("stdin", { line: "!close" });
        for (let i = 0; i < 40 && (await host.call("window")) !== null; i++) await ui.sleep(100);
        ui.equal(await host.call("window"), null, "the window after closing it");
        // The edit goes on while the window is hidden.
        await host.call("fake", { name: `release.${p.video}` });
        await host.call("waitFile", {
          path: `Editing/Tech Reviews/${p.video}/output/${p.video}_v1.${ui.platform.reviewExtension}`,
        });

        // A click on the Dock icon.
        await host.call("reopen");
        for (let i = 0; i < 50 && (await host.call("window")) === null; i++) await ui.sleep(100);
        ui.assert((await host.call("window")) !== null, "the window is back after a Dock click");
        await row.status("Edited", 20_000);
        await host.shot("reopened");

        // Without running edits, Quit ends the app at once.
        await host.call("stdin", { line: "!quit" });
      },
    },
  ],
};

/**
 * Windows: there is no Dock to bring a hidden window back, so closing the window (its close
 * button, Alt+F4) quits VidAI: at once without running edits, after the quit confirmation while
 * an edit runs, which pauses it; a relaunch shows it Paused and Continue goes on.
 * @type {import("../types.mjs").Scenario}
 */
const closeToQuit = {
  name: "window-close-reopen",
  title: "Closing the window quits: Alt+F4 at once without edits, the close button after asking",
  timeout: 150_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "live");
  },
  ops: { checkResumedAfterQuit: quit.ops?.checkResumedAfterQuit ?? (async () => true) },
  launches: [
    {
      exits: true,
      async page(ui, host, p) {
        await ui.row(p.video, 30_000);
        await host.shot("before-alt-f4");
        // A real Alt+F4 through the OS.
        await host.call("pressKey", { key: "F4", alt: true });
        ui.log("Alt+F4 without a running edit ends VidAI");
      },
    },
    {
      exits: true,
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await host.call("fake", { name: `started.${p.video}`, remove: true });
        // The close button (the hook closes the window the same way).
        await host.call("stdin", { line: "!close" });
        const verb = ui.platform.quitVerb;
        const confirm = await ui.dialog(`${verb} VidAI?`);
        await confirm.text("1 edit is in progress.");
        await host.shot("close-confirmation");
        await confirm.press(`Pause and ${verb}`);
      },
    },
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.status("Paused");
        await host.shot("paused-after-close");
        await row.press("Continue Editing");
        await row.status("Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await host.call("fake", { name: `release.${p.video}` });
        await row.status("Edited", 20_000);
        await host.call("checkResumedAfterQuit");
      },
    },
  ],
};

/**
 * A second launch while VidAI runs hands over to the running app (its window comes to the front)
 * and ends, so two copies never edit the same Editing Folder: once while another window covers
 * VidAI's, once while VidAI is minimized.
 * @type {import("../types.mjs").Scenario}
 */
const singleInstance = {
  name: "single-instance",
  title: "A second launch brings the running VidAI to the front (covered, minimized) and ends",
  skip: currentInterface().singleInstance
    ? null
    : "on macOS, Launch Services keeps one copy of an app; the test starts the binary directly",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  launches: [
    {
      async page(ui, host, p) {
        await ui.row(p.video, 30_000);

        // The window is open but another app's window is in front of it. The person starts
        // VidAI again from the Start menu: Explorer, the foreground process, starts the second
        // copy, which may take the foreground and hands that right to the running copy before
        // it ends. Here the runner's helper plays Explorer: its cover window is in front and it
        // starts the second copy. (A real click in the Start menu is not part of the test.)
        const cover = await host.call("cover");
        try {
          ui.assert(cover.foreground, "the helper's cover window could not come to the front");
          ui.assert(
            !(await host.native("window")).focused,
            "VidAI still has the focus under the cover window",
          );
          const second = await host.call("secondInstance", { fromForeground: true });
          ui.assert(second.exited, `the second launch did not end: ${JSON.stringify(second)}`);
          ui.assert(
            second.coverWasForeground,
            "the cover was not in front when the second copy started",
          );
          await ui.waitFor(async () => {
            const w = await host.call("window");
            return w?.foreground && (await host.native("window")).focused;
          }, "the covered VidAI to come to the front");
          ui.log(`covered: the second launch ended after ${second.ms} ms (exit ${second.code})`);
          await host.shot("in-front-of-the-cover");
        } finally {
          await host.call("uncover");
        }

        // The window is minimized, as when a person forgot VidAI is open and starts it again.
        // This second copy is started by the runner, which never has the foreground.
        await host.native("minimize");
        await ui.waitFor(async () => (await host.call("window")) === null, "a minimized window");
        const second = await host.call("secondInstance");
        ui.log(
          `after the second launch: ${JSON.stringify(await host.native("window"))}, on screen ${JSON.stringify(await host.call("window"))}`,
        );
        ui.assert(second.exited, `the second launch did not end: ${JSON.stringify(second)}`);
        const win = await ui.waitFor(async () => {
          const w = await host.native("window");
          return w.focused ? w : null;
        }, "the running VidAI to come to the front");
        ui.log(
          `the second launch ended after ${second.ms} ms (exit ${second.code}), focused ${win.focused}`,
        );
        await host.shot("after-second-launch");
        await ui.row(p.video);
      },
    },
  ],
};

export default [
  quit,
  currentInterface().closeWindow === "hides" ? hideAndReopen : closeToQuit,
  singleInstance,
];

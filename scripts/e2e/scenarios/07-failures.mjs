// Failure paths: Claude finishes without output (Needs attention, Continue works; jobs keep
// themselves going, so a model that only talks is stuck), the usage
// limit (a readable error), a lost Claude Code login (the not-ready flow), and the concurrency
// limit (the second video waits in the queue and starts after the first).
import { expectParts, keepsJobsGoing, seedLibrary, sessions } from "../library.mjs";

const NO_OUTPUT = "001 No Output";
const LIMIT = "002 Usage Limit";
const LOGOUT = "003 Logged Out";

/** @type {import("../types.mjs").Scenario} */
const failures = {
  name: "failures",
  title: "No output, usage limit, logged out: readable errors and recovery",
  timeout: 180_000,
  async prepare(ctx) {
    await seedLibrary(
      ctx,
      [
        [NO_OUTPUT, "landscape"],
        [LIMIT, "landscape"],
        [LOGOUT, "landscape"],
      ],
      {
        // The usage limit resets in two hours; without this it would be retried (section 6).
        maxModelRetries: 0,
      },
    );
    Object.assign(ctx.params, {
      noOutput: NO_OUTPUT,
      limit: LIMIT,
      logout: LOGOUT,
      // SPEC section 6, "Keeping a job going": a model that answers without doing anything is
      // asked to go on, and stuck after three such turns.
      noOutputError: keepsJobsGoing()
        ? "The model stopped working on the edit: it ended 3 turns in a row without doing anything."
        : "Claude finished without creating a review project.",
    });
    await ctx.fakeSet(`scenario.${NO_OUTPUT}`, "no_output");
    await ctx.fakeSet(`scenario.${LIMIT}`, "usage_limit");
  },
  ops: {
    async checkContinueAfterFailure(ctx) {
      const calls = (await sessions(ctx)).filter(
        (c) => c.messages.some((m) => m.includes(NO_OUTPUT)) || c.mode === "resume",
      );
      const resumed = calls.find((c) => c.mode === "resume");
      if (!resumed) throw new Error("Continue Editing did not resume the session");
      expectParts(
        resumed.messages[0] ?? "",
        ["Continue the video edit from where it was paused.", "review project"],
        "The continue-after-failure message",
      );
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        // Claude ends without a review project.
        const noOutput = await ui.row(p.noOutput, 30_000);
        await noOutput.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await noOutput.status("Needs attention", 40_000);
        await noOutput.text(p.noOutputError);
        await noOutput.find("button", "Start Editing");
        await host.shot("no-output");
        await noOutput.press("Continue Editing");
        await noOutput.status("Edited", 20_000);
        await host.call("checkContinueAfterFailure");

        // The usage limit.
        const limit = await ui.row(p.limit);
        await limit.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await limit.status("Needs attention", 20_000);
        await limit.text(/Claude usage limit reached, resets (at|on) /);
        await host.shot("usage-limit");

        // Claude Code logs out while VidAI runs.
        await host.call("fake", { name: "logged_out" });
        const logout = await ui.row(p.logout);
        await logout.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await logout.status("Needs attention", 20_000);
        await logout.text("Claude Code is logged out.");
        await host.shot("logged-out-job");
        await logout.press("Continue Editing");
        await ui.text("Log in to Claude Code");
        await ui.find("button", "Log In");
        await host.shot("not-ready-flow");
        await host.call("fake", { name: "logged_out", remove: true });
        await ui.press("Check Again");
        const back = await ui.row(p.logout, 15_000);
        await back.status("Needs attention");
        await back.press("Continue Editing");
        await back.status("Edited", 20_000);
      },
    },
  ],
};

const QUEUED_FIRST = "001 First";
const QUEUED_SECOND = "002 Second";

/** @type {import("../types.mjs").Scenario} */
const concurrency = {
  name: "failures-concurrency",
  title: "Concurrency limit 1: the second video is Queued and starts after the first",
  async prepare(ctx) {
    await seedLibrary(
      ctx,
      [
        [QUEUED_FIRST, "landscape"],
        [QUEUED_SECOND, "landscape"],
      ],
      { maxConcurrentEdits: 1 },
    );
    Object.assign(ctx.params, { first: QUEUED_FIRST, second: QUEUED_SECOND });
    await ctx.fakeSet("scenario", "live");
  },
  launches: [
    {
      async page(ui, host, p) {
        const first = await ui.row(p.first, 30_000);
        const second = await ui.row(p.second);
        await first.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await first.status("Editing");
        await second.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await second.status("Queued");
        await second.find("button", "Stop Editing");
        await ui.text("1 editing, 1 queued");
        await host.shot("queued");
        await host.call("waitFile", { path: `fake/started.${p.first}` });
        await ui.sleep(500);
        ui.equal(
          await host.call("exists", { path: `fake/started.${p.second}` }),
          false,
          "second started early",
        );

        await host.call("fake", { name: `release.${p.first}` });
        await first.status("Edited", 20_000);
        await second.status("Editing", 10_000);
        await host.call("waitFile", { path: `fake/started.${p.second}` });
        await host.call("fake", { name: `release.${p.second}` });
        await second.status("Edited", 20_000);
      },
    },
  ],
};

export default [failures, concurrency];

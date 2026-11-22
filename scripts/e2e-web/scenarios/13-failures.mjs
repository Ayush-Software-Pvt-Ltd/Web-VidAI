// Failure paths in the browser: Claude finishes without output (Needs attention with a readable
// reason, Continue Editing works; jobs keep themselves going, so a model that only talks is stuck
// after three turns), the usage limit (a readable error), and a lost Claude Code login (the
// not-ready flow, then back to work after Check Again).
import { expectParts } from "../../e2e/library.mjs";
import { sessions } from "../jobs.mjs";
import { row, startEditing, status } from "../ui.mjs";

const NO_OUTPUT = "001 No Output";
const LIMIT = "002 Usage Limit";
const LOGOUT = "003 Logged Out";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "failures",
  title: "No output, usage limit, logged out: readable errors and recovery",
  timeout: 180_000,
  async run(t) {
    await t.seedLibrary(
      [
        [NO_OUTPUT, "landscape"],
        [LIMIT, "landscape"],
        [LOGOUT, "landscape"],
      ],
      // The usage limit resets in two hours; without this it would be retried (section 6).
      { maxModelRetries: 0 },
    );
    await t.fakeSet(`scenario.${NO_OUTPUT}`, "no_output");
    await t.fakeSet(`scenario.${LIMIT}`, "usage_limit");
    const server = await t.startServer();
    const page = await t.open(server);

    // Claude ends without a review project (SPEC section 6, Keeping a job going: it is asked to go
    // on and stuck after three such turns).
    const noOutput = row(page, NO_OUTPUT);
    await noOutput.waitFor();
    await startEditing(page, NO_OUTPUT);
    await status(noOutput, "Needs attention", 40_000);
    await noOutput
      .getByText(
        "The model stopped working on the edit: it ended 3 turns in a row without doing anything.",
      )
      .waitFor();
    await noOutput.getByRole("button", { name: "Start Editing" }).waitFor();
    await t.shot(page, "no-output");
    await noOutput.getByRole("button", { name: "Continue Editing" }).click();
    await status(noOutput, "Edited", 30_000);
    const resumed = (await sessions(t)).find((c) => c.mode === "resume");
    t.assert(resumed, "Continue Editing resumed the session");
    expectParts(
      resumed?.messages[0] ?? "",
      ["Continue the video edit from where it was paused.", "review project"],
      "The continue-after-failure message",
    );

    // The usage limit says when it resets.
    const limit = row(page, LIMIT);
    await startEditing(page, LIMIT);
    await status(limit, "Needs attention", 30_000);
    await limit.getByText(/Claude usage limit reached, resets (at|on) /).waitFor();
    await t.shot(page, "usage-limit");

    // Claude Code logs out while VidAI runs: the job says so, and Continue Editing leads to the
    // card that says what to do (nothing here opens a Terminal: the button is only looked at).
    await t.fakeSet("logged_out");
    const logout = row(page, LOGOUT);
    await startEditing(page, LOGOUT);
    await status(logout, "Needs attention", 30_000);
    await logout.getByText("Claude Code is logged out.").waitFor();
    await t.shot(page, "logged-out-job");
    // The core refuses the continue with its not-ready error (a 400 of the command, SPEC section
    // 12, Routes), which the browser logs like any failed request.
    t.allowFailure(/api\/invoke\/continue_job/);
    await logout.getByRole("button", { name: "Continue Editing" }).click();
    await page.getByText("Log in to Claude Code").first().waitFor();
    await page.getByRole("button", { name: "Log In" }).waitFor();
    await t.shot(page, "not-ready-flow");

    // Logged in again: Check Again brings the library back, and the job can go on.
    await t.fakeRemove("logged_out");
    await page.getByRole("button", { name: "Check Again" }).click();
    await logout.waitFor({ timeout: 15_000 });
    await status(logout, "Needs attention");
    await logout.getByRole("button", { name: "Continue Editing" }).click();
    await status(logout, "Edited", 30_000);
  },
};

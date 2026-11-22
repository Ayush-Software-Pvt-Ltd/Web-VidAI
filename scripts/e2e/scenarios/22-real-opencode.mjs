// Smoke test with the real installed OpenCode 2 program (`npm run e2e -- --real real-opencode`,
// never part of the default run, Macs only): proves VidAI drives the real `opencode2
// serve` correctly through the real app. Edits run on OpenCode's pay-as-you-go address with its
// free model big-pickle, in the OpenCode 2 program. VidAI's key store is the in-memory test store,
// so the key saved here is a stand-in that never reaches OpenCode: the debug-only switch
// VIDAI_E2E_OPENCODE_LOGIN (see `opencode::harness::launch2::TEST_LOGIN_VAR`) starts the servers
// without VidAI's key, on OpenCode's public free tier (`public`, which ignores the stored logins
// without reading them) or on the program's own login (`own`). One trivial edit goes through a
// command that is paused in the middle, Continue in the same session, and completion with a
// review file. The OpenCode sessions it made are deleted afterwards.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentInterface } from "../interface.mjs";
import {
  CHANNEL,
  CHANNEL_ID,
  SETUP_LABEL,
  apiOptions,
  outputFiles,
  seedLibrary,
} from "../library.mjs";

const VIDEO = "001 OpenCode Smoke";
const ADDRESS = "https://opencode.ai/inference/anthropic";
const MODEL = "big-pickle";
const LOGIN = process.env.VIDAI_E2E_OPENCODE_LOGIN ?? "public";

const PROMPT = `This is an automated test of the VidAI app, not a real video edit. Do exactly these steps and nothing else: 1. Write a short message whose only content is the line [VIDAI_PROGRESS inspected]. 2. Run the shell command \`sleep 20\` with the bash tool and a timeout of 60000 milliseconds. 3. Create the folder "output" inside MAIN_FOLDER (inside CHANNEL_FOLDER) if it is missing. 4. Write a minimal valid FCPXML 1.11 document (an empty project, no media) to output/<MAIN_FOLDER>_review_v1.fcpxml, unless that file already exists. 5. Write [OUTPUT COMPLETED] in your last message. Do not read MEMORY.md, do not transcribe, do not run ffmpeg, do not start sub-agents.`;

/** The real `opencode2` the app finds, for deleting the test sessions. */
function opencodeBin() {
  const home = process.env.HOME ?? "";
  for (const candidate of [
    path.join(home, ".opencode/bin/opencode2"),
    "/opt/homebrew/bin/opencode2",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "opencode2";
}

/** @param {import("../types.mjs").Context} ctx */
async function savedJob(ctx) {
  const state = JSON.parse(await readFile(path.join(ctx.data, "state.json"), "utf8"));
  return state.videos?.[`${CHANNEL_ID}/${VIDEO}`]?.latestJob ?? null;
}

/** @param {import("../types.mjs").Context} ctx */
async function logEntries(ctx) {
  const dir = path.join(ctx.data, "logs");
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".jsonl")) : [];
  const entries = [];
  for (const file of files) {
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (line) entries.push(JSON.parse(line));
    }
  }
  return entries;
}

/** Session ids of OpenCode this scenario made, to delete afterwards. */
const made = new Set();

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "real-opencode",
  title:
    "The real OpenCode 2 program (big-pickle): start, pause in a command, continue, completion",
  real: true,
  skip:
    currentInterface().os !== "macos"
      ? "The OpenCode 2 program exists on Macs only (SPEC section 11, OpenCode on Windows)"
      : null,
  timeout: 20 * 60_000,
  env: { VIDAI_E2E_OPENCODE_LOGIN: LOGIN },
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]], {
      // The OpenCode Go setup (OpenCode 2 program); VIDAI_E2E_OPENCODE_LOGIN decides whose login
      // the real program uses (`public` models need no key, `own` is the user's own login).
      setup: "opencodeGo",
      apiOptions: apiOptions({ opencodeGo: { baseUrl: ADDRESS, model: MODEL } }),
    });
    const file = path.join(ctx.data, "settings.json");
    const settings = JSON.parse(await readFile(file, "utf8"));
    settings.channels[0].long.prompts[0].text = PROMPT;
    await writeFile(file, JSON.stringify(settings, null, 2));
    // The model list of the address, as if it was fetched once.
    await writeFile(
      path.join(ctx.data, "state.json"),
      JSON.stringify({
        schemaVersion: 9,
        apiModels: {
          opencodeGo: {
            option: "opencodeGo",
            baseUrl: ADDRESS,
            models: [{ id: MODEL, displayName: "Big Pickle" }],
            fetchedAt: new Date().toISOString(),
          },
        },
      }),
    );
    ctx.params.video = VIDEO;
    ctx.params.setup = SETUP_LABEL;
  },
  async cleanup(ctx) {
    const job = await savedJob(ctx).catch(() => null);
    if (job?.sessionId) made.add(job.sessionId);
    for (const id of made) {
      try {
        execFileSync(opencodeBin(), ["session", "delete", id], {
          cwd: ctx.editing,
          env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
          stdio: "ignore",
          timeout: 60_000,
        });
        console.log(`      deleted the OpenCode session ${id}`);
      } catch (error) {
        console.log(`      could not delete the OpenCode session ${id}: ${error}`);
      }
    }
    made.clear();
  },
  ops: {
    /** Waits until the model runs `sleep 20`. */
    async sleeping(ctx) {
      const deadline = Date.now() + 8 * 60_000;
      for (;;) {
        const job = await savedJob(ctx);
        if (job?.sessionId) made.add(job.sessionId);
        const entries = await logEntries(ctx);
        if (
          entries.some(
            (e) => e.kind === "tool" && `${e.text}\n${e.detail ?? ""}`.includes("sleep 20"),
          )
        ) {
          return true;
        }
        const failed = entries.find((e) => e.kind === "error");
        if (failed) throw new Error(`the job failed: ${failed.text}`);
        if (Date.now() > deadline) throw new Error("the model never ran sleep 20");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    async check(ctx) {
      const job = await savedJob(ctx);
      if (job?.harness !== "opencode2") throw new Error(`the job ran in ${job?.harness}`);
      if (!job.sessionId?.startsWith("ses_")) throw new Error(`the session is ${job.sessionId}`);
      const files = await outputFiles(ctx, VIDEO);
      if (!files.some((f) => f.endsWith(".fcpxml"))) throw new Error(`no review file: ${files}`);
      const texts = (await logEntries(ctx)).map((e) => e.text);
      for (const want of ["Started a new OpenCode 2 session", "Resumed the OpenCode 2 session"]) {
        if (!texts.some((t) => t.startsWith(want))) throw new Error(`the log has no ${want}`);
      }
      if (!texts.includes("Footage inspected")) throw new Error("the progress marker was not seen");
      console.log(`      ${CHANNEL}/${VIDEO}: ${files.join(", ")}, session ${job.sessionId}`);
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        // The stand-in key: VidAI asks for one before OpenCode can run edits.
        await ui.row(p.video, 30_000);
        await ui.shortcut(",");
        await ui
          .within(await ui.find("navigation", "Settings"))
          .click("button", "Harness + API Keys");
        const label = p.setup.opencodeGo;
        await ui.press(`Configure ${label}`);
        const form = ui.within(await ui.find("group", `Settings of ${label}`));
        await form.fill("API Key", "oc_sk_e2e_stand_in_not_used");
        await form.press("Save");
        await ui.text("API key saved", 20_000);
        await ui.press("Done");

        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await host.call("sleeping");
        await row.press("Pause Editing");
        await row.status("Paused", 60_000);
        await host.shot("real-opencode-paused");
        await row.press("Continue Editing");
        await row.status("Edited", 10 * 60_000);
        await host.shot("real-opencode-edited");
        await host.call("check");
      },
    },
  ],
};

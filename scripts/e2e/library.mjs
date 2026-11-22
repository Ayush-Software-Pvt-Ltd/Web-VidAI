// Shared setup for the scenarios that start from a library that is already set up (the
// onboarding itself is covered by the first-run scenario).
import { readdir } from "node:fs/promises";
import path from "node:path";
import { currentInterface } from "./interface.mjs";

export const CHANNEL = "Tech Reviews";
export const CHANNEL_ID = "chan-tech";
export const LONG_PROMPT = "CHANNEL LONG PROMPT: cut the pauses and keep the energy high.";
export const SHORT_PROMPT = "CHANNEL SHORT PROMPT: one hook in the first second.";
export const LONG_STYLE = "Yellow captions, bold font.";

/**
 * One channel with the given videos, set up as if onboarding was done.
 * @param {import("./types.mjs").Context} ctx
 * @param {Array<[string, "landscape" | "portrait" | "rotated"]>} videos
 * @param {Record<string, unknown>} [settings] more settings fields
 */
export async function seedLibrary(ctx, videos, settings = {}) {
  for (const [folder, media] of videos) await ctx.video(CHANNEL, folder, media);
  await ctx.seedSettings({
    channels: [
      {
        id: CHANNEL_ID,
        folderName: CHANNEL,
        videoType: "auto",
        long: profile(LONG_PROMPT, LONG_STYLE),
        short: profile(SHORT_PROMPT, ""),
      },
    ],
    ...settings,
  });
}

/**
 * A channel profile with five prompt and five style slots, slot 0 holding these texts.
 * @param {string} prompt @param {string} style
 */
function profile(prompt, style) {
  const slots = (/** @type {string} */ label, /** @type {string} */ text) =>
    [0, 1, 2, 3, 4].map((i) => ({
      name: i === 0 ? "Default" : `${label} ${i + 1}`,
      text: i === 0 ? text : "",
    }));
  return { prompts: slots("Prompt", prompt), styles: slots("Style", style) };
}

/**
 * The name of version `n` of a video's review project, as the fake Claude Code saves it for the
 * platform's review software.
 * @param {string} folder @param {number} n
 */
export function reviewFile(folder, n) {
  return `${folder}_v${n}.${currentInterface().reviewExtension}`;
}

/**
 * The output folder listing of a video (empty when missing).
 * @param {import("./types.mjs").Context} ctx @param {string} folder
 * @returns {Promise<string[]>}
 */
export async function outputFiles(ctx, folder) {
  return readdir(path.join(ctx.editing, CHANNEL, folder, "output")).catch(() => []);
}

/**
 * Throws unless `text` contains every part, naming the first one missing.
 * @param {string} text @param {string[]} parts @param {string} what
 */
export function expectParts(text, parts, what) {
  for (const part of parts) {
    if (!text.includes(part)) {
      throw new Error(`${what} does not contain ${JSON.stringify(part)}:\n${text}`);
    }
  }
}

/**
 * Whether a path the fake Claude printed (`$PWD`) is the folder `native`. On Windows the fake
 * runs in Git Bash, which prints `C:\Users\x` as `/c/Users/x`, and Windows ignores letter case.
 * @param {string} printed @param {string} native
 */
export function samePath(printed, native) {
  if (process.platform !== "win32") return printed === native;
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(printed);
  const windows = drive ? `${drive[1]}:\\${printed.slice(3)}` : printed;
  const norm = (/** @type {string} */ p) =>
    path.win32
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return norm(windows) === norm(native);
}

/**
 * The fake Claude calls that worked on a session (not the control helper), in order.
 * @param {import("./types.mjs").Context} ctx
 */
export async function sessions(ctx) {
  return (await ctx.fakeCalls()).filter((c) => c.sid !== "");
}

/**
 * Whether jobs keep themselves going when a turn ends early (SPEC section 6, "Keeping a job
 * going"): on every platform VidAI runs on (`opencode::keeps_jobs_going`).
 */
export function keepsJobsGoing() {
  return process.platform === "darwin" || process.platform === "win32";
}

/** The four setups as Settings and the onboarding label them (`SETUP_INFO` in src/lib/setup.ts). */
export const SETUP_LABEL = {
  claudeSubscription: "Claude Code with Claude Subscription",
  opencodeGo: "OpenCode 2 with OpenCode Go Subscription",
  anthropicApi: "Claude Code with Anthropic Compatible API",
  openaiApi: "OpenCode 2 with OpenAI Compatible API",
};

/**
 * Settings of the API options as the seeded `settings.json` stores them: the address of each
 * (`null` is the default), no model chosen, no efforts. The keys are only in the keychain
 * (`VIDAI_SECRETS=memory` in the end-to-end runs), so a scenario saves its key through the UI.
 * @param {Partial<Record<"opencodeGo" | "anthropicApi" | "openaiApi", { baseUrl: string | null, model?: string | null }>>} [options]
 */
export function apiOptions(options = {}) {
  const empty = () => ({ baseUrl: null, model: null, efforts: {} });
  return {
    opencodeGo: { ...empty(), ...options.opencodeGo },
    anthropicApi: { ...empty(), ...options.anthropicApi },
    openaiApi: { ...empty(), ...options.openaiApi },
  };
}

/**
 * Page steps shared by the scenarios of the API setups (`shared: HARNESS_UI`; they run in the
 * page, so each one is self-contained). `onboardOption` goes through the onboarding card that a
 * blocked setup shows; `selectSetup` chooses the radio card in Settings, Harness + API Keys and
 * waits for its toast.
 */
export const HARNESS_UI = {
  /**
   * The onboarding (something blocks the stored setup, so the window shows the card of that
   * problem, SPEC section 9): Back to the choice of options, the radio card, Continue, then the
   * card of the API option with its key saved (a `null` key saves none: options 3 and 4 need no key) and its model given, and its Continue. OpenCode
   * Go's model is chosen from its list (GLM-5.3); the other two options take a typed id, so
   * `typedModel` types it into the Model box and saves it with Return. The window is the main one
   * afterwards when nothing else blocks.
   */
  async onboardOption(
    /** @type {any} */ ui,
    /** @type {string} */ label,
    /** @type {string | null} */ key,
    /** @type {string | null} */ typedModel = null,
  ) {
    await ui.waitFor(
      () => ui.has("radiogroup", "How should VidAI run edits?") || ui.has("button", "Back"),
      "an onboarding card",
      30_000,
    );
    if (!ui.has("radiogroup", "How should VidAI run edits?")) await ui.press("Back");
    await ui.click("radio", label);
    await ui.press("Continue");
    // Options 3 and 4 label the field "API Key (optional)"; a `null` key leaves it empty.
    if (key !== null) {
      await ui.fill(/^API Key/, key);
      await ui.press("Save");
      await ui.text("API key saved", 20_000);
    }
    if (typedModel === null) {
      await ui.click("button", "Model");
      const picker = ui.within(await ui.find("dialog", "Models"));
      await picker.click("option", "GLM-5.3 (glm-5.3)", 15_000);
    } else {
      await ui.fill("Model", typedModel);
      await ui.key("Enter");
    }
    await ui.press("Continue");
  },
  async selectSetup(/** @type {any} */ ui, /** @type {string} */ label) {
    await ui.click("radio", label);
    await ui.text("New edits run with", 20_000);
  },
};

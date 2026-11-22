// Helpers of the scenarios 20 to 29 (settings, the file picker, the API setups, the missing
// programs): page steps, reading the fakes' records, and the second process of a data directory.
// The shared files (ui.mjs, world.mjs ...) stay as they are.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** A program that is not installed: the override points at nothing, so it is the only candidate. */
export const NOT_INSTALLED = "/nonexistent/e2e-web-not-installed";

/**
 * Runs `body` and always stops the stand-in gateway afterwards (it is one per process, shared by
 * the scenarios that run one after the other).
 * @template T
 * @param {() => Promise<T>} body @param {() => Promise<void>} stop
 */
export async function withCleanup(body, stop) {
  try {
    return await body();
  } finally {
    await stop();
  }
}

/** The text of the settings file on disk. @param {import("./types.mjs").Test} t */
export async function settingsOnDisk(t) {
  return JSON.parse(await readFile(path.join(t.data, "settings.json"), "utf8"));
}

/** The text of every line of every saved job log. @param {import("./types.mjs").Test} t */
export async function savedLog(t) {
  const dir = path.join(t.data, "logs");
  /** @type {string[]} */
  const texts = [];
  for (const file of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (line) texts.push(JSON.parse(line).text);
    }
  }
  return texts;
}

/**
 * The fake Claude Code processes that worked on a session, with the variables the fake recorded
 * (`ANTHROPIC_*`, `<unset>` when a variable was not set), oldest first.
 * @param {import("./types.mjs").Test} t
 * @returns {Promise<Array<import("../e2e/types.mjs").FakeCall & { env: Record<string, string> }>>}
 */
export async function claudeSessions(t) {
  const calls = (await t.fakeCalls()).filter((c) => c.sid !== "");
  return Promise.all(
    calls.map(async (call) => {
      /** @type {Record<string, string>} */
      const env = {};
      const info = await readFile(path.join(t.fake, `call.${call.pid}`), "utf8").catch(() => "");
      for (const line of info.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
      }
      return { ...call, env };
    }),
  );
}

/**
 * The servers of the fake OpenCode 2 program, oldest first, as `key=value` maps.
 * @param {import("./types.mjs").Test} t
 * @returns {Promise<Array<Record<string, string>>>}
 */
export async function opencodeServers(t) {
  const file = path.join(t.fake, "opencode2.calls");
  if (!existsSync(file)) return [];
  const pids = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  return Promise.all(
    pids.map(async (pid) => {
      /** @type {Record<string, string>} */
      const fields = { pid };
      for (const line of (await readFile(path.join(t.fake, `call.${pid}`), "utf8")).split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
      }
      return fields;
    }),
  );
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

// ---------------------------------------------------------------------------------------------
// Page steps
// ---------------------------------------------------------------------------------------------

/** The four setups as Settings and the onboarding label them (`SETUP_INFO` in src/lib/setup.ts). */
export const SETUP_LABEL = {
  claudeSubscription: "Claude Code with Claude Subscription",
  opencodeGo: "OpenCode 2 with OpenCode Go Subscription",
  anthropicApi: "Claude Code with Anthropic Compatible API",
  openaiApi: "OpenCode 2 with OpenAI Compatible API",
};

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Opens Settings from the sidebar and (optionally) a section of its navigation.
 * @param {import("playwright").Page} page @param {string} [section]
 */
export async function openSettings(page, section) {
  await page
    .getByRole("button", { name: /^Settings/ })
    .first()
    .click();
  const nav = page.getByRole("navigation", { name: "Settings" });
  await nav.waitFor({ timeout: 20_000 });
  if (section)
    await nav.getByRole("button", { name: new RegExp(`^${escapeRegExp(section)}`) }).click();
  return nav;
}

/**
 * Waits until nothing is unsaved: a Save button is disabled while it saves too, so the change is
 * saved once every Save is disabled and "Unsaved changes" is gone.
 * @param {import("playwright").Page} page @param {import("./types.mjs").Test} t @param {string} what
 */
export async function waitSaved(page, t, what) {
  await t.waitFor(
    async () => {
      const disabled = await page
        .getByRole("button", { name: "Save", exact: true })
        .evaluateAll((buttons) =>
          buttons.every((b) => /** @type {{ disabled: boolean }} */ (b).disabled),
        );
      return disabled && (await page.getByText("Unsaved changes").count()) === 0;
    },
    what,
    20_000,
  );
}

/**
 * The onboarding card that a blocked setup shows: back to the choice of options, the radio card,
 * Continue, the card of the API option with its key saved (a `null` key saves none) and its
 * model given. OpenCode Go's model is chosen from its list (GLM-5.3); the other two options take
 * a typed id.
 * @param {import("playwright").Page} page @param {string} label @param {string | null} key
 * @param {string | null} [typedModel]
 */
export async function onboardOption(page, label, key, typedModel = null) {
  const choice = page.getByRole("radiogroup", { name: "How should VidAI run edits?" });
  const back = page.getByRole("button", { name: "Back", exact: true });
  await choice.or(back).first().waitFor({ timeout: 30_000 });
  if (!(await choice.isVisible())) await back.click();
  await page.getByRole("radio", { name: new RegExp(`^${escapeRegExp(label)}`) }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  if (key !== null) {
    await page.getByRole("textbox", { name: /^API Key/ }).fill(key);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("API key saved").first().waitFor({ timeout: 20_000 });
  }
  if (typedModel === null) {
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const list = page.getByRole("dialog", { name: "Models" });
    await list.getByRole("option", { name: "GLM-5.3 (glm-5.3)" }).click({ timeout: 15_000 });
  } else {
    await page.getByRole("textbox", { name: "Model", exact: true }).fill(typedModel);
    await page.keyboard.press("Enter");
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

// ---------------------------------------------------------------------------------------------
// The file picker (SPEC section 12, What runs where)
// ---------------------------------------------------------------------------------------------

/**
 * The picker dialog of a request, once it is open.
 * @param {import("playwright").Page} page @param {string} title
 */
export async function picker(page, title) {
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.waitFor({ timeout: 20_000 });
  await dialog.getByRole("navigation", { name: "Places" }).waitFor();
  return dialog;
}

/**
 * Goes to a path by typing it in the path field (Go to Folder) and pressing Enter.
 * @param {import("playwright").Page} page @param {import("playwright").Locator} dialog @param {string} target
 */
export async function typePath(page, dialog, target) {
  await dialog.getByRole("button", { name: /^(Go to Folder|Type a path)$/ }).click();
  await dialog.getByRole("textbox", { name: "Path" }).fill(target);
  await page.keyboard.press("Enter");
}

/**
 * The names of the entries the dialog lists now (the list shows only the rows in view, which is
 * everything for the small folders of the tests).
 * @param {import("playwright").Locator} dialog @returns {Promise<string[]>}
 */
export function listed(dialog) {
  return dialog
    .getByRole("listbox")
    .getByRole("option")
    .evaluateAll((options) => options.map((o) => o.getAttribute("title") ?? ""));
}

// ---------------------------------------------------------------------------------------------
// A second `vidai-web` for a running one's data directory
// ---------------------------------------------------------------------------------------------

/**
 * Runs `vidai-web` once more on the data directory of a running server, like a user who starts it
 * a second time, and waits for it to end.
 * @param {import("./types.mjs").Server} first the running server (its program is run again)
 * @param {string} data the data directory
 * @returns {Promise<{ code: number | null, stdout: string[], stderr: string[] }>}
 */
export async function startSecond(first, data) {
  const binary = /** @type {string} */ (/** @type {any} */ (first.child).spawnfile);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("VIDAI_")) delete env[name];
  Object.assign(env, {
    VIDAI_DATA_DIR: data,
    VIDAI_SECRETS: "memory",
    VIDAI_WEB_NO_BROWSER: "1",
    SHELL: "/bin/sh",
  });
  const child = spawn(binary, ["--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(...String(chunk).split("\n").filter(Boolean)));
  child.stderr.on("data", (chunk) => stderr.push(...String(chunk).split("\n").filter(Boolean)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
  });
  clearTimeout(timer);
  return { code: /** @type {number | null} */ (code), stdout, stderr };
}

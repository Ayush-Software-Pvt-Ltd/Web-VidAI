// Helpers of the job scenarios (re-edit, render, failures, progress, keep going, start delay, the
// real Claude Code): the facts about jobs on disk, the progress bar and the sheets a user fills in.
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNEL, CHANNEL_ID } from "../e2e/library.mjs";
import { activity, pill } from "./ui.mjs";

const execFile = promisify(execFileCb);

/**
 * The fake Claude Code processes that worked on a session (not the control helper), in order.
 * @param {import("./types.mjs").Test} t
 */
export async function sessions(t) {
  return (await t.fakeCalls()).filter((c) => c.sid !== "");
}

/**
 * The files in a video's output folder (empty when it is missing).
 * @param {import("./types.mjs").Test} t @param {string} folder @returns {Promise<string[]>}
 */
export function outputFiles(t, folder) {
  return readdir(path.join(t.editing, CHANNEL, folder, "output")).catch(() => []);
}

/**
 * The saved latest job of a video (`state.json`): its state, session and times in ms since the
 * epoch (`null` for a time that is not set).
 * @param {import("./types.mjs").Test} t @param {string} video
 */
export async function savedJob(t, video) {
  const state = JSON.parse(await readFile(path.join(t.data, "state.json"), "utf8"));
  const job = state.videos?.[`${CHANNEL_ID}/${video}`]?.latestJob;
  if (!job) throw new Error(`${video} has no saved job`);
  const ms = (/** @type {string | null | undefined} */ time) => (time ? Date.parse(time) : null);
  return {
    state: /** @type {string} */ (job.state),
    sessionId: /** @type {string | null} */ (job.sessionId ?? null),
    startedAt: ms(job.startedAt),
    startsAt: ms(job.startsAt),
  };
}

/**
 * The lines of the job logs saved on disk (`<data>/logs/*.jsonl`), every job together.
 * @param {import("./types.mjs").Test} t
 * @returns {Promise<Array<{ kind: string, text: string }>>}
 */
export async function savedLogs(t) {
  const dir = path.join(t.data, "logs");
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
  /** @type {Array<{ kind: string, text: string }>} */
  const entries = [];
  for (const file of files) {
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (line) entries.push(JSON.parse(line));
    }
  }
  return entries;
}

/**
 * The value (0 to 100) of the first progress bar inside `scope`, NaN while there is none.
 * @param {import("playwright").Locator} scope
 */
export async function barValue(scope) {
  const bar = scope.getByRole("progressbar").first();
  if ((await bar.count()) === 0) return NaN;
  const value = await bar.getAttribute("aria-valuenow", { timeout: 1000 }).catch(() => null);
  return value === null ? NaN : Number(value);
}

/**
 * The spoken text of the first progress bar inside `scope` ("40%, paused"), empty without a bar.
 * @param {import("playwright").Locator} scope
 */
export async function barText(scope) {
  const bar = scope.getByRole("progressbar").first();
  if ((await bar.count()) === 0) return "";
  return (await bar.getAttribute("aria-valuetext", { timeout: 1000 }).catch(() => null)) ?? "";
}

/**
 * Waits until the first progress bar in `scope` shows `atLeast` or more, and returns its value.
 * @param {import("./types.mjs").Test} t @param {import("playwright").Locator} scope
 * @param {number} atLeast @param {string} what @param {number} [timeout]
 */
export function waitBar(t, scope, atLeast, what, timeout = 20_000) {
  return t.waitFor(
    async () => {
      const value = await barValue(scope);
      return value >= atLeast ? value : 0;
    },
    `the ${what} at ${atLeast}% or more`,
    timeout,
  );
}

/**
 * Opens a video's activity panel by clicking its name, as a user does.
 * @param {import("playwright").Page} page @param {import("playwright").Locator} row
 * @param {string} video
 */
export async function openPanel(page, row, video) {
  await row.getByRole("button", { name: video, exact: true }).click();
  const panel = activity(page);
  await panel.waitFor();
  return panel;
}

/**
 * The text of a row's status pill, empty when it shows none.
 * @param {import("playwright").Locator} row
 */
export async function currentStatus(row) {
  return (
    (await pill(row)
      .textContent({ timeout: 1000 })
      .catch(() => "")) ?? ""
  ).trim();
}

/**
 * Fills a sheet that has one text field (Re-Edit: "What should change", Render Final 4K: "Notes")
 * and confirms it with the sheet's own button.
 * @param {import("playwright").Page} page @param {import("playwright").Locator} row
 * @param {{ button: string, field: string, text: string, shot?: () => Promise<unknown> }} options
 */
export async function submitSheet(page, row, { button, field, text, shot }) {
  await row.getByRole("button", { name: button }).click();
  const sheet = page.getByRole("dialog", { name: button });
  await sheet.getByLabel(field).fill(text);
  if (shot) await shot();
  await sheet.getByRole("button", { name: button }).click();
  await sheet.waitFor({ state: "detached" });
}

/**
 * The real Claude Code of this computer (`command -v claude` in a login shell, else
 * `~/.local/bin/claude`), as the desktop suite finds it.
 * @returns {Promise<string>}
 */
export async function realClaude() {
  const found = await execFile("/bin/sh", ["-lc", "command -v claude"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  if (found) return found;
  const local = path.join(process.env["HOME"] ?? "", ".local/bin/claude");
  if (existsSync(local)) return local;
  throw new Error("the real Claude Code (`claude`) was not found");
}

/**
 * What a browser sends when the person comes back to the tab: it was hidden, becomes visible and
 * the window gets focus (a headless browser has no window focus to give back). The page rescans
 * the library on it, at most every 2 s (`RESCAN_THROTTLE_MS`), so callers repeat it inside a wait.
 * @param {import("playwright").Page} page
 */
export function returnToTab(page) {
  return page.evaluate(() => {
    /** @type {any} */
    const w = globalThis;
    w.dispatchEvent(new w.Event("blur"));
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    w.dispatchEvent(new w.Event("focus"));
  });
}

/**
 * Checks that do not stop a scenario at the first failure: the rest of the scenario still runs and
 * `done()` fails it with every problem found. For a defect that must not hide what comes after.
 */
export function softChecks() {
  /** @type {string[]} */
  const problems = [];
  return {
    /** @param {unknown} condition @param {string} message */
    check(condition, message) {
      if (!condition) problems.push(message);
    },
    done() {
      if (problems.length > 0) {
        throw new Error(
          `${problems.length} check(s) failed:\n        ${problems.join("\n        ")}`,
        );
      }
    },
  };
}

/**
 * What is wrong with an open sheet or dialog in the visible page: its buttons (and the box
 * itself) must lie inside the viewport, or the person cannot reach them. Empty when it is fine.
 * @param {import("playwright").Page} page @param {import("playwright").Locator} dialog
 */
export async function reachProblem(page, dialog) {
  const viewport = page.viewportSize();
  if (!viewport) return "the page has no viewport";
  /** @type {string[]} */
  const outside = [];
  /** @param {string} what @param {{ x: number, y: number, width: number, height: number } | null} box */
  const inside = (what, box) => {
    if (!box) return;
    if (
      box.x < -1 ||
      box.y < -1 ||
      box.x + box.width > viewport.width + 1 ||
      box.y + box.height > viewport.height + 1
    ) {
      outside.push(
        `${what} (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)})`,
      );
    }
  };
  for (const button of await dialog.getByRole("button").all()) {
    const name = (await button.textContent()) ?? "button";
    inside(`the "${name.trim()}" button`, await button.boundingBox());
  }
  return outside.length === 0
    ? ""
    : `outside the ${viewport.width}x${viewport.height} page: ${outside.join(", ")}`;
}

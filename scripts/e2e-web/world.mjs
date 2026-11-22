// One scenario's world: its own folders (data directory, Editing Folder, fake Claude state, shots)
// inside the run's work folder, the helpers to seed them, and the server and browser helpers that
// remember what they started.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiOptions, seedLibrary as seedChannel } from "../e2e/library.mjs";
import { currentInterface } from "../e2e/interface.mjs";
import { newWatchedContext, screenshot } from "./browser.mjs";
import { serverEnv, startServer } from "./server.mjs";

/**
 * Polls until `check` returns something truthy; the message says what was waited for.
 * @template T
 * @param {() => T | Promise<T>} check @param {string} what @param {number} [timeout]
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitFor(check, what, timeout = 20_000) {
  const started = Date.now();
  /** @type {unknown} */
  let last = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return /** @type {NonNullable<T>} */ (value);
    } catch (error) {
      last = error;
    }
    if (Date.now() - started > timeout) {
      const why = last instanceof Error ? `: ${last.message}` : "";
      throw new Error(`Timed out after ${timeout} ms waiting for ${what}${why}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The fake Claude Code processes of a state folder, in the order they started.
 * @param {string} fakeDir @returns {Promise<import("../e2e/types.mjs").FakeCall[]>}
 */
async function fakeCalls(fakeDir) {
  const order = existsSync(path.join(fakeDir, "calls"))
    ? (await readFile(path.join(fakeDir, "calls"), "utf8")).split("\n").filter(Boolean)
    : [];
  /** @type {import("../e2e/types.mjs").FakeCall[]} */
  const calls = [];
  for (const pid of order) {
    const info = await readFile(path.join(fakeDir, `call.${pid}`), "utf8").catch(() => "");
    const stdin = await readFile(path.join(fakeDir, `in.${pid}`), "utf8").catch(() => "");
    /** @type {Record<string, string>} */
    const fields = {};
    for (const line of info.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
    }
    const lines = stdin.split("\n").filter(Boolean);
    /** @type {string[]} */
    const messages = [];
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.type === "user") {
          messages.push(
            json.message.content.map((/** @type {{ text?: string }} */ c) => c.text ?? "").join(""),
          );
        }
      } catch {
        // not JSON
      }
    }
    calls.push({
      pid: Number(pid),
      mode: fields["mode"] ?? "",
      sid: fields["sid"] ?? "",
      args: fields["args"] ?? "",
      cwd: fields["cwd"] ?? "",
      env: {},
      messages,
      stdin: lines,
    });
  }
  return calls;
}

/**
 * @param {object} options
 * @param {import("./types.mjs").Scenario} options.scenario
 * @param {string} options.work the run's work folder
 * @param {string} options.binary the debug `vidai-web`
 * @param {string} options.claude the fake `claude`
 * @param {string} options.fixtures the fake's control fixtures folder
 * @param {import("playwright").Browser} options.browser
 * @param {ReturnType<typeof import("./browser.mjs").createWatch>} options.watch
 * @param {(text: string) => void} options.log
 * @param {string[]} options.notes
 * @param {string[]} options.shotFiles
 */
export async function createTest({
  scenario,
  work,
  binary,
  claude,
  fixtures,
  browser,
  watch,
  log,
  notes,
  shotFiles,
}) {
  const dir = path.join(work, scenario.name);
  const editing = path.join(dir, "Editing");
  const data = path.join(dir, "data");
  const fake = path.join(dir, "fake");
  const shots = path.join(dir, "shots");
  for (const d of [editing, data, fake, shots]) await mkdir(d, { recursive: true });
  /** @type {import("playwright").BrowserContext[]} */
  const contexts = [];
  let shotNumber = 0;

  /** @type {import("./types.mjs").Test} */
  const t = {
    name: scenario.name,
    dir,
    editing,
    data,
    fake,
    shots,
    async video(channel, folder, media) {
      const target = path.join(editing, channel, folder);
      await mkdir(target, { recursive: true });
      await copyFile(path.join(work, "media", `${media}.mp4`), path.join(target, "A-roll.mp4"));
      return target;
    },
    async seedSettings(settings) {
      await writeFile(
        path.join(data, "settings.json"),
        JSON.stringify(
          {
            schemaVersion: 9,
            editingFolder: editing,
            reviewSoftware: currentInterface().reviewSoftwareId,
            maxConcurrentEdits: 3,
            model: null,
            effort: null,
            activeToolkit: "standard",
            channels: [],
            theme: "system",
            textSize: 15,
            // Off unless a scenario asks for it: the start delay's minute is only shortened by
            // the desktop suite's hook.
            startDelayMinutes: 0,
            setup: "claudeSubscription",
            apiOptions: apiOptions(),
            ...settings,
          },
          null,
          2,
        ),
      );
    },
    async seedLibrary(videos, settings = {}) {
      // The shared setup only needs `video` and `seedSettings` of the desktop suite's context.
      await seedChannel(/** @type {any} */ (t), videos, settings);
    },
    async fakeSet(name, content = "") {
      await writeFile(path.join(fake, name), content);
    },
    async waitFake(name, timeout = 30_000) {
      await waitFor(() => existsSync(path.join(fake, name)), `fake/${name}`, timeout);
    },
    async fakeRemove(name) {
      await rm(path.join(fake, name), { force: true });
    },
    async release(folder) {
      await writeFile(path.join(fake, `release.${folder}`), "");
    },
    fakeCalls: () => fakeCalls(fake),
    async startServer(options = {}) {
      const env = serverEnv({ data, claude, fake, fixtures, env: options.env ?? {} });
      const server = await startServer(binary, env, dir, options.port ?? 0);
      log(`server on port ${server.port}`);
      return server;
    },
    async newContext() {
      const context = await newWatchedContext(browser, watch);
      contexts.push(context);
      return context;
    },
    async open(server, context) {
      const ctx = context ?? (await t.newContext());
      const page = await ctx.newPage();
      await page.goto(server.address);
      await page.waitForSelector("#root > *", { timeout: 30_000 });
      return page;
    },
    async shot(page, name, clip) {
      shotNumber += 1;
      const file = path.join(shots, `${String(shotNumber).padStart(2, "0")}-${name}.png`);
      await screenshot(page, file, clip);
      shotFiles.push(file);
      return file;
    },
    allowFailure: (pattern) => watch.allow(pattern),
    issues: () => watch.issues,
    note(message) {
      notes.push(message);
      log(`note: ${message}`);
    },
    waitFor,
    assert(condition, message) {
      if (!condition) throw new Error(`Assertion failed: ${message}`);
    },
    equal(actual, expected, what) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
    },
  };
  /** @param {string} prefix */
  const pageShots = async (prefix) => {
    const pages = contexts.flatMap((context) => context.pages());
    for (const [i, page] of pages.entries()) {
      shotNumber += 1;
      const suffix = pages.length > 1 ? `-page${i + 1}` : "";
      const file = path.join(
        shots,
        `${String(shotNumber).padStart(2, "0")}-${prefix}${suffix}.png`,
      );
      await screenshot(page, file).catch(() => {});
      if (prefix === "FAILED") {
        // What the page said, for a quick look without opening the picture.
        const text = await page
          .locator("body")
          .innerText({ timeout: 2000 })
          .catch(() => "");
        await writeFile(file.replace(/\.png$/, ".txt"), text);
      }
      if (existsSync(file)) shotFiles.push(file);
    }
  };
  return {
    t,
    /** A screenshot of every open page at the end of the scenario. */
    finalShot: () => pageShots("end"),
    /** The same when the scenario failed. */
    failureShots: () => pageShots("FAILED"),
    /** Closes the browser contexts of the scenario. */
    async closeContexts() {
      for (const context of contexts) await context.close().catch(() => {});
    },
  };
}

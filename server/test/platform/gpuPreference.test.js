import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREFERENCE_DATA,
  PREFERENCE_KEY,
  browserPrograms,
  createGpuPreference,
  parseRegValue,
  regCommand,
} from "../../src/platform/gpuPreference.js";

const HOME = "C:\\Users\\Office";
const SHELL = `${HOME}\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-131\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;
const PUPPETEER = `${HOME}\\.cache\\puppeteer\\chrome-headless-shell\\win64-130\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/**
 * A tiny disk: the files that exist, and the folders that list their children.
 * @param {string[]} files
 */
function disk(files) {
  const exists = (/** @type {string} */ f) => files.includes(f);
  const list = (/** @type {string} */ dir) => {
    const prefix = `${dir}\\`;
    const names = new Set(
      files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split("\\")[0]),
    );
    return [...names].filter((n) => n !== undefined);
  };
  return { exists, list };
}

/**
 * A fake reg.exe over a map of value name to data.
 * @param {Record<string, string>} store
 * @param {{ failAdd?: boolean }} [options]
 */
function fakeReg(store, options = {}) {
  /** @type {string[][]} */
  const calls = [];
  const run = async (/** @type {string} */ command, /** @type {readonly string[]} */ args) => {
    calls.push([command, ...args]);
    assert.equal(args[1], PREFERENCE_KEY);
    if (args[0] === "query") {
      const name = args[3] ?? "";
      const data = store[name];
      return data === undefined
        ? {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system was unable to find the specified registry key or value.",
          }
        : {
            code: 0,
            stdout: `\r\n${PREFERENCE_KEY}\r\n    ${name}    REG_SZ    ${data}\r\n\r\n`,
            stderr: "",
          };
    }
    assert.equal(args[0], "add");
    if (options.failAdd) return { code: 1, stdout: "", stderr: "ERROR: Access is denied." };
    assert.deepEqual(args.slice(4), ["/t", "REG_SZ", "/d", PREFERENCE_DATA, "/f"]);
    store[args[3] ?? ""] = PREFERENCE_DATA;
    return { code: 0, stdout: "The operation completed successfully.", stderr: "" };
  };
  return { run, calls };
}

/**
 * @param {(m: string) => unknown} info
 * @param {(m: string) => unknown} [warn]
 */
const quietLog = (info, warn = () => {}) => ({
  info: (/** @type {string} */ m) => void info(m),
  warn: (/** @type {string} */ m) => void warn(m),
  error: () => {},
});

const nvidia = async () => ({ present: true, name: "NVIDIA GeForce RTX 5060 Ti" });

test("reg.exe is the system's, and its value is read from the query text", () => {
  assert.equal(regCommand({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\reg.exe");
  assert.equal(regCommand({}), "C:\\Windows\\System32\\reg.exe");
  assert.equal(
    parseRegValue(`\r\nHKEY\r\n    C:\\a b\\x.exe    REG_SZ    GpuPreference=2;\r\n`),
    "GpuPreference=2;",
  );
  assert.equal(parseRegValue("nothing"), null);
});

test("every browser program the renderer may start is found, only those that exist", () => {
  const found = browserPrograms({
    env: { ProgramW6432: "C:\\Program Files", LOCALAPPDATA: `${HOME}\\AppData\\Local` },
    home: HOME,
    ...disk([SHELL, PUPPETEER, CHROME]),
  });
  assert.deepEqual(found, [SHELL, PUPPETEER, CHROME]);
  const named = browserPrograms({
    env: { HYPERFRAMES_CACHE_DIR: "D:\\hf" },
    home: HOME,
    ...disk([
      "D:\\hf\\chrome\\chrome-headless-shell\\win64-9\\chrome-headless-shell-win64\\chrome-headless-shell.exe",
    ]),
  });
  assert.equal(named.length, 1);
  assert.deepEqual(browserPrograms({ env: {}, home: HOME, ...disk([]) }), []);
});

test("on Windows with an NVIDIA GPU every browser gets High performance, and a second call writes nothing", async () => {
  /** @type {Record<string, string>} */
  const store = {};
  const reg = fakeReg(store);
  /** @type {string[]} */
  const lines = [];
  const pref = createGpuPreference({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", ProgramW6432: "C:\\Program Files" },
    home: HOME,
    run: reg.run,
    nvidia,
    log: quietLog((m) => lines.push(m)),
    ...disk([SHELL, CHROME]),
  });
  const extra = "D:\\tools\\chrome-headless-shell.exe";
  const first = await pref.apply([extra, SHELL, "relative\\chrome.exe"]);
  assert.deepEqual(first.applied, [extra, SHELL, CHROME]);
  assert.deepEqual(first.failed, []);
  assert.equal(first.skipped, null);
  assert.deepEqual(store, {
    [extra]: PREFERENCE_DATA,
    [SHELL]: PREFERENCE_DATA,
    [CHROME]: PREFERENCE_DATA,
  });
  assert.equal(reg.calls[0]?.[0], "C:\\Windows\\System32\\reg.exe");
  assert.match(lines[0] ?? "", /3 set, 0 already set, 0 failed/u);
  const writes = reg.calls.filter((c) => c[1] === "add").length;
  const second = await pref.apply([extra]);
  assert.deepEqual(second.applied, []);
  assert.equal(second.already.length, 3);
  assert.equal(reg.calls.filter((c) => c[1] === "add").length, writes);
});

test("a program that Windows already marks High performance with more flags is left alone", async () => {
  const store = { [SHELL]: "GpuPreference=2;SwapEffectUpgradeEnable=1;" };
  const reg = fakeReg(store);
  const result = await createGpuPreference({
    platform: "win32",
    env: {},
    home: HOME,
    run: reg.run,
    nvidia,
    ...disk([SHELL]),
  }).apply();
  assert.deepEqual(result.already, [SHELL]);
  assert.equal(store[SHELL], "GpuPreference=2;SwapEffectUpgradeEnable=1;");
});

test("a power-saving or automatic choice of the user is replaced for the renderer's browser", async () => {
  const store = { [SHELL]: "GpuPreference=1;" };
  const result = await createGpuPreference({
    platform: "win32",
    env: {},
    home: HOME,
    run: fakeReg(store).run,
    nvidia,
    ...disk([SHELL]),
  }).apply();
  assert.deepEqual(result.applied, [SHELL]);
  assert.equal(store[SHELL], PREFERENCE_DATA);
});

test("nothing is done without Windows or without an NVIDIA GPU", async () => {
  const reg = fakeReg({});
  const mac = await createGpuPreference({ platform: "darwin", run: reg.run, nvidia }).apply([
    SHELL,
  ]);
  assert.equal(mac.skipped, "this is not Windows");
  const none = await createGpuPreference({
    platform: "win32",
    env: {},
    home: HOME,
    run: reg.run,
    nvidia: async () => ({ present: false, name: null }),
    ...disk([SHELL]),
  }).apply([SHELL]);
  assert.equal(none.skipped, "this computer has no NVIDIA GPU");
  assert.equal(reg.calls.length, 0);
});

test("a failing or throwing reg.exe is logged and never fails the caller", async () => {
  /** @type {string[]} */
  const warnings = [];
  const log = quietLog(
    () => {},
    (m) => warnings.push(m),
  );
  const failed = await createGpuPreference({
    platform: "win32",
    env: {},
    home: HOME,
    run: fakeReg({}, { failAdd: true }).run,
    nvidia,
    log,
    ...disk([SHELL]),
  }).apply();
  assert.deepEqual(failed.failed, [SHELL]);
  assert.match(warnings[0] ?? "", /Access is denied/u);
  const throwing = await createGpuPreference({
    platform: "win32",
    env: {},
    home: HOME,
    run: async () => {
      throw new Error("spawn reg.exe ENOENT");
    },
    nvidia,
    log,
    ...disk([SHELL]),
  }).apply();
  assert.deepEqual(throwing.failed, [SHELL]);
  const brokenSmi = await createGpuPreference({
    platform: "win32",
    nvidia: async () => {
      throw new Error("x");
    },
  }).apply([SHELL]);
  assert.equal(brokenSmi.skipped, "this computer has no NVIDIA GPU");
});

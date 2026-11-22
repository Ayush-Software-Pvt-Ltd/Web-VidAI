import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../../src/db/open.js";
import { realFs } from "../../src/toolkit/install.js";
import { createToolkitModule } from "../../src/toolkit/index.js";
import { tempDir, writeShippedToolkit } from "../support/fake-python.js";

/** @typedef {import("../../src/toolkit/run.js").RunRequest} RunRequest */

const quietLog = {
  info: () => {},
  warn: () => {},
  error: (/** @type {string} */ _m, /** @type {unknown} */ _d) => {},
};

/** A Python that "works": answers every command like the stand-in script, creating the venv. */
function pretendRunner(/** @type {{ calls: RunRequest[], venv: string }} */ { calls, venv }) {
  return async (/** @type {RunRequest} */ request) => {
    calls.push(request);
    const text = (request.args ?? []).join(" ");
    const ok = (/** @type {string[]} */ tail) => ({
      started: true,
      code: 0,
      timedOut: false,
      aborted: false,
      tail,
      error: null,
    });
    if (text.includes("sys.version_info")) return ok(["3.12.4"]);
    if (text.includes("-m venv")) {
      fs.mkdirSync(path.dirname(venv), { recursive: true });
      fs.writeFileSync(venv, "#!/bin/sh\n");
      return ok([]);
    }
    if (text.includes("-m pip --version")) return ok(["pip 24.0 from x"]);
    if (text.includes("doctor")) return ok(["speech   OK  mlx, device gpu", "result: READY"]);
    if (text.includes("snapshot_download")) return ok(["VIDAI_MODEL mlx m /c"]);
    return ok([]);
  };
}

/** @param {{ version?: string, requirements?: string, autoPrepare?: boolean, installFs?: Partial<import("../../src/toolkit/install.js").InstallFs> }} [options] */
function setup({ version = "1.0.0", requirements = "numpy\n", autoPrepare = true, installFs } = {}) {
  const base = tempDir();
  const source = path.join(base.dir, "toolkit");
  fs.mkdirSync(source, { recursive: true });
  writeShippedToolkit(source, { version, requirements });
  const dataDir = path.join(base.dir, "data");
  /** @type {RunRequest[]} */
  const calls = [];
  /** @type {{ event: string, payload: unknown, userId: string | null, admins: boolean }[]} */
  const emitted = [];
  const db = openDatabase(":memory:");
  const venvPython = path.join(dataDir, "toolkit", "venv", "bin", "python");
  /** @param {Partial<import("../../src/toolkit/index.js").ToolkitDeps>} [more] */
  const build = (more = {}) =>
    createToolkitModule({
      dataDir,
      clock: { now: () => 5_000 },
      log: quietLog,
      events: { emit: (e) => void emitted.push(e) },
      version: "9.9.9",
      db,
      limits: {
        cpuState: () => ({ processors: 8, running: 0, budget: 2 }),
        gpuState: () => ({ total: 1, perJob: 1, slots: [] }),
      },
      source,
      platform: "darwin",
      env: { PATH: "/bin" },
      autoPrepare,
      ...(installFs ? { installFs } : {}),
      ensureBrowser: async () => ({ ok: true, message: "ok" }),
      testRender: async () => ({ ok: true, message: "ok" }),
      prepareOptions: {
        runner: pretendRunner({ calls, venv: venvPython }),
        pythonCandidates: () => [{ command: "/fake/python3", args: [], label: "/fake/python3" }],
        findFfmpeg: () => "/fake/ffmpeg",
        findFfprobe: () => "/fake/ffprobe",
      },
      ...more,
    });
  return { ...base, source, dataDir, calls, emitted, build, db, venvPython };
}

test("start installs the toolkit and prepares it the first time", async () => {
  const t = setup();
  try {
    const toolkit = t.build();
    assert.equal(toolkit.name, "toolkit");
    assert.equal(toolkit.api.prepared(), false);
    await toolkit.start();
    assert.equal(toolkit.api.info().installedVersion, "1.0.0");
    assert.equal(toolkit.api.info().upToDate, true);
    assert.ok(fs.existsSync(path.join(t.dataDir, "toolkit", "CLAUDE_VE_ALL", "ve.py")));
    assert.equal(toolkit.api.prepareState().running, true);
    await toolkit.api.prepareAndWait();
    assert.equal(toolkit.api.prepared(), true);
    assert.equal(toolkit.api.renderReady(), true);
    const first = t.emitted.length;
    assert.ok(first > 10);
    assert.ok(
      t.emitted.every((e) => e.event === "system-changed" && e.userId === "" && e.admins === true),
      "only admins hear system-changed",
    );
  } finally {
    t.cleanup();
  }
});

test("a restart with nothing to do starts no Prepare", async () => {
  const t = setup();
  try {
    const first = t.build();
    await first.start();
    await first.api.prepareAndWait();
    t.calls.length = 0;
    const second = t.build();
    await second.start();
    assert.equal(second.api.prepareState().running, false);
    assert.equal(second.api.prepared(), true);
    assert.deepEqual(t.calls, []);
  } finally {
    t.cleanup();
  }
});

test("an upgrade with the same requirements keeps the environment, changed ones prepare it again", async () => {
  const t = setup();
  try {
    const first = t.build();
    await first.start();
    await first.api.prepareAndWait();
    t.calls.length = 0;

    fs.rmSync(t.source, { recursive: true });
    writeShippedToolkit(t.source, { version: "1.1.0", requirements: "numpy\n", marker: "two" });
    const same = t.build();
    await same.start();
    assert.equal(same.api.info().installedVersion, "1.1.0");
    assert.equal(same.api.info().hasPrevious, true);
    assert.equal(same.api.prepared(), true);
    assert.equal(same.api.prepareState().running, false);
    assert.deepEqual(t.calls, []);

    fs.rmSync(t.source, { recursive: true });
    writeShippedToolkit(t.source, { version: "1.2.0", requirements: "numpy\nscipy\n" });
    const changed = t.build();
    await changed.start();
    assert.match(changed.api.prepareState().reason ?? "", /Python packages changed/);
    assert.equal(changed.api.prepared(), false);
    assert.equal(changed.api.prepareState().running, true);
    await changed.api.prepareAndWait();
    assert.equal(changed.api.prepared(), true);
  } finally {
    t.cleanup();
  }
});

test("autoPrepare off installs only", async () => {
  const t = setup({ autoPrepare: false });
  try {
    const toolkit = t.build();
    await toolkit.start();
    assert.equal(toolkit.api.prepareState().running, false);
    assert.deepEqual(t.calls, []);
    assert.equal(toolkit.api.prepared(), false);
  } finally {
    t.cleanup();
  }
});

test("a toolkit that cannot be installed is shown, never thrown, and nothing is prepared", async () => {
  const t = setup();
  try {
    fs.rmSync(path.join(t.source, "CLAUDE_VE_ALL"), { recursive: true });
    const toolkit = t.build();
    await toolkit.start();
    assert.match(toolkit.api.installError() ?? "", /missing or incomplete/);
    assert.equal(toolkit.api.info().installError, toolkit.api.installError());
    assert.equal(toolkit.api.info().upToDate, false);
    assert.equal(toolkit.api.prepared(), false);
    assert.deepEqual(t.calls, []);
    const prepareFn = toolkit.rpc.find((f) => f.name === "adminPrepareToolkit");
    await assert.rejects(
      async () => prepareFn?.handler({}, /** @type {any} */ ({})),
      (error) => /** @type {{ code?: string }} */ (error).code === "notReady",
    );
  } finally {
    t.cleanup();
  }
});

test("a crash during an upgrade is reported, the old toolkit keeps working, the next start finishes", async () => {
  const t = setup();
  try {
    const first = t.build();
    await first.start();
    await first.api.prepareAndWait();

    fs.rmSync(t.source, { recursive: true });
    writeShippedToolkit(t.source, { version: "1.1.0", requirements: "numpy\n", marker: "two" });
    const broken = t.build({
      installFs: {
        rename: (from, to) => {
          if (from.includes(".CLAUDE_VE_ALL.new-")) throw new Error("disk full");
          realFs.rename(from, to);
        },
      },
    });
    await broken.start();
    assert.match(broken.api.installError() ?? "", /disk full/);
    assert.equal(broken.api.info().installedVersion, "1.0.0");
    // Between the two renames: the old programs are in .previous; the next start puts them back.
    assert.ok(fs.existsSync(path.join(t.dataDir, "toolkit", "CLAUDE_VE_ALL.previous", "ve.py")));

    const again = t.build();
    await again.start();
    assert.equal(again.api.installError(), null);
    assert.equal(again.api.info().installedVersion, "1.1.0");
    assert.equal(again.api.prepared(), true);
  } finally {
    t.cleanup();
  }
});

test("api.paths gives what the prompt header needs, api.env what the toolkit's programs need", async () => {
  const t = setup();
  try {
    const toolkit = t.build();
    const before = toolkit.api.paths();
    assert.equal(before.version, null);
    await toolkit.start();
    const root = path.join(t.dataDir, "toolkit");
    assert.deepEqual(toolkit.api.paths(), {
      root,
      toolkitFolder: path.join(root, "CLAUDE_VE_ALL"),
      python: path.join(root, "venv", "bin", "python"),
      memoryFile: path.join(root, "MEMORY.md"),
      version: "1.0.0",
    });
    const env = toolkit.api.env();
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.equal(env.VE_FFMPEG, "/fake/ffmpeg");
    assert.equal(env.VE_FFPROBE, "/fake/ffprobe");
    assert.equal(env.VE_NODE, process.execPath);
    await toolkit.stop();
  } finally {
    t.cleanup();
  }
});

test("stop ends a running Prepare", async () => {
  const t = setup();
  try {
    /** @type {() => void} */
    let reached = () => {};
    const waiting = new Promise((resolve) => (reached = () => resolve(undefined)));
    const toolkit = t.build({
      prepareOptions: {
        pythonCandidates: () => [{ command: "/fake/python3", args: [], label: "x" }],
        runner: async (request) => {
          reached();
          await new Promise((resolve) => request.signal?.addEventListener("abort", resolve));
          return { started: true, code: null, timedOut: false, aborted: true, tail: [], error: null };
        },
      },
    });
    await toolkit.start();
    await waiting;
    await toolkit.stop();
    const state = toolkit.api.prepareState();
    assert.equal(state.running, false);
    assert.equal(state.steps[0]?.state, "failed");
    assert.equal(toolkit.api.prepared(), false);
  } finally {
    t.cleanup();
  }
});

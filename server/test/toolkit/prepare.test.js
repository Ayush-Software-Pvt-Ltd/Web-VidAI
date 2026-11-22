import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installToolkit } from "../../src/toolkit/install.js";
import { toolkitPaths } from "../../src/toolkit/paths.js";
import { createPrepare } from "../../src/toolkit/prepare.js";
import { runProcess } from "../../src/toolkit/run.js";
import { INTERRUPTED, emptyPrepare, writePrepare } from "../../src/toolkit/state.js";
import {
  CAN_RUN_FAKE_PYTHON,
  FAKE_PYTHON,
  tempDir,
  writeShippedToolkit,
} from "../support/fake-python.js";

/** @typedef {import("../../src/toolkit/run.js").RunRequest} RunRequest */
/** @typedef {import("../../src/toolkit/run.js").RunResult} RunResult */

const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

/** An installed toolkit in a temporary data directory. */
function setup() {
  const base = tempDir();
  const source = path.join(base.dir, "toolkit");
  fs.mkdirSync(source, { recursive: true });
  writeShippedToolkit(source, { version: "1.0.0", requirements: "numpy>=1\n" });
  const dataDir = path.join(base.dir, "data");
  const paths = toolkitPaths(dataDir, "darwin");
  installToolkit({ source, target: paths.root });
  let now = 1_000;
  const clock = { now: () => (now += 10) };
  return { ...base, source, dataDir, paths, clock };
}

/**
 * A runner that behaves like the stand-in Python without starting a process.
 * @param {{ fail?: string[], version?: string, calls?: RunRequest[] }} [options]
 * @returns {import("../../src/toolkit/run.js").Runner}
 */
function pretendRunner({ fail = [], version = "3.12.4", calls = [] } = {}) {
  /**
   * @param {number | null} code
   * @param {string[]} tail
   * @returns {RunResult}
   */
  const result = (code, tail) => ({
    started: true,
    code,
    timedOut: false,
    aborted: false,
    tail,
    error: null,
  });
  return async (request) => {
    calls.push(request);
    const args = [...(request.args ?? [])];
    const text = args.join(" ");
    const has = (/** @type {string} */ what) => fail.includes(what);
    if (text.includes("sys.version_info")) return result(0, [version]);
    if (text.includes("-m venv")) {
      if (has("venv")) return result(1, ["Error: no ensurepip"]);
      return result(0, []);
    }
    if (text.includes("-m pip --version")) {
      return has("pipversion") ? result(1, ["No module named pip"]) : result(0, ["pip 24.0 from x"]);
    }
    if (text.includes("--upgrade")) return has("upgrade") ? result(1, ["cannot"]) : result(0, []);
    if (text.includes("pip install")) {
      return has("pip") ? result(1, ["ERROR: No matching distribution found for numpy"]) : result(0, []);
    }
    if (text.includes("doctor")) {
      return has("doctor")
        ? result(1, ["speech   MISSING (mlx): no module", "result: INCOMPLETE"])
        : result(0, ["hardware videotoolbox (x)", "speech   OK  mlx, device gpu", "result: READY"]);
    }
    if (text.includes("snapshot_download")) {
      return has("speech")
        ? result(1, ["ConnectionError: offline"])
        : result(0, ["VIDAI_MODEL mlx mlx-community/m /c"]);
    }
    return result(2, ["unexpected"]);
  };
}

/**
 * @param {ReturnType<typeof setup>} t
 * @param {Partial<import("../../src/toolkit/prepare.js").PrepareDeps>} [overrides]
 */
function makePrepare(t, overrides = {}) {
  /** @type {string[]} */
  const changes = [];
  const venvExists = { value: false };
  const base = overrides.runner ?? pretendRunner();
  /** The stand-in venv "exists" once a `-m venv` call succeeded. */
  /** @type {import("../../src/toolkit/run.js").Runner} */
  const runner = async (request) => {
    const result = await base(request);
    if ((request.args ?? []).join(" ").includes("-m venv") && result.code === 0) {
      venvExists.value = true;
    }
    return result;
  };
  const prepare = createPrepare({
    paths: t.paths,
    clock: t.clock,
    log: quietLog,
    env: { PATH: "/bin" },
    platform: "darwin",
    pythonCandidates: () => [{ command: "/fake/python3.12", args: [], label: "/fake/python3.12" }],
    findFfmpeg: () => "/fake/ffmpeg",
    findFfprobe: () => "/fake/ffprobe",
    ensureBrowser: async () => ({ ok: true, message: "Browser installed." }),
    testRender: async () => ({ ok: true, message: "Test render took 4 seconds." }),
    exists: (file) => (file === t.paths.python ? venvExists.value : fs.existsSync(file)),
    onChange: () => changes.push("changed"),
    ...overrides,
    runner,
  });
  return { prepare, changes, venvExists };
}

/** @param {import("../../../src/lib/wire/system.ts").PrepareState} state */
const states = (state) => Object.fromEntries(state.steps.map((s) => [s.id, s.state]));

test("a full Prepare runs the steps in order and records each result", async () => {
  const t = setup();
  try {
    /** @type {RunRequest[]} */
    const calls = [];
    const { prepare, changes } = makePrepare(t, { runner: pretendRunner({ calls }) });
    assert.equal(prepare.prepared(), false);
    const state = await prepare.run();
    assert.deepEqual(
      state.steps.map((s) => s.id),
      ["python", "venv", "packages", "ffmpeg", "doctor", "speech", "browser", "render"],
    );
    assert.ok(state.steps.every((s) => s.state === "done"), JSON.stringify(state.steps));
    assert.match(state.steps[0]?.message ?? "", /Python 3\.12\.4 at \/fake\/python3\.12/);
    assert.match(state.steps[1]?.message ?? "", /Environment created \(Python 3\.12\.4, pip 24\.0\)/);
    assert.match(state.steps[3]?.message ?? "", /ffmpeg at \/fake\/ffmpeg, ffprobe at \/fake\/ffprobe/);
    assert.match(state.steps[4]?.message ?? "", /hardware videotoolbox.*speech OK mlx, device gpu/);
    assert.match(state.steps[5]?.message ?? "", /Speech model mlx-community\/m is ready \(mlx\)/);
    assert.equal(state.steps[6]?.message, "Browser installed.");
    assert.ok(state.steps.every((s) => s.at !== null));
    assert.deepEqual(
      state.steps.map((s) => s.blocks),
      ["editing", "editing", "editing", "editing", "editing", "editing", "rendering", "rendering"],
    );
    assert.equal(state.editReady, true);
    assert.equal(state.renderReady, true);
    assert.equal(state.needsPrepare, false);
    assert.equal(state.running, false);
    assert.ok(changes.length >= 16);
    assert.ok(state.log.some((l) => l === "== Python packages =="));

    // The commands, in order: version, venv, pip --version, version of the venv, upgrade, install,
    // the toolkit's check, the speech model.
    const commands = calls.map((c) => (c.args ?? []).join(" "));
    assert.match(commands[0] ?? "", /sys\.version_info/);
    assert.match(commands[1] ?? "", new RegExp(`-m venv ${t.paths.venvDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(commands[2] ?? "", /-m pip --version/);
    assert.ok(commands.some((c) => /-m pip install --upgrade --no-input/.test(c)));
    assert.ok(commands.some((c) => /-m pip install --no-input --disable-pip-version-check -r/.test(c)));
    const doctor = calls.find((c) => (c.args ?? []).includes("doctor"));
    assert.deepEqual(doctor?.args, [t.paths.driver, "doctor"]);
    assert.equal(doctor?.command, t.paths.python);
    assert.equal(doctor?.env?.VE_FFMPEG, "/fake/ffmpeg");
    assert.equal(doctor?.env?.PYTHONDONTWRITEBYTECODE, "1");
    assert.equal(doctor?.env?.PIP_NO_INPUT, "1");
    const install = calls.find((c) => (c.args ?? []).includes("-r"));
    assert.equal(install?.timeoutMs, 60 * 60_000);
  } finally {
    t.cleanup();
  }
});

test("the recorded steps are still there after a restart", async () => {
  const t = setup();
  try {
    const first = makePrepare(t);
    await first.prepare.run();
    const second = makePrepare(t, { exists: () => true });
    const view = second.prepare.view();
    assert.ok(view.steps.every((s) => s.state === "done"));
    assert.equal(view.steps[0]?.message, first.prepare.view().steps[0]?.message);
    assert.equal(view.editReady, true);
    assert.equal(second.prepare.prepared(), true);
    assert.ok(fs.existsSync(t.paths.prepareFile));
  } finally {
    t.cleanup();
  }
});

test("a step that was running when the server stopped shows as failed after a restart", () => {
  const t = setup();
  try {
    const record = emptyPrepare();
    const step = /** @type {NonNullable<(typeof record.steps)[number]>} */ (record.steps[2]);
    step.state = "running";
    step.message = null;
    writePrepare(t.paths.prepareFile, record);
    const { prepare } = makePrepare(t);
    const shown = prepare.view().steps[2];
    assert.equal(shown?.state, "failed");
    assert.equal(shown?.message, INTERRUPTED);
  } finally {
    t.cleanup();
  }
});

test("a damaged record means nothing was prepared", () => {
  const t = setup();
  try {
    fs.writeFileSync(t.paths.prepareFile, "{ not json");
    const { prepare } = makePrepare(t);
    assert.ok(prepare.view().steps.every((s) => s.state === "pending"));
    assert.equal(prepare.prepared(), false);
  } finally {
    t.cleanup();
  }
});

test("without a Python the step says what to install and what depends on it waits", async () => {
  const t = setup();
  try {
    const { prepare } = makePrepare(t, { pythonCandidates: () => [] });
    const state = await prepare.run();
    assert.deepEqual(states(state), {
      python: "failed",
      venv: "pending",
      packages: "pending",
      ffmpeg: "done",
      doctor: "pending",
      speech: "pending",
      browser: "done",
      render: "done",
    });
    assert.match(state.steps[0]?.message ?? "", /No Python 3\.10 to 3\.13 was found.*brew install python@3\.12/);
    assert.equal(state.steps[1]?.message, 'Waits for "Python".');
    assert.equal(state.steps[4]?.message, 'Waits for "Python packages".');
    assert.equal(state.editReady, false);
    assert.equal(state.renderReady, false);
  } finally {
    t.cleanup();
  }
});

test("a Python that is too old is named in the sentence", async () => {
  const t = setup();
  try {
    const { prepare } = makePrepare(t, { runner: pretendRunner({ version: "3.9.6" }) });
    const state = await prepare.run();
    assert.equal(state.steps[0]?.state, "failed");
    assert.match(state.steps[0]?.message ?? "", /Found but not usable: \/fake\/python3\.12 is Python 3\.9\.6/);
  } finally {
    t.cleanup();
  }
});

test("a candidate that does not start is skipped and the next one is used", async () => {
  const t = setup();
  try {
    const inner = pretendRunner();
    const { prepare } = makePrepare(t, {
      pythonCandidates: () => [
        { command: "/fake/broken", args: [], label: "/fake/broken" },
        { command: "/fake/python3.11", args: ["-3.11"], label: "py -3.11" },
      ],
      runner: async (request) =>
        request.command === "/fake/broken"
          ? { started: false, code: null, timedOut: false, aborted: false, tail: [], error: "nope" }
          : inner(request),
    });
    const state = await prepare.run();
    assert.match(state.steps[0]?.message ?? "", /at py -3\.11/);
    assert.equal(state.steps[0]?.state, "done");
  } finally {
    t.cleanup();
  }
});

test("failures of venv, pip, the check and the speech model are sentences with the last lines", async () => {
  const t = setup();
  try {
    let result = await makePrepare(t, { runner: pretendRunner({ fail: ["venv"] }) }).prepare.run();
    assert.equal(result.steps[1]?.state, "failed");
    assert.match(result.steps[1]?.message ?? "", /^Creating the Python environment failed\. Error: no ensurepip/);
    assert.equal(result.steps[2]?.state, "pending");

    result = await makePrepare(t, { runner: pretendRunner({ fail: ["pipversion"] }) }).prepare.run();
    assert.match(result.steps[1]?.message ?? "", /pip does not work in it\. No module named pip/);

    result = await makePrepare(t, { runner: pretendRunner({ fail: ["pip"] }) }).prepare.run();
    assert.equal(result.steps[2]?.state, "failed");
    assert.match(result.steps[2]?.message ?? "", /packages ended with code 1\. Is the internet reachable\?.*No matching distribution/s);
    assert.equal(result.steps[4]?.state, "pending");
    assert.equal(result.steps[5]?.state, "pending");
    assert.equal(result.needsPrepare, true);

    result = await makePrepare(t, { runner: pretendRunner({ fail: ["doctor"] }) }).prepare.run();
    assert.equal(result.steps[4]?.state, "failed");
    assert.match(result.steps[4]?.message ?? "", /own check found problems: speech MISSING \(mlx\): no module\. Fix them/);
    assert.equal(result.editReady, false);

    result = await makePrepare(t, { runner: pretendRunner({ fail: ["speech"] }) }).prepare.run();
    assert.equal(result.steps[5]?.state, "failed");
    assert.match(result.steps[5]?.message ?? "", /speech model failed\. Is the internet reachable\? ConnectionError: offline/);
    assert.equal(result.editReady, false);
  } finally {
    t.cleanup();
  }
});

test("a failed pip upgrade does not stop the install", async () => {
  const t = setup();
  try {
    const result = await makePrepare(t, { runner: pretendRunner({ fail: ["upgrade"] }) }).prepare.run();
    assert.equal(result.steps[2]?.state, "done");
    assert.equal(result.editReady, true);
  } finally {
    t.cleanup();
  }
});

test("a timeout of pip is said as such", async () => {
  const t = setup();
  try {
    const inner = pretendRunner();
    const { prepare } = makePrepare(t, {
      runner: async (request) =>
        (request.args ?? []).includes("-r")
          ? { started: true, code: null, timedOut: true, aborted: false, tail: [], error: null }
          : inner(request),
    });
    const result = await prepare.run();
    assert.match(result.steps[2]?.message ?? "", /packages took too long/);
  } finally {
    t.cleanup();
  }
});

test("a missing ffmpeg or ffprobe names the program and how to install it", async () => {
  const t = setup();
  try {
    let result = await makePrepare(t, { findFfmpeg: () => null }).prepare.run();
    assert.equal(result.steps[3]?.state, "failed");
    assert.match(result.steps[3]?.message ?? "", /^ffmpeg was not found\. Install ffmpeg with "brew install ffmpeg"/);
    assert.equal(result.steps[4]?.state, "pending");
    result = await makePrepare(t, { findFfmpeg: () => null, findFfprobe: () => null }).prepare.run();
    assert.match(result.steps[3]?.message ?? "", /^ffmpeg and ffprobe were not found\./);
    result = await makePrepare(t, { findFfprobe: () => null }).prepare.run();
    assert.match(result.steps[3]?.message ?? "", /^ffprobe was not found\./);
  } finally {
    t.cleanup();
  }
});

test("which steps block what: every combination of ffmpeg, browser and test render", async () => {
  const outcomes = /** @type {const} */ (["ok", "fail", "none"]);
  /** @param {"ok" | "fail" | "none"} how */
  const step = (how) =>
    how === "none" ? null : async () => ({ ok: how === "ok", message: how === "ok" ? "fine" : "broken" });
  for (const ffmpeg of [true, false]) {
    for (const browser of outcomes) {
      for (const render of outcomes) {
        const t = setup();
        try {
          const { prepare } = makePrepare(t, {
            findFfmpeg: () => (ffmpeg ? "/fake/ffmpeg" : null),
            ensureBrowser: step(browser),
            testRender: step(render),
          });
          const state = await prepare.run();
          const label = `ffmpeg=${ffmpeg} browser=${browser} render=${render}`;
          // Editing needs ffmpeg; rendering needs ffmpeg, the browser and the test render.
          assert.equal(state.editReady, ffmpeg, label);
          assert.equal(prepare.prepared(), ffmpeg, label);
          const renderOk = ffmpeg && browser === "ok" && render === "ok";
          assert.equal(state.renderReady, renderOk, label);
          assert.equal(prepare.renderReady(), renderOk, label);
          if (browser !== "ok" && ffmpeg) {
            assert.equal(states(state).render, "pending", `${label}: the test render waits`);
          }
        } finally {
          t.cleanup();
        }
      }
    }
  }
});

test("without a renderer the browser and the test render say they are not available", async () => {
  const t = setup();
  try {
    const { prepare } = makePrepare(t, { ensureBrowser: null, testRender: null });
    const state = await prepare.run();
    assert.equal(state.steps[6]?.state, "failed");
    assert.match(state.steps[6]?.message ?? "", /renderer's browser is not available in this server/);
    assert.equal(state.editReady, true);
    assert.equal(state.renderReady, false);
  } finally {
    t.cleanup();
  }
});

test("a step that throws fails with its message and does not stop the others", async () => {
  const t = setup();
  try {
    const { prepare } = makePrepare(t, {
      ensureBrowser: async () => {
        throw new Error("download refused");
      },
    });
    const state = await prepare.run();
    assert.equal(state.steps[6]?.state, "failed");
    assert.match(state.steps[6]?.message ?? "", /Renderer browser failed: download refused/);
    assert.equal(state.editReady, true);
  } finally {
    t.cleanup();
  }
});

test("a second call while Prepare runs joins it", async () => {
  const t = setup();
  try {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => (release = () => resolve(undefined)));
    const calls = { n: 0 };
    const inner = pretendRunner();
    const { prepare } = makePrepare(t, {
      runner: async (request) => {
        if (request.command === "/fake/python3.12" && (request.args ?? []).join(" ").includes("sys.version_info")) {
          calls.n += 1;
          await gate;
        }
        return inner(request);
      },
    });
    const first = prepare.run();
    const second = prepare.run();
    assert.equal(first, second);
    assert.equal(prepare.view().running, true);
    assert.equal(prepare.prepared(), false);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls.n, 1);
    assert.equal(prepare.view().running, false);
    // Done: a new call starts a new run.
    const third = prepare.run();
    assert.notEqual(third, first);
    await third;
  } finally {
    t.cleanup();
  }
});

test("stop ends a running Prepare: its step fails, the rest stays pending", async () => {
  const t = setup();
  try {
    const inner = pretendRunner();
    /** @type {() => void} */
    let reached = () => {};
    const hanging = new Promise((resolve) => (reached = () => resolve(undefined)));
    const { prepare } = makePrepare(t, {
      runner: async (request) => {
        if ((request.args ?? []).includes("-r")) {
          reached();
          await new Promise((resolve) => request.signal?.addEventListener("abort", resolve));
          return { started: true, code: null, timedOut: false, aborted: true, tail: [], error: null };
        }
        return inner(request);
      },
    });
    const done = prepare.run();
    await hanging;
    await prepare.stop();
    const state = await done;
    assert.equal(state.steps[2]?.state, "failed");
    assert.match(state.steps[2]?.message ?? "", /Stopped because the server was shutting down/);
    assert.equal(state.steps[4]?.state, "pending");
    assert.equal(state.running, false);
    assert.equal(prepare.prepared(), false);
  } finally {
    t.cleanup();
  }
});

test("the environment needs preparing again when the packages change or the venv is gone", async () => {
  const t = setup();
  try {
    const { prepare, venvExists } = makePrepare(t);
    assert.match(prepare.view().reason ?? "", /Python environment has not been created/);
    await prepare.run();
    assert.equal(prepare.prepared(), true);
    fs.appendFileSync(t.paths.requirements, "scipy\n");
    assert.equal(prepare.prepared(), false);
    assert.match(prepare.view().reason ?? "", /Python packages changed/);
    assert.equal(prepare.view().needsPrepare, true);
    await prepare.run();
    assert.equal(prepare.prepared(), true);
    venvExists.value = false;
    assert.equal(prepare.prepared(), false);
    assert.match(prepare.view().reason ?? "", /has not been created/);
  } finally {
    t.cleanup();
  }
});

test("half-installed packages never count: the recorded hash is cleared before pip runs", async () => {
  const t = setup();
  try {
    const { prepare } = makePrepare(t);
    await prepare.run();
    assert.equal(prepare.prepared(), true);
    const failing = makePrepare(t, { runner: pretendRunner({ fail: ["pip"] }), exists: () => true });
    await failing.prepare.run();
    const record = JSON.parse(fs.readFileSync(t.paths.prepareFile, "utf8"));
    assert.equal(record.requirementsHash, null);
    assert.equal(failing.prepare.view().needsPrepare, true);
  } finally {
    t.cleanup();
  }
});

test("stopAfter ends the run early; later steps stay pending and nothing is ready", async () => {
  const t = setup();
  try {
    /** @type {RunRequest[]} */
    const calls = [];
    const { prepare } = makePrepare(t, { runner: pretendRunner({ calls }) });
    const state = await prepare.run({ stopAfter: "venv" });
    assert.deepEqual(states(state), {
      python: "done",
      venv: "done",
      packages: "pending",
      ffmpeg: "pending",
      doctor: "pending",
      speech: "pending",
      browser: "pending",
      render: "pending",
    });
    assert.ok(!calls.some((c) => (c.args ?? []).includes("-r")));
    assert.equal(state.editReady, false);
  } finally {
    t.cleanup();
  }
});

test("a reused environment is reported as found, not created", async () => {
  const t = setup();
  try {
    const { prepare, venvExists } = makePrepare(t);
    venvExists.value = true;
    const state = await prepare.run();
    assert.match(state.steps[1]?.message ?? "", /^Environment found/);
  } finally {
    t.cleanup();
  }
});

test("the log keeps the last 200 lines", async () => {
  const t = setup();
  try {
    const inner = pretendRunner();
    const { prepare } = makePrepare(t, {
      runner: async (request) => {
        if ((request.args ?? []).includes("-r")) {
          for (let i = 0; i < 300; i++) request.onLine?.(`Collecting package ${i}`);
        }
        return inner(request);
      },
    });
    const state = await prepare.run();
    assert.equal(state.log.length, 200);
    assert.ok(state.log.includes("Collecting package 299"));
    assert.ok(!state.log.includes("Collecting package 0"));
  } finally {
    t.cleanup();
  }
});

// The same steps with the real process runner and the stand-in Python script.
const real = { skip: !CAN_RUN_FAKE_PYTHON && "needs a POSIX shell" };

test("with the stand-in Python: a real venv folder, real processes, output in the log", real, async () => {
  const t = setup();
  try {
    const callLog = path.join(t.dir, "python-calls.log");
    const { prepare } = makePrepare(t, {
      runner: runProcess,
      exists: undefined,
      env: { PATH: process.env.PATH, FAKE_PYTHON_LOG: callLog },
      pythonCandidates: () => [{ command: FAKE_PYTHON, args: [], label: "fake-python" }],
    });
    const state = await prepare.run();
    assert.ok(state.steps.every((s) => s.state === "done"), JSON.stringify(state.steps));
    assert.ok(fs.existsSync(t.paths.python), "the venv's python exists");
    assert.ok(state.log.includes("Successfully installed numpy"));
    const calls = fs.readFileSync(callLog, "utf8").trim().split("\n");
    assert.match(calls[0] ?? "", /^-c import sys/);
    assert.ok(calls.some((c) => c.startsWith("-m venv ") && c.endsWith(t.paths.venvDir)));
    assert.ok(calls.some((c) => c.endsWith("ve.py doctor")));
    assert.equal(prepare.prepared(), true);
  } finally {
    t.cleanup();
  }
});

test("with the stand-in Python: a failing pip leaves the log lines in the message", real, async () => {
  const t = setup();
  try {
    const { prepare } = makePrepare(t, {
      runner: runProcess,
      exists: undefined,
      env: { PATH: process.env.PATH, FAKE_PYTHON_FAIL: "pip" },
      pythonCandidates: () => [{ command: FAKE_PYTHON, args: [], label: "fake-python" }],
    });
    const state = await prepare.run();
    assert.equal(state.steps[2]?.state, "failed");
    assert.match(state.steps[2]?.message ?? "", /No matching distribution found for numpy/);
    assert.equal(state.steps[3]?.state, "done");
    assert.equal(state.editReady, false);
  } finally {
    t.cleanup();
  }
});

/** @param {ReturnType<typeof setup>} t */
function addCudaFile(t) {
  fs.writeFileSync(t.paths.requirementsCuda, "nvidia-cublas-cu12>=12\nnvidia-cudnn-cu12>=9,<10\n");
}

const RTX = { present: true, name: "NVIDIA GeForce RTX 5060 Ti" };

test("an NVIDIA GPU makes Prepare install the CUDA libraries after the packages", async () => {
  const t = setup();
  try {
    addCudaFile(t);
    /** @type {RunRequest[]} */
    const calls = [];
    const { prepare } = makePrepare(t, {
      runner: pretendRunner({ calls }),
      nvidia: async () => RTX,
    });
    const state = await prepare.run();
    assert.ok(state.steps.every((s) => s.state === "done"), JSON.stringify(state.steps));
    const installs = calls
      .map((c) => (c.args ?? []).join(" "))
      .filter((text) => text.includes("pip install") && text.includes(" -r "));
    assert.equal(installs.length, 2);
    assert.match(installs[0] ?? "", /requirements\.txt$/);
    assert.match(installs[1] ?? "", /requirements-cuda\.txt$/);
    assert.match(state.steps[2]?.message ?? "", /CUDA libraries installed/);
    assert.equal(state.needsPrepare, false);
  } finally {
    t.cleanup();
  }
});

test("without an NVIDIA GPU the CUDA libraries are not installed and nothing asks for them", async () => {
  const t = setup();
  try {
    addCudaFile(t);
    /** @type {RunRequest[]} */
    const calls = [];
    const { prepare } = makePrepare(t, {
      runner: pretendRunner({ calls }),
      nvidia: async () => ({ present: false, name: null }),
    });
    const state = await prepare.run();
    assert.equal(
      calls.filter((c) => (c.args ?? []).join(" ").includes("requirements-cuda.txt")).length,
      0,
    );
    assert.equal(state.needsPrepare, false);
    assert.equal(state.steps[2]?.message, "Python packages installed.");
  } finally {
    t.cleanup();
  }
});

test("an installed toolkit that lacks the CUDA libraries needs preparing on an NVIDIA machine, then does not", async () => {
  const t = setup();
  try {
    addCudaFile(t);
    const first = makePrepare(t, { nvidia: async () => ({ present: false, name: null }) });
    await first.prepare.run();
    assert.equal(first.prepare.prepared(), true);
    // The same environment, now seen on a computer with an NVIDIA GPU (or after the GPU was added).
    const second = makePrepare(t, { nvidia: async () => RTX });
    second.venvExists.value = true;
    await second.prepare.refreshHardware();
    const view = second.prepare.view();
    assert.equal(view.needsPrepare, true);
    assert.match(view.reason ?? "", /CUDA libraries for NVIDIA GeForce RTX 5060 Ti are not installed/);
    assert.equal(second.prepare.prepared(), false);
    await second.prepare.run();
    assert.equal(second.prepare.prepared(), true);
    assert.equal(second.prepare.view().reason, null);
  } finally {
    t.cleanup();
  }
});

test("a failed CUDA install fails the packages step and says the CPU is not used", async () => {
  const t = setup();
  try {
    addCudaFile(t);
    const inner = pretendRunner();
    /** @type {import("../../src/toolkit/run.js").Runner} */
    const runner = async (request) => {
      if ((request.args ?? []).join(" ").includes("requirements-cuda.txt")) {
        return {
          started: true,
          code: 1,
          timedOut: false,
          aborted: false,
          tail: ["ERROR: No matching distribution found for nvidia-cudnn-cu12"],
          error: null,
        };
      }
      return inner(request);
    };
    const { prepare } = makePrepare(t, { runner, nvidia: async () => RTX });
    const state = await prepare.run();
    const step = state.steps[2];
    assert.equal(step?.state, "failed");
    assert.match(step?.message ?? "", /CUDA libraries for NVIDIA GeForce RTX 5060 Ti failed/);
    assert.match(step?.message ?? "", /does not run on the CPU/);
    assert.match(step?.message ?? "", /nvidia-cudnn-cu12/);
    assert.equal(prepare.prepared(), false);
    assert.equal(state.steps[4]?.state, "pending");
  } finally {
    t.cleanup();
  }
});

test("a speech device that does not work fails the speech step with the toolkit's one line", async () => {
  const t = setup();
  try {
    addCudaFile(t);
    const inner = pretendRunner();
    const line =
      "speech: the NVIDIA GPU cannot be used for speech recognition (library cublas64_12.dll is missing or too old). The CPU is not used instead.";
    /** @type {import("../../src/toolkit/run.js").Runner} */
    const runner = async (request) => {
      if ((request.args ?? []).join(" ").includes("snapshot_download")) {
        return {
          started: true,
          code: 3,
          timedOut: false,
          aborted: false,
          tail: ["VIDAI_MODEL faster large-v3 /c", `VIDAI_SPEECH_FAILED ${line}`],
          error: null,
        };
      }
      return inner(request);
    };
    const { prepare } = makePrepare(t, { runner, nvidia: async () => RTX });
    const state = await prepare.run();
    const speech = state.steps.find((s) => s.id === "speech");
    assert.equal(speech?.state, "failed");
    assert.equal(speech?.message, line);
    assert.equal(prepare.prepared(), false);
  } finally {
    t.cleanup();
  }
});

test("the speech device that was proven is part of the speech step's message", async () => {
  const t = setup();
  try {
    const inner = pretendRunner();
    /** @type {import("../../src/toolkit/run.js").Runner} */
    const runner = async (request) => {
      if ((request.args ?? []).join(" ").includes("snapshot_download")) {
        return {
          started: true,
          code: 0,
          timedOut: false,
          aborted: false,
          tail: ["VIDAI_MODEL faster large-v3 /c", "VIDAI_SPEECH GPU (CUDA) (NVIDIA GeForce RTX 5060 Ti)"],
          error: null,
        };
      }
      return inner(request);
    };
    const { prepare } = makePrepare(t, { runner });
    const state = await prepare.run();
    assert.match(
      state.steps.find((s) => s.id === "speech")?.message ?? "",
      /Speech model large-v3 is ready \(faster\)\. Speech device: GPU \(CUDA\) \(NVIDIA GeForce RTX 5060 Ti\)\./,
    );
  } finally {
    t.cleanup();
  }
});

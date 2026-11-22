import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createNotePictures,
  snapshotArgs,
  stillPaths,
  zoomScaleFor,
} from "../../src/timeline/notePictures.js";
import { fakePng, fakeRunner, fpsOf, listTree, tempFolder } from "./noteSupport.js";

const fps = fpsOf(30, 1);
const shape = { cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 };

/**
 * A project folder, a work folder and a notes folder, with a capturer on a fake runner.
 * @param {{ runner?: Parameters<typeof fakeRunner>[0], deps?: Partial<Parameters<typeof createNotePictures>[0]> }} [options]
 */
function setup(options = {}) {
  const project = tempFolder("vidai-np-project-");
  const work = tempFolder("vidai-np-work-");
  fs.writeFileSync(path.join(project.dir, "index.html"), "<html></html>");
  fs.mkdirSync(path.join(project.dir, "compositions"));
  const runner = fakeRunner(options.runner);
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const infos = [];
  const pictures = createNotePictures({
    cli: "/pkg/hyperframes.mjs",
    ffmpeg: "ffmpeg-bin",
    workDir: path.join(work.dir, "tmp"),
    node: "node-bin",
    env: { PATH: "/bin", KEEP: "yes" },
    browserPath: "/browser/chrome",
    log: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) },
    start: runner.start,
    ...options.deps,
  });
  const input = (/** @type {Array<{ frame: number, shape: typeof shape | null }>} */ requests) => ({
    projectDir: project.dir,
    fps,
    width: 1920,
    height: 1080,
    requests: requests.map((r, i) => ({
      ...r,
      folder: path.join(work.dir, "notes", `n${i}`),
    })),
  });
  const cleanup = () => {
    project.cleanup();
    work.cleanup();
  };
  return { project, work, runner, pictures, warnings, infos, input, cleanup };
}

test("the density follows the frame size", () => {
  assert.equal(zoomScaleFor(1920, 1080), 2);
  assert.equal(zoomScaleFor(1080, 1920), 2);
  assert.equal(zoomScaleFor(3840, 2160), 1);
  assert.equal(zoomScaleFor(640, 360), 3);
});

test("the command line: all frames in one run, the frame middles, no end frame, an output folder", () => {
  const args = snapshotArgs({
    cli: "/pkg/hyperframes.mjs",
    projectDir: "/p",
    outDir: "/o",
    times: ["0.016667", "2.516667"],
    zoom: null,
  });
  assert.deepEqual(args, [
    "/pkg/hyperframes.mjs",
    "snapshot",
    "/p",
    "--at",
    "0.016667,2.516667",
    "--no-end",
    "-o",
    "/o",
    "--json",
    "--timeout",
    "45000",
  ]);
  const zoomed = snapshotArgs({
    cli: "c",
    projectDir: "/p",
    outDir: "/o",
    times: ["1.000000"],
    zoom: { width: 1920, height: 1080, scale: 2 },
  });
  assert.deepEqual(zoomed.slice(-4), ["--zoom", "0,0,1920,1080", "--zoom-scale", "2"]);
});

test("stills come from the JSON answer, else from the files", () => {
  const out = "/nonexistent";
  assert.deepEqual(stillPaths(`banner\n{"frames":[{"path":"/a.png"},{"path":"/b.png"}]}\n`, out), [
    "/a.png",
    "/b.png",
  ]);
  assert.deepEqual(stillPaths("not json", out), []);
  const { dir, cleanup } = tempFolder("vidai-stills-");
  try {
    for (const name of ["frame-01-at-2.5s.png", "frame-00-at-0.017s.png", "contact-sheet.jpg"]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }
    assert.deepEqual(stillPaths("", dir), [
      path.join(dir, "frame-00-at-0.017s.png"),
      path.join(dir, "frame-01-at-2.5s.png"),
    ]);
  } finally {
    cleanup();
  }
});

test("many requests are captured in ONE run, with a shape at double density", async () => {
  const t = setup();
  try {
    const result = await t.pictures.capture(
      t.input([
        { frame: 75, shape },
        { frame: 0, shape: null },
        { frame: 75, shape: null },
      ]),
    );
    const snapshots = t.runner.calls.filter((c) => c.args.includes("snapshot"));
    assert.equal(snapshots.length, 1);
    const call = snapshots[0];
    assert.equal(call.command, "node-bin");
    // Two distinct frames, ascending, at the frame middles.
    assert.equal(call.args[call.args.indexOf("--at") + 1], "0.016667,2.516667");
    assert.ok(call.args.includes("--no-end"));
    assert.deepEqual(call.args.slice(call.args.indexOf("--zoom")), [
      "--zoom",
      "0,0,1920,1080",
      "--zoom-scale",
      "2",
    ]);
    assert.equal(call.args[call.args.indexOf("snapshot") + 1], t.project.dir);
    // The output folder is outside the project.
    const out = call.args[call.args.indexOf("-o") + 1];
    assert.ok(out.startsWith(path.join(t.work.dir, "tmp")));
    assert.ok(!out.startsWith(t.project.dir));
    // Environment: no telemetry, the browser found by Prepare, the rest kept.
    assert.deepEqual(call.env, {
      PATH: "/bin",
      KEEP: "yes",
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_NO_UPDATE_CHECK: "1",
      HYPERFRAMES_BROWSER_PATH: "/browser/chrome",
    });
    assert.ok(call.timeoutMs >= 90_000);
    // One ffmpeg run per request.
    assert.equal(t.runner.calls.length, 1 + 3);
    assert.equal(result.length, 3);
    assert.ok(result[0].frame?.endsWith(path.join("n0", "frame.png")));
    assert.ok(result[0].closeup?.endsWith(path.join("n0", "closeup.png")));
    assert.ok(result[0].marked?.endsWith(path.join("n0", "frame-marked.png")));
    assert.equal(result[1].closeup, null);
    assert.ok(result[1].frame && path.isAbsolute(result[1].frame));
    assert.ok(result[2].frame);
    // The temporary folder of the run is gone.
    assert.deepEqual(fs.readdirSync(path.join(t.work.dir, "tmp")), []);
  } finally {
    t.cleanup();
  }
});

test("without any shape the capture is at normal density, with no zoom", async () => {
  const t = setup();
  try {
    await t.pictures.capture(t.input([{ frame: 3, shape: null }]));
    const call = t.runner.calls[0];
    assert.ok(!call.args.includes("--zoom"));
    assert.ok(!call.args.includes("--zoom-scale"));
  } finally {
    t.cleanup();
  }
});

test("the ffmpeg run of a request names the capture and its three outputs", async () => {
  const t = setup();
  try {
    await t.pictures.capture(t.input([{ frame: 0, shape }]));
    const ffmpeg = t.runner.calls[1];
    assert.equal(ffmpeg.command, "ffmpeg-bin");
    const files = ffmpeg.args.filter((a) => a.endsWith(".png"));
    assert.equal(files.length, 4);
    assert.ok(files[0].includes("frame-00-at-0.017s.png"));
    assert.deepEqual(
      files.slice(1).map((f) => path.basename(f)),
      ["frame.png", "frame-marked.png", "closeup.png"],
    );
  } finally {
    t.cleanup();
  }
});

test("nothing is left in the project folder, and files the tool made there are deleted", async () => {
  const t = setup();
  try {
    const before = listTree(t.project.dir);
    await t.pictures.capture(t.input([{ frame: 5, shape }]));
    assert.deepEqual(listTree(t.project.dir), before);
    assert.ok(t.infos.some((m) => m.includes(".hyperframes")));
  } finally {
    t.cleanup();
  }
});

test("the project folder is cleaned also when the capture fails", async () => {
  const t = setup({
    runner: {
      override: () => ({ code: 1, stdout: "", stderr: "boom\n", timedOut: false, stopped: false }),
    },
  });
  try {
    const before = listTree(t.project.dir);
    await t.pictures.capture(t.input([{ frame: 5, shape }]));
    assert.deepEqual(listTree(t.project.dir), before);
  } finally {
    t.cleanup();
  }
});

const NULLS = { frame: null, closeup: null, marked: null };

test("a failed capture gives null pictures for every request and says why", async () => {
  const t = setup({
    runner: {
      override: () => ({
        code: 1,
        stdout: "",
        stderr: "line one\nBrowser not found\n",
        timedOut: false,
        stopped: false,
      }),
    },
  });
  try {
    const result = await t.pictures.capture(
      t.input([
        { frame: 1, shape: null },
        { frame: 2, shape },
      ]),
    );
    assert.deepEqual(result, [NULLS, NULLS]);
    assert.equal(t.warnings.length, 1);
    assert.match(t.warnings[0], /the capture failed \(Browser not found\)/);
  } finally {
    t.cleanup();
  }
});

test("a capture that runs out of time gives null pictures", async () => {
  const t = setup({
    runner: {
      override: () => ({ code: null, stdout: "", stderr: "", timedOut: true, stopped: false }),
    },
  });
  try {
    const result = await t.pictures.capture(t.input([{ frame: 1, shape: null }]));
    assert.deepEqual(result, [NULLS]);
    assert.match(t.warnings[0], /did not finish in time/);
  } finally {
    t.cleanup();
  }
});

test("a capture that cannot be started gives null pictures", async () => {
  const t = setup({
    deps: {
      start: () => ({ done: Promise.reject(new Error("spawn node ENOENT")), stop: async () => {} }),
    },
  });
  try {
    const result = await t.pictures.capture(t.input([{ frame: 1, shape: null }]));
    assert.deepEqual(result, [NULLS]);
    assert.match(t.warnings[0], /could not be started \(spawn node ENOENT\)/);
  } finally {
    t.cleanup();
  }
});

test("too few pictures from the tool give null pictures", async () => {
  const t = setup({
    runner: {
      override: ({ args }) =>
        args.includes("snapshot")
          ? { code: 0, stdout: "{}", stderr: "", timedOut: false, stopped: false }
          : null,
    },
  });
  try {
    const result = await t.pictures.capture(t.input([{ frame: 1, shape: null }]));
    assert.deepEqual(result, [NULLS]);
    assert.match(t.warnings[0], /0 pictures instead of 1/);
  } finally {
    t.cleanup();
  }
});

test("a failed ffmpeg run gives null pictures for that request only", async () => {
  let ffmpegRuns = 0;
  const t = setup({
    runner: {
      override: ({ command }) => {
        if (command !== "ffmpeg-bin") return null;
        ffmpegRuns += 1;
        return ffmpegRuns === 1
          ? { code: 1, stdout: "", stderr: "Invalid argument\n", timedOut: false, stopped: false }
          : null;
      },
    },
  });
  try {
    const result = await t.pictures.capture(
      t.input([
        { frame: 1, shape },
        { frame: 2, shape: null },
      ]),
    );
    assert.deepEqual(result[0], NULLS);
    assert.ok(result[1].frame);
    assert.match(t.warnings[0], /ffmpeg failed for request 1 \(Invalid argument\)/);
    assert.equal(fs.existsSync(path.join(t.work.dir, "notes", "n0", "frame.png")), false);
  } finally {
    t.cleanup();
  }
});

test("pictures of an earlier attempt do not pass for new ones", async () => {
  const t = setup({
    runner: {
      override: ({ command }) =>
        command === "ffmpeg-bin"
          ? { code: 1, stdout: "", stderr: "x", timedOut: false, stopped: false }
          : null,
    },
  });
  try {
    const folder = path.join(t.work.dir, "notes", "n0");
    fs.mkdirSync(folder, { recursive: true });
    for (const name of ["frame.png", "closeup.png", "frame-marked.png"])
      fs.writeFileSync(path.join(folder, name), "old");
    const result = await t.pictures.capture(t.input([{ frame: 1, shape }]));
    assert.deepEqual(result, [NULLS]);
    assert.deepEqual(fs.readdirSync(folder), []);
  } finally {
    t.cleanup();
  }
});

test("without the hyperframes package or without requests nothing is run", async () => {
  const t = setup({ deps: { cli: null } });
  try {
    assert.deepEqual(await t.pictures.capture(t.input([{ frame: 1, shape: null }])), [NULLS]);
    assert.equal(t.runner.calls.length, 0);
    assert.match(t.warnings[0], /not installed/);
    assert.deepEqual(await t.pictures.capture(t.input([])), []);
  } finally {
    t.cleanup();
  }
});

test("without ffmpeg the capture is used as it is and says so", async () => {
  const t = setup({ deps: { ffmpeg: null } });
  try {
    const result = await t.pictures.capture(t.input([{ frame: 1, shape }]));
    assert.ok(result[0].frame);
    assert.equal(result[0].closeup, null);
    assert.equal(result[0].marked, null);
    assert.deepEqual(fs.readFileSync(result[0].frame), fakePng(3840, 2160));
    assert.match(t.warnings[0], /ffmpeg was not found/);
  } finally {
    t.cleanup();
  }
});

test("one capture at a time for the whole server", async () => {
  let running = 0;
  let most = 0;
  const base = fakeRunner();
  const t = setup({
    deps: {
      start: (/** @type {import("../../src/timeline/noteRun.js").RunOptions} */ options) => {
        const inner = base.start(options);
        if (!options.args.includes("snapshot")) return inner;
        running += 1;
        most = Math.max(most, running);
        return {
          stop: inner.stop,
          done: new Promise((resolve) =>
            setTimeout(() => {
              running -= 1;
              resolve(inner.done);
            }, 20),
          ),
        };
      },
    },
  });
  try {
    const all = await Promise.all([
      t.pictures.capture(t.input([{ frame: 1, shape: null }])),
      t.pictures.capture(t.input([{ frame: 2, shape: null }])),
      t.pictures.capture(t.input([{ frame: 3, shape: null }])),
    ]);
    assert.equal(most, 1);
    assert.ok(all.every((r) => r[0].frame !== null));
  } finally {
    t.cleanup();
  }
});

test("stop ends the running capture, and later captures give null pictures", async () => {
  let stopped = false;
  /** @type {(value: import("../../src/timeline/noteRun.js").RunResult) => void} */
  let release = () => {};
  const t = setup({
    deps: {
      start: () => ({
        done: new Promise((resolve) => {
          release = resolve;
        }),
        stop: async () => {
          stopped = true;
          release({ code: null, stdout: "", stderr: "", timedOut: false, stopped: true });
        },
      }),
    },
  });
  try {
    const pending = t.pictures.capture(t.input([{ frame: 1, shape: null }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await t.pictures.stop();
    assert.equal(stopped, true);
    assert.deepEqual(await pending, [NULLS]);
    assert.deepEqual(await t.pictures.capture(t.input([{ frame: 1, shape: null }])), [NULLS]);
    assert.match(t.warnings.at(-1) ?? "", /server is stopping/);
  } finally {
    t.cleanup();
  }
});

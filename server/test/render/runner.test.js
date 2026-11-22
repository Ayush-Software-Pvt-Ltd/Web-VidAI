import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { alive, fakeLimits, makeHarness, waitFor } from "./helpers.js";

/** @type {ReturnType<typeof makeHarness>[]} */
const made = [];
/** @param {Parameters<typeof makeHarness>[0]} [options] */
function harness(options) {
  const h = makeHarness(options);
  made.push(h);
  return h;
}
afterEach(() => {
  for (const h of made.splice(0)) h.cleanup();
});

/** @param {ReturnType<typeof makeHarness>} h */
const cacheEntries = (h) => (fs.existsSync(h.cacheDir()) ? fs.readdirSync(h.cacheDir()) : []);

describe("render runner: success", () => {
  it("renders, levels, names the file and cleans up", async () => {
    const h = harness();
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.error, null);
    assert.equal(outcome.sessionId, null);
    assert.equal(outcome.costUsd, null);
    const final = path.join(h.outputDir, "My Video_final_v1.mp4");
    assert.equal(outcome.deliverable, final);
    assert.equal(fs.readFileSync(final, "utf8"), "FAKE-MP4:levelled");
    assert.deepEqual(cacheEntries(h), []);
    assert.deepEqual(
      fs.readdirSync(h.outputDir).filter((n) => n.endsWith(".mp4")),
      ["My Video_final_v1.mp4"],
    );
    const tools = h.calls().map((c) => c.tool);
    assert.deepEqual(tools, ["hyperframes", "ffprobe", "ffmpeg", "ffmpeg", "ffprobe"]);
  });

  it("gives the renderer the SPEC command and environment", async () => {
    const h = harness({ project: { fps: "30000/1001" } });
    await h.runner.run({ id: "job1" }, h.facts).done;
    const [render] = h.calls();
    assert.ok(render);
    const out = path.join(h.cacheDir(), "job1", "out", "render.mp4");
    assert.deepEqual(render.argv, [
      "render",
      h.projectDir,
      "-o",
      out,
      "--fps",
      "30000/1001",
      "--workers",
      "1",
      "--video-bitrate",
      "12M",
      "--gpu",
    ]);
    assert.equal(render.env.HYPERFRAMES_BROWSER_PATH, "/fake/browser");
    assert.equal(render.env.HYPERFRAMES_NO_TELEMETRY, "1");
    assert.equal(render.env.HYPERFRAMES_NO_UPDATE_CHECK, "1");
    assert.equal(render.env.HYPERFRAMES_RENDER_LOCK, "off");
    assert.equal(
      render.env.HYPERFRAMES_EXTRACT_CACHE_DIR,
      path.join(h.cacheDir(), "job1", "extract"),
    );
    assert.equal(render.env.TMPDIR, path.join(h.cacheDir(), "job1", "tmp"));
    assert.equal(render.env.VIDAI_LIMIT_TEST, "yes");
    assert.ok(render.env.HYPERFRAMES_FFMPEG_PATH?.endsWith("ffmpeg"));
    assert.ok(render.env.HYPERFRAMES_FFPROBE_PATH?.endsWith("ffprobe"));
  });

  it("uses the 4K preset at 2160 and the shape of a Short", async () => {
    const h = harness({ resolution: 2160, project: { width: 1080, height: 1920 } });
    await h.runner.run({ id: "job1" }, h.facts).done;
    const argv = h.calls()[0]?.argv ?? [];
    assert.ok(argv.join(" ").includes("--video-bitrate 40M --resolution portrait-4k"));
  });

  it("caps the workers at 4 at 2160 and not at 1080", async () => {
    /** @param {1080 | 2160} resolution @param {number} workers */
    const workersOf = async (resolution, workers) => {
      const h = harness({ resolution, limits: fakeLimits({ workers }) });
      await h.runner.run({ id: "job1" }, h.facts).done;
      const argv = h.calls()[0]?.argv ?? [];
      return argv[argv.indexOf("--workers") + 1];
    };
    assert.equal(await workersOf(1080, 8), "8");
    assert.equal(await workersOf(2160, 8), "4");
    assert.equal(await workersOf(2160, 5), "4");
    assert.equal(await workersOf(2160, 4), "4");
    assert.equal(await workersOf(2160, 1), "1");
  });

  it("takes the smallest free version number and never overwrites", async () => {
    const h = harness();
    fs.mkdirSync(h.outputDir, { recursive: true });
    fs.writeFileSync(path.join(h.outputDir, "My Video_final_v1.mp4"), "old one");
    fs.writeFileSync(path.join(h.outputDir, "My Video_final_v3.mp4"), "old three");
    const first = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(path.basename(first.deliverable ?? ""), "My Video_final_v2.mp4");
    const second = await h.runner.run({ id: "job2" }, h.facts).done;
    assert.equal(path.basename(second.deliverable ?? ""), "My Video_final_v4.mp4");
    assert.equal(
      fs.readFileSync(path.join(h.outputDir, "My Video_final_v1.mp4"), "utf8"),
      "old one",
    );
    assert.equal(
      fs.readFileSync(path.join(h.outputDir, "My Video_final_v3.mp4"), "utf8"),
      "old three",
    );
  });

  it("counts the job with the limits and records every child", async () => {
    const h = harness();
    await h.runner.run({ id: "job1" }, h.facts).done;
    const started = h.limits.events.filter((e) => e.startsWith("started"));
    assert.equal(started[0], "started:render:pid");
    assert.equal(h.limits.events.at(-1), "ended");
    assert.equal(h.limits.events.filter((e) => e === "ended").length, 1);
    assert.equal(started.length, 3);
    assert.equal(h.registryEvents.filter((e) => e.startsWith("add")).length, 5);
    assert.equal(h.registryEvents.filter((e) => e === "remove").length, 5);
    assert.ok(h.registryEvents.every((e) => e === "remove" || e === "add:number"));
  });

  it("logs the stages in words and reaches 100 percent", async () => {
    const h = harness();
    await h.runner.run({ id: "job1" }, h.facts).done;
    const lines = h.lines();
    assert.ok(
      lines.some((l) => l.includes("Rendering the final video at 1080p (30 fps, 1 worker)")),
    );
    assert.ok(lines.some((l) => l.includes("Compiling the project")));
    assert.ok(lines.some((l) => l.includes("Capturing frames")));
    assert.ok(lines.some((l) => l.includes("Levelling the sound from -20.4 to -14 LUFS")));
    assert.ok(lines.some((l) => l.includes("Saved My Video_final_v1.mp4")));
    assert.ok(h.logged.every((e) => e.videoKey === h.facts.videoKey && e.jobId === "job1"));
    assert.ok(!lines.some((l) => l.includes("@hf-")));
    const views = h.updates.flatMap((u) => (u.progress ? [u.progress.view] : []));
    assert.equal(views.at(-1)?.percent, 100);
    assert.ok(views.every((v, i) => i === 0 || v.percent >= (views[i - 1]?.percent ?? 0)));
    assert.ok(h.updates.every((u) => u.progress === undefined || u.progress.memory === null));
    assert.ok(views.some((v) => v.stage === "Levelling the sound"));
  });
});

describe("render runner: the sound", () => {
  it("leaves a file within 0.5 LU with a fine peak alone", async () => {
    const h = harness({ config: { loud: { input_i: -14.3, input_tp: -1.4 } } });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
    assert.equal(fs.readFileSync(outcome.deliverable ?? "", "utf8"), "FAKE-MP4:render");
    assert.deepEqual(
      h.calls().map((c) => c.tool),
      ["hyperframes", "ffprobe", "ffmpeg"],
    );
    assert.ok(h.lines().some((l) => l.includes("left as it is")));
  });

  it("levels a file whose peak is too high even when the loudness fits", async () => {
    const h = harness({ config: { loud: { input_i: -14.1, input_tp: 0.5 } } });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(fs.readFileSync(outcome.deliverable ?? "", "utf8"), "FAKE-MP4:levelled");
  });

  it("runs the two ffmpeg passes with the measured values", async () => {
    const h = harness();
    await h.runner.run({ id: "job1" }, h.facts).done;
    const [, , measure, level] = h.calls();
    assert.ok(measure?.argv.includes("print_format=json") === false);
    assert.ok(measure?.argv.some((a) => a.includes("print_format=json")));
    const joined = level?.argv.join(" ") ?? "";
    assert.ok(joined.includes("-c:v copy"));
    assert.ok(joined.includes("-c:a aac -b:a 320k -ar 48000 -movflags +faststart"));
    assert.ok(joined.includes("measured_I=-20.4"));
    assert.ok(joined.includes("linear=true"));
    assert.ok(joined.includes("I=-14:TP=-1"));
  });

  it("leaves a file without sound alone", async () => {
    const h = harness({ config: { probe: { frames: 60, audio: false } } });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
    assert.deepEqual(
      h.calls().map((c) => c.tool),
      ["hyperframes", "ffprobe"],
    );
    assert.ok(h.lines().some((l) => l.includes("no sound")));
  });

  it("leaves a silent file alone", async () => {
    const h = harness({ config: { loud: "silent" } });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
    assert.equal(h.calls().filter((c) => c.tool === "ffmpeg").length, 1);
    assert.ok(h.lines().some((l) => l.includes("silent")));
  });
});

describe("render runner: failures", () => {
  /** @param {ReturnType<typeof makeHarness>} h */
  async function failed(h) {
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.deliverable, null);
    assert.equal(outcome.error?.code, "failed");
    assert.deepEqual(cacheEntries(h), []);
    assert.equal(h.limits.events.at(-1), "ended");
    assert.ok(h.lines().some((l) => l.startsWith("error: ")));
    assert.deepEqual(
      fs.existsSync(h.outputDir)
        ? fs.readdirSync(h.outputDir).filter((n) => n.endsWith(".mp4"))
        : [],
      [],
    );
    return outcome.error?.message ?? "";
  }

  it("refuses a disk with too little room and names both numbers", async () => {
    const h = harness({ free: 2 * 1024 ** 3, project: { seconds: 900 } });
    const message = await failed(h);
    assert.match(message, /render this video at 1080p: it needs 20\.0 GB/u);
    assert.match(message, /1 GB for each minute of its 15:00 plus 5 GB/u);
    assert.match(message, /only 2\.0 GB are free/u);
    assert.deepEqual(h.calls(), []);
  });

  it("needs more room at 2160 than a disk that is enough at 1080", async () => {
    const h = harness({
      resolution: 2160,
      free: 30 * 1024 ** 3,
      project: { seconds: 900 },
    });
    const message = await failed(h);
    assert.match(message, /render this video at 2160p: it needs 83\.0 GB/u);
    assert.match(message, /5 GB for each minute of its 15:00 plus 8 GB/u);
    assert.match(message, /only 30\.0 GB are free/u);
    assert.deepEqual(h.calls(), []);
    const ok = harness({ free: 30 * 1024 ** 3, project: { seconds: 900 } });
    const outcome = await ok.runner.run({ id: "job1" }, ok.facts).done;
    assert.equal(outcome.state, "completed");
  });

  it("only logs a free space that cannot be read", async () => {
    const h = harness({
      free: async () => {
        throw new Error("no df");
      },
    });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
    assert.ok(h.log.lines.some((l) => l.level === "warn" && l.message.includes("unknown")));
  });

  it("explains a missing source file", async () => {
    const h = harness({ config: { hf: { mode: "fail-source" } } });
    const message = await failed(h);
    assert.match(message, /^A source file is missing: assets\/media\/aroll\.mp4\./u);
  });

  it("explains a graphic that threw", async () => {
    const h = harness({ config: { hf: { mode: "fail-graphic" } } });
    const message = await failed(h);
    assert.match(message, /^The graphic mg0 has an error: /u);
    assert.match(message, /nonexistentFunction is not defined/u);
  });

  it("falls back to the last lines when there is no diagnostic code", async () => {
    const h = harness({ config: { hf: { mode: "fail-plain" } } });
    const message = await failed(h);
    assert.match(message, /^The renderer failed \(exit code 1\): /u);
    assert.match(message, /something odd happened/u);
  });

  it("fails when the renderer writes no file", async () => {
    const h = harness({ config: { hf: { mode: "no-output" } } });
    assert.match(await failed(h), /did not write a video file/u);
  });

  it("fails when the frame count is off by more than one", async () => {
    const h = harness({ config: { probe: { frames: 50 } } });
    assert.match(await failed(h), /has 50 frames but the project has 60/u);
  });

  it("accepts a frame count that is off by one", async () => {
    const h = harness({ config: { probe: { frames: 61 } } });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
  });

  it("fails when the file has no picture", async () => {
    const h = harness({ config: { probe: { video: false } } });
    assert.match(await failed(h), /no picture/u);
  });

  it("fails rather than delivering an unlevelled file", async () => {
    const h = harness({ config: { ffmpeg: { failLevel: true } } });
    assert.match(await failed(h), /could not be levelled/u);
  });

  it("fails when the sound cannot be measured", async () => {
    const h = harness({ config: { ffmpeg: { failMeasure: true } } });
    assert.match(await failed(h), /could not be measured/u);
  });

  it("fails when the levelled file lost its sound", async () => {
    const h = harness({ config: { levelled: { audio: false } } });
    assert.match(await failed(h), /lost its picture or its sound/u);
  });

  it("fails without ffmpeg or ffprobe", async () => {
    const h = harness({ deps: { ffmpeg: null } });
    assert.match(await failed(h), /ffmpeg is not installed/u);
    const g = harness({ deps: { ffprobe: () => null } });
    assert.match(await failed(g), /ffprobe is not installed/u);
  });

  it("fails for a project that cannot be read", async () => {
    const h = harness();
    fs.rmSync(path.join(h.projectDir, "index.html"));
    assert.match(await failed(h), /no index\.html/u);
  });

  it("fails for a bad job id or resolution without touching the disk", async () => {
    const h = harness();
    const bad = await h.runner.run({ id: "../evil" }, h.facts).done;
    assert.equal(bad.state, "failed");
    const res = await h.runner.run(
      { id: "job1" },
      /** @type {never} */ ({ ...h.facts, resolution: 720 }),
    ).done;
    assert.equal(res.state, "failed");
    assert.deepEqual(h.calls(), []);
    assert.equal(fs.existsSync(path.join(h.dataDir, "evil")), false);
  });

  it("cleans up after a step that throws", async () => {
    const h = harness();
    const limits = fakeLimits();
    limits.api.limitsFor = () => {
      throw new Error("limits exploded");
    };
    const g = harness({ limits });
    const outcome = await g.runner.run({ id: "job1" }, g.facts).done;
    assert.equal(outcome.state, "failed");
    assert.match(outcome.error?.message ?? "", /failed unexpectedly: limits exploded/u);
    assert.equal(g.limits.events.at(-1), "ended");
    assert.deepEqual(cacheEntries(g), []);
    assert.equal(h.runner !== g.runner, true);
  });

  it("gives the slot back and deletes the folder after a failed render", async () => {
    const h = harness({ config: { hf: { mode: "fail-source" } } });
    await h.runner.run({ id: "job1" }, h.facts).done;
    assert.ok(h.limits.events.includes("slot:taken"));
    assert.ok(h.limits.events.includes("slot:released"));
    assert.deepEqual(cacheEntries(h), []);
  });
});

describe("render runner: the GPU slot", () => {
  it("renders in software when the slots cannot be used", async () => {
    const h = harness({ limits: fakeLimits({ gpu: "broken" }) });
    const outcome = await h.runner.run({ id: "job1" }, h.facts).done;
    assert.equal(outcome.state, "completed");
    assert.ok(!(h.calls()[0]?.argv ?? []).includes("--gpu"));
    assert.ok(h.lines().some((l) => l.includes("without the GPU")));
  });

  it("waits for a slot, says so, and renders with --gpu once it has one", async () => {
    const limits = fakeLimits({ gpu: "wait" });
    const h = harness({ limits });
    const run = h.runner.run({ id: "job1" }, h.facts);
    await waitFor(
      () => h.lines().some((l) => l.includes("Waiting for a free GPU slot")),
      "the note",
    );
    assert.deepEqual(h.calls(), []);
    limits.grant();
    const outcome = await run.done;
    assert.equal(outcome.state, "completed");
    assert.ok((h.calls()[0]?.argv ?? []).includes("--gpu"));
    assert.equal(limits.events.filter((e) => e === "slot:released").length >= 1, true);
  });

  it("gives the slot back as soon as the renderer is done", async () => {
    const h = harness({ config: { ffmpeg: { hangLevel: true } } });
    const run = h.runner.run({ id: "job1" }, h.facts);
    await waitFor(
      () => h.calls().some((c) => c.tool === "ffmpeg" && c.argv.includes("copy")),
      "levelling",
    );
    assert.ok(h.limits.events.includes("slot:released"));
    run.stop();
    await run.done;
  });
});

describe("render runner: stop", () => {
  it("stops a wait for a slot", async () => {
    const limits = fakeLimits({ gpu: "wait" });
    const h = harness({ limits });
    const run = h.runner.run({ id: "job1" }, h.facts);
    await waitFor(() => limits.isWaiting, "the wait");
    run.stop();
    const outcome = await run.done;
    assert.equal(outcome.state, "stopped");
    assert.equal(outcome.error, null);
    assert.ok(limits.events.includes("slot:aborted"));
    assert.deepEqual(h.calls(), []);
    assert.deepEqual(cacheEntries(h), []);
    assert.equal(limits.events.at(-1), "ended");
  });

  it("stops the renderer and leaves no process and no folder", async () => {
    const h = harness({ config: { hf: { mode: "hang" } } });
    const run = h.runner.run({ id: "job1" }, h.facts);
    await waitFor(() => h.lines().some((l) => l.includes("Capturing frames")), "the capture");
    const pid = h.calls()[0]?.pid ?? 0;
    assert.ok(alive(pid));
    run.stop();
    run.stop();
    const outcome = await run.done;
    assert.equal(outcome.state, "stopped");
    assert.equal(outcome.deliverable, null);
    assert.equal(alive(pid), false);
    assert.ok(h.limits.events.includes("resumed"));
    assert.deepEqual(cacheEntries(h), []);
    assert.equal(h.limits.events.at(-1), "ended");
    assert.ok(h.lines().includes("status: The render was stopped"));
    assert.equal(
      fs.existsSync(h.outputDir) && fs.readdirSync(h.outputDir).some((n) => n.endsWith(".mp4")),
      false,
    );
  });

  it("stops while the sound is levelled", async () => {
    const h = harness({ config: { ffmpeg: { hangLevel: true } } });
    const run = h.runner.run({ id: "job1" }, h.facts);
    await waitFor(
      () => h.calls().some((c) => c.tool === "ffmpeg" && c.argv.includes("copy")),
      "levelling",
    );
    const pid = h.calls().at(-1)?.pid ?? 0;
    run.stop();
    const outcome = await run.done;
    assert.equal(outcome.state, "stopped");
    assert.equal(alive(pid), false);
    assert.deepEqual(cacheEntries(h), []);
    assert.equal(
      fs.existsSync(h.outputDir) && fs.readdirSync(h.outputDir).some((n) => n.endsWith(".mp4")),
      false,
    );
  });

  it("stopped before it started does not start anything", async () => {
    const limits = fakeLimits({ gpu: "wait" });
    const h = harness({ limits });
    const run = h.runner.run({ id: "job1" }, h.facts);
    run.stop();
    const outcome = await run.done;
    assert.equal(outcome.state, "stopped");
    assert.deepEqual(h.calls(), []);
  });

  it("comes too late once the file is being saved", async () => {
    /** @type {{ stop(): void } | null} */
    let handle = null;
    const h = harness({
      deps: {
        fileOps: {
          mkdir: async (dir) => void (await fs.promises.mkdir(dir, { recursive: true })),
          link: async (from, to) => {
            handle?.stop();
            await fs.promises.link(from, to);
          },
          copy: async () => {},
          unlink: async (file) => fs.promises.unlink(file),
        },
      },
    });
    fs.mkdirSync(h.outputDir, { recursive: true });
    const run = h.runner.run({ id: "job1" }, h.facts);
    handle = run;
    const outcome = await run.done;
    assert.equal(outcome.state, "completed");
    assert.ok(fs.existsSync(path.join(h.outputDir, "My Video_final_v1.mp4")));
    assert.deepEqual(cacheEntries(h), []);
  });
});

describe("render runner: sweep", () => {
  it("deletes folders of jobs that are not running and keeps the running ones", async () => {
    const h = harness();
    for (const name of ["old1", "old2", "alive"]) {
      fs.mkdirSync(path.join(h.cacheDir(), name, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(h.cacheDir(), name, "tmp", "x"), "x");
    }
    const removed = await h.runner.sweep(["alive"]);
    assert.equal(removed, 2);
    assert.deepEqual(cacheEntries(h), ["alive"]);
  });

  it("does nothing without a cache folder", async () => {
    const h = harness();
    assert.equal(await h.runner.sweep(), 0);
  });

  it("never deletes the folder of a job running now", async () => {
    const h = harness({ config: { hf: { mode: "hang" } } });
    const run = h.runner.run({ id: "job1" }, h.facts);
    await waitFor(() => h.lines().some((l) => l.includes("Capturing frames")), "the capture");
    fs.mkdirSync(path.join(h.cacheDir(), "other"), { recursive: true });
    assert.equal(await h.runner.sweep(), 1);
    assert.deepEqual(cacheEntries(h), ["job1"]);
    run.stop();
    await run.done;
  });
});

describe("render runner: patches", () => {
  it("sends each job's patches to its own handler", async () => {
    const h = harness();
    /** @type {string[]} */
    const a = [];
    /** @type {string[]} */
    const b = [];
    const [ra, rb] = await Promise.all([
      h.runner.run({ id: "a", onUpdate: (p) => void a.push(p.lastActivity ?? "") }, h.facts).done,
      h.runner.run({ id: "b", onUpdate: (p) => void b.push(p.lastActivity ?? "") }, h.facts).done,
    ]);
    assert.equal(ra.state, "completed");
    assert.equal(rb.state, "completed");
    assert.ok(a.length > 0 && b.length > 0);
    assert.ok(
      a.includes("Saved My Video_final_v1.mp4") || a.includes("Saved My Video_final_v2.mp4"),
    );
    assert.deepEqual(h.updates, []);
  });
});

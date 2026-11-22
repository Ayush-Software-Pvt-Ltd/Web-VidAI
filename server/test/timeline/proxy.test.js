// Preview copies end to end with a fake ffprobe and ffmpeg (docs/SPEC.md section 11, Preview copies).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hardwareChoice } from "../../src/platform/encoders.js";
import { createPreviewCopies, PREVIEW_COPIES_EVENT } from "../../src/timeline/proxy.js";
import { fakeFfmpeg, fakeLimits, fakeProbe, makeWorld, probeJson, until } from "./proxySupport.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const HEAVY = () => probeJson({ vcodec: "hevc", w: 3840, h: 2160 });
const LIGHT = () => probeJson({});

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @param {{ answers?: Record<string, unknown>, hold?: boolean, hardware?: import("../../src/platform/encoders.js").EncoderChoice | null, ffmpeg?: string | null, ffprobe?: string | null, maxBytes?: () => number | null }} [options]
 */
function build(world, options = {}) {
  const probe = fakeProbe(options.answers ?? {});
  const ffmpeg = fakeFfmpeg(options.hold ? { hold: true } : {});
  const limits = fakeLimits();
  /** @type {{ event: string, payload: any, userId: string | null, admins: boolean }[]} */
  const events = [];
  /** @type {string[]} */
  const registry = [];
  const copies = createPreviewCopies({
    dataDir: world.dataDir,
    limits: limits.api,
    registry: {
      add: async ({ jobId, pid }) => void registry.push(`add ${jobId} ${pid}`),
      remove: async (pid) => void registry.push(`remove ${pid}`),
    },
    events: { emit: (event) => void events.push(/** @type {any} */ (event)) },
    clock: { now: () => Date.now() },
    log,
    ffmpeg: () => (options.ffmpeg === undefined ? "ffmpeg" : options.ffmpeg),
    ffprobe: () => (options.ffprobe === undefined ? "ffprobe" : options.ffprobe),
    helper: probe,
    run: ffmpeg.start,
    encoders: {
      h264: async () => options.hardware ?? null,
      toneMapping: async () => false,
    },
    gpuWaitMs: 5,
    statTtlMs: 0,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  return { copies, probe, ffmpeg, limits, events, registry };
}

test("heavy files get a copy, light ones and pictures do not", async () => {
  const world = makeWorld();
  try {
    const hevc = world.addMedia("a-roll.mov");
    const light = world.addMedia("light.mp4");
    world.addMedia("cover.jpg");
    world.addMedia("music.mp3");
    const t = build(world, { answers: { [hevc]: HEAVY(), [light]: LIGHT() } });
    const state = await t.copies.ensureFor("k1", world.projectDir, world.scope);
    assert.deepEqual(state, { total: 1, done: 0, running: true });
    await t.copies.idle();
    assert.deepEqual(t.copies.state("k1"), { total: 1, done: 1, running: false });
    assert.deepEqual(
      t.probe.calls.sort(),
      [hevc, light].sort(),
      "the picture and the sound file are never probed",
    );
    assert.equal(t.ffmpeg.runs.length, 1);
    const copy = t.copies.proxyFor(hevc);
    assert.ok(copy?.endsWith(".mp4"));
    assert.ok(copy?.startsWith(path.join(world.dataDir, "cache", "proxy")));
    assert.equal(fs.readFileSync(/** @type {string} */ (copy), "utf8"), "copy");
    assert.equal(t.copies.proxyFor(light), null);
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("a copy is written under a temporary name and renamed when whole", async () => {
  const world = makeWorld();
  try {
    const hevc = world.addMedia("a.mov");
    const t = build(world, { answers: { [hevc]: HEAVY() }, hold: true });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await until(() => t.ffmpeg.runs.length >= 1, "the copy to start");
    const run = t.ffmpeg.runs[0];
    assert.ok(run?.output.endsWith(".part"));
    assert.equal(t.copies.proxyFor(hevc), null, "nothing is served while it is being made");
    run?.release(0);
    await t.copies.idle();
    assert.ok(t.copies.proxyFor(hevc));
    const dir = path.join(world.dataDir, "cache", "proxy");
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".part")),
      [],
    );
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("what was learned about files is kept: no second probe, and a restart probes nothing", async () => {
  const world = makeWorld();
  try {
    const hevc = world.addMedia("a.mov");
    const light = world.addMedia("b.mp4");
    const answers = { [hevc]: HEAVY(), [light]: LIGHT() };
    const first = build(world, { answers });
    await first.copies.ensureFor("k1", world.projectDir, world.scope);
    await first.copies.idle();
    await first.copies.ensureFor("k1", world.projectDir, world.scope);
    assert.equal(first.probe.calls.length, 2);
    assert.equal(first.ffmpeg.runs.length, 1);
    await first.copies.stop();

    const second = build(world, { answers });
    const state = await second.copies.ensureFor("k1", world.projectDir, world.scope);
    assert.deepEqual(state, { total: 1, done: 1, running: false });
    assert.equal(second.probe.calls.length, 0);
    assert.equal(second.ffmpeg.runs.length, 0, "the copy from the earlier run is used");
    assert.ok(second.copies.proxyFor(hevc));
  } finally {
    world.cleanup();
  }
});

test("copies are made one file at a time, in the order of the project", async () => {
  const world = makeWorld();
  try {
    const files = ["a.mov", "b.mov", "c.mov"].map((name) => world.addMedia(name));
    const answers = Object.fromEntries(files.map((f) => [f, HEAVY()]));
    const t = build(world, { answers, hold: true });
    const state = await t.copies.ensureFor("k1", world.projectDir, world.scope);
    assert.deepEqual(state, { total: 3, done: 0, running: true });
    await until(() => t.ffmpeg.runs.length === 1, "the first copy");
    t.ffmpeg.runs[0]?.release(0);
    await until(() => t.ffmpeg.runs.length === 2, "the second copy");
    assert.deepEqual(t.copies.state("k1"), { total: 3, done: 1, running: true });
    t.ffmpeg.runs[1]?.release(0);
    await until(() => t.ffmpeg.runs.length === 3, "the third copy");
    t.ffmpeg.runs[2]?.release(0);
    await t.copies.idle();
    assert.deepEqual(t.copies.state("k1"), { total: 3, done: 3, running: false });
    const inputs = t.ffmpeg.runs.map((r) => r.args[r.args.indexOf("-i") + 1]);
    assert.deepEqual(inputs, files);
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("a file two videos need is made once; each video's state counts it", async () => {
  const world = makeWorld();
  try {
    const shared = world.addMedia("shared.mov");
    const t = build(world, { answers: { [shared]: HEAVY() }, hold: true });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.ensureFor("k2", world.projectDir, { ...world.scope, videoId: "chan/other" });
    t.ffmpeg.runs[0]?.release(0);
    await t.copies.idle();
    assert.equal(t.ffmpeg.runs.length, 1);
    assert.deepEqual(t.copies.state("k1"), { total: 1, done: 1, running: false });
    assert.deepEqual(t.copies.state("k2"), { total: 1, done: 1, running: false });
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("events go to the owner, only when the state changed, with the video's id", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const b = world.addMedia("b.mov");
    const t = build(world, { answers: { [a]: HEAVY(), [b]: HEAVY() } });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    const seen = t.events.map((e) => e.payload.copies);
    assert.deepEqual(seen[0], { total: 2, done: 0, running: true });
    assert.deepEqual(seen.at(-1), { total: 2, done: 2, running: false });
    for (const e of t.events) {
      assert.equal(e.event, PREVIEW_COPIES_EVENT);
      assert.equal(e.event, "preview-copies-changed");
      assert.equal(e.userId, "user-1");
      assert.equal(e.admins, false);
      assert.equal(e.payload.videoId, "chan/video");
    }
    const keys = t.events.map((e) => JSON.stringify(e.payload.copies));
    assert.equal(new Set(keys).size, keys.length, "no event repeats the state before it");
    const count = t.events.length;
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    assert.equal(t.events.length, count, "nothing changed, nothing is sent");
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("a project without heavy files says nothing and has no work", async () => {
  const world = makeWorld();
  try {
    const light = world.addMedia("a.mp4");
    const t = build(world, { answers: { [light]: LIGHT() } });
    assert.deepEqual(await t.copies.ensureFor("k1", world.projectDir, world.scope), {
      total: 0,
      done: 0,
      running: false,
    });
    assert.deepEqual(t.events, []);
    assert.deepEqual(t.copies.state("unknown-video"), { total: 0, done: 0, running: false });
  } finally {
    world.cleanup();
  }
});

test("cancelFor drops queued copies, ends the running one and stops the events", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const b = world.addMedia("b.mov");
    const t = build(world, { answers: { [a]: HEAVY(), [b]: HEAVY() }, hold: true });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await until(() => t.ffmpeg.runs.length >= 1, "the copy to start");
    const before = t.events.length;
    t.copies.cancelFor("k1");
    await t.copies.idle();
    assert.equal(t.ffmpeg.runs.length, 1, "b was never started");
    assert.equal(t.ffmpeg.runs[0]?.stopped, true);
    assert.deepEqual(t.copies.state("k1"), { total: 0, done: 0, running: false });
    assert.equal(t.events.length, before);
    assert.equal(t.copies.proxyFor(a), null);
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("cancelFor during the listing stops that listing", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    /** @type {() => void} */
    let letGo = () => {};
    const gate = new Promise((resolve) => {
      letGo = () => resolve(undefined);
    });
    const t = build(world, { answers: { [a]: () => gate.then(HEAVY) } });
    const pending = t.copies.ensureFor("k1", world.projectDir, world.scope);
    await until(() => t.probe.calls.length >= 1, "the probe to start");
    t.copies.cancelFor("k1");
    letGo();
    await pending;
    await t.copies.idle();
    assert.equal(t.ffmpeg.runs.length, 0);
    assert.deepEqual(t.copies.state("k1"), { total: 0, done: 0, running: false });
  } finally {
    world.cleanup();
  }
});

test("stop ends the running ffmpeg and resolves", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const t = build(world, { answers: { [a]: HEAVY() }, hold: true });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await until(() => t.ffmpeg.runs.length >= 1, "the copy to start");
    await t.copies.stop();
    assert.equal(t.ffmpeg.runs[0]?.stopped, true);
    assert.deepEqual(
      fs.readdirSync(path.join(world.dataDir, "cache", "proxy")).filter((f) => f.endsWith(".mp4")),
      [],
    );
    assert.equal(t.limits.log.at(-1)?.startsWith("ended"), true, "the job is ended in the limits");
  } finally {
    world.cleanup();
  }
});

test("a failed copy is remembered, the original is served, and a restart tries again", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const answers = { [a]: HEAVY() };
    const t = build(world, { answers, hold: true });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await until(() => t.ffmpeg.runs.length >= 1, "the copy to start");
    t.ffmpeg.runs[0]?.release(1);
    await t.copies.idle();
    assert.equal(t.copies.proxyFor(a), null);
    assert.deepEqual(t.copies.state("k1"), { total: 0, done: 0, running: false });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.ensureFor("k2", world.projectDir, world.scope, { first: true });
    await t.copies.idle();
    assert.equal(t.ffmpeg.runs.length, 1, "not retried in a loop");
    assert.deepEqual(
      fs.readdirSync(path.join(world.dataDir, "cache", "proxy")).filter((f) => f.endsWith(".part")),
      [],
    );
    await t.copies.stop();

    const again = build(world, { answers });
    await again.copies.ensureFor("k1", world.projectDir, world.scope);
    await again.copies.idle();
    assert.equal(again.ffmpeg.runs.length, 1);
    assert.ok(again.copies.proxyFor(a));
  } finally {
    world.cleanup();
  }
});

test("a replaced original is a new file: its old copy stops matching and a new one is made", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov", 100);
    const t = build(world, { answers: { [a]: HEAVY() } });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    const first = t.copies.proxyFor(a);
    assert.ok(first);
    fs.writeFileSync(a, Buffer.alloc(150, 3));
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    assert.equal(t.ffmpeg.runs.length, 2);
    const second = t.copies.proxyFor(a);
    assert.ok(second);
    assert.notEqual(second, first);
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("only files inside the video folder or the channel directory are used", async () => {
  const world = makeWorld();
  try {
    const inside = world.addMedia("a.mov");
    const outside = path.join(world.root, "elsewhere.mov");
    fs.writeFileSync(outside, "x");
    fs.symlinkSync(outside, path.join(world.projectDir, "assets", "media", "elsewhere.mov"));
    const channelLevel = path.join(world.channel, "shared.mov");
    fs.writeFileSync(channelLevel, "x");
    fs.symlinkSync(channelLevel, path.join(world.projectDir, "assets", "media", "shared.mov"));
    fs.writeFileSync(path.join(world.projectDir, "assets", "media", ".hidden.mov"), "x");
    const t = build(world, {
      answers: { [inside]: HEAVY(), [outside]: HEAVY(), [channelLevel]: HEAVY() },
    });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    assert.deepEqual(t.probe.calls.sort(), [channelLevel, inside].sort());
    assert.equal(t.copies.proxyFor(outside), null);
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("the same real file linked under two names is probed and made once", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    fs.symlinkSync(a, path.join(world.projectDir, "assets", "media", "again.mov"));
    const t = build(world, { answers: { [a]: HEAVY() } });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    assert.equal(t.probe.calls.length, 1);
    assert.equal(t.ffmpeg.runs.length, 1);
    assert.deepEqual(t.copies.state("k1"), { total: 1, done: 1, running: false });
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("a project without media folder, or a file that cannot be read, is no error", async () => {
  const world = makeWorld();
  try {
    const broken = world.addMedia("broken.mov");
    const t = build(world, { answers: {} });
    assert.deepEqual(await t.copies.ensureFor("k1", world.projectDir, world.scope), {
      total: 0,
      done: 0,
      running: false,
    });
    assert.equal(t.probe.calls.includes(broken), true);
    assert.deepEqual(
      await t.copies.ensureFor("k2", path.join(world.root, "no-such-project"), world.scope),
      { total: 0, done: 0, running: false },
    );
  } finally {
    world.cleanup();
  }
});

test("without ffprobe nothing is probed or queued; without ffmpeg a copy fails quietly", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const noProbe = build(world, { answers: { [a]: HEAVY() }, ffprobe: null });
    assert.deepEqual(await noProbe.copies.ensureFor("k1", world.projectDir, world.scope), {
      total: 0,
      done: 0,
      running: false,
    });
    assert.equal(noProbe.probe.calls.length, 0);
    const noFfmpeg = build(world, { answers: { [a]: HEAVY() }, ffmpeg: null });
    await noFfmpeg.copies.ensureFor("k1", world.projectDir, world.scope);
    await noFfmpeg.copies.idle();
    assert.equal(noFfmpeg.ffmpeg.runs.length, 0);
    assert.equal(noFfmpeg.copies.proxyFor(a), null);
  } finally {
    world.cleanup();
  }
});

test("the copy is a heavy job of kind proxy: counted in the limits, recorded, threads from its budget", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const t = build(world, { answers: { [a]: HEAVY() } });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    const log = t.limits.log;
    const started = log.findIndex((l) => l.startsWith("started"));
    assert.ok(log[started]?.includes(" proxy 4001"), log.join("|"));
    assert.ok(log.findIndex((l) => l.startsWith("env")) < started, "the budget is asked first");
    assert.ok(log.at(-1)?.startsWith("ended"));
    assert.deepEqual(
      t.registry.map((r) => r.replace(/proxy-[0-9a-f]+/, "proxy-X")),
      ["add proxy-X 4001", "remove 4001"],
    );
    const args = /** @type {string[]} */ (t.ffmpeg.runs[0]?.args);
    assert.equal(args[args.indexOf("-threads") + 1], "3");
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("with a hardware encoder and a free GPU slot the copy uses it and gives the slot back", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const t = build(world, {
      answers: { [a]: HEAVY() },
      hardware: hardwareChoice("videotoolbox"),
    });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    const args = /** @type {string[]} */ (t.ffmpeg.runs[0]?.args);
    assert.equal(args[args.indexOf("-c:v") + 1], "h264_videotoolbox");
    assert.ok(t.limits.log.some((l) => l.startsWith("gpu proxy-")));
    assert.ok(t.limits.log.some((l) => l.startsWith("gpu released")));
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("with no GPU slot to be had at once the copy goes through the CPU", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const t = build(world, { answers: { [a]: HEAVY() }, hardware: hardwareChoice("nvenc") });
    t.limits.setGpuFree(false);
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    const args = /** @type {string[]} */ (t.ffmpeg.runs[0]?.args);
    assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
    assert.equal(t.ffmpeg.runs.length, 1);
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("a hardware encode that fails is tried once more in software", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const t = build(world, {
      answers: { [a]: HEAVY() },
      hardware: hardwareChoice("videotoolbox"),
      hold: true,
    });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await until(() => t.ffmpeg.runs.length === 1, "the hardware copy");
    t.ffmpeg.runs[0]?.release(1);
    await until(() => t.ffmpeg.runs.length === 2, "the software copy");

    assert.equal(t.ffmpeg.runs.length, 2);
    const second = /** @type {string[]} */ (t.ffmpeg.runs[1]?.args);
    assert.equal(second[second.indexOf("-c:v") + 1], "libx264");
    t.ffmpeg.runs[1]?.release(0);
    await t.copies.idle();
    assert.ok(t.copies.proxyFor(a));
    assert.ok(t.limits.log.some((l) => l.startsWith("gpu released")));
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("the sweep and the usage go through the store", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov");
    const t = build(world, { answers: { [a]: HEAVY() } });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    assert.deepEqual(await t.copies.usage(), { files: 1, bytes: 4 });
    assert.deepEqual(await t.copies.sweep(), { deleted: 0, freedBytes: 0 });
    fs.rmSync(a);
    assert.deepEqual(await t.copies.sweep(), { deleted: 1, freedBytes: 4 });
    assert.deepEqual(await t.copies.usage(), { files: 0, bytes: 0 });
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

test("the size cap setting decides how much the sweep keeps", async () => {
  const world = makeWorld();
  try {
    const a = world.addMedia("a.mov", 100);
    const b = world.addMedia("b.mov", 101);
    const t = build(world, { answers: { [a]: HEAVY(), [b]: HEAVY() }, maxBytes: () => 4 });
    await t.copies.ensureFor("k1", world.projectDir, world.scope);
    await t.copies.idle();
    assert.deepEqual(await t.copies.sweep(), { deleted: 1, freedBytes: 4 });
    await t.copies.stop();
  } finally {
    world.cleanup();
  }
});

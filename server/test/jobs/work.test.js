// Evidence of work (files a real edit writes), plus the busy-workers rules.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUSY_HOLD_MS,
  WAIT_MESSAGE_EVERY_MS,
  componentsInWork,
  createWorkerWatch,
  evidence,
  isPlanName,
  kindsOf,
  kindsOfPath,
  scan,
} from "../../src/jobs/work.js";

/** @typedef {import("../../src/jobs/workFiles.js").Kinds} Kinds */

/**
 * @param {Partial<Kinds>} [on]
 * @returns {Kinds}
 */
function only(on = {}) {
  return {
    audio: false,
    transcript: false,
    plan: false,
    graphics: false,
    qualityCheck: false,
    ...on,
  };
}

test("the files a real edit writes are told apart", () => {
  /** @type {[string, Kinds][]} */
  const table = [
    // The footage check.
    ["CLAUDE_VE/audio/a1_48k.wav", only({ audio: true })],
    ["CLAUDE_VE/build/recon.json", only()],
    ["CLAUDE_VE/build/contact_001.jpg", only()],
    // Transcription.
    ["CLAUDE_VE/transcripts/a1.full.json", only({ transcript: true })],
    ["CLAUDE_VE/transcripts/a1/a1.chunks.json", only({ transcript: true })],
    ["CLAUDE_VE/TRANSCRIPT.md", only({ transcript: true })],
    ["subs/take1.SRT", only({ transcript: true })],
    // The plan.
    ["CLAUDE_VE/timeline.py", only({ plan: true })],
    ["CLAUDE_VE/build/timeline.json", only({ plan: true })],
    ["CLAUDE_VE/PLAN.md", only({ plan: true })],
    ["CLAUDE_VE/GFX_SPEC.md", only({ plan: true })],
    ["CLAUDE_VE/scripts_cues.py", only({ plan: true })],
    ["CLAUDE_VE/build/cues.json", only({ plan: true })],
    ["CLAUDE_VE/shot_list.txt", only({ plan: true })],
    // Graphics, sources and renders.
    ["CLAUDE_VE/gfx_src/hook/index.html", only({ graphics: true })],
    ["CLAUDE_VE/gfx/1080/hook.mov", only({ graphics: true })],
    ["CLAUDE_VE/graphics/title.png", only({ graphics: true })],
    ["CLAUDE_VE/gfx_src/price/timeline.json", only({ graphics: true })],
    // Quality checks.
    ["CLAUDE_VE/build/720/qa_sheet_1.jpg", only({ qualityCheck: true })],
    ["CLAUDE_VE/build/720/qa_frames/shot_000.jpg", only({ qualityCheck: true })],
    ["CLAUDE_VE/transcripts_qa/mix_win.json", only({ qualityCheck: true })],
    ["CLAUDE_VE/qa.chunks.json", only({ qualityCheck: true })],
    // Nothing to say.
    ["CLAUDE_VE/project.json", only()],
    ["CLAUDE_VE/hits.json", only()],
    ["CLAUDE_VE/broll/mezz/clip.mov", only()],
    ["CLAUDE_VE/assets/products/phone.png", only()],
    ["CLAUDE_VE/build/720/mix_raw.mov", only()],
    ["CLAUDE_VE/inspect_report.json", only()],
    ["CLAUDE_VE/gfx_src/hook/.hyperframes/x.json", only({ graphics: true })],
    ["info.txt", only()],
    ["Main.MP4", only()],
    ["CLAUDE_VE/build/720/mix.wav", only({ audio: true })],
  ];
  for (const [file, want] of table) assert.deepEqual(kindsOfPath(file), want, file);
  // The project, thumbnails and meta.txt belong to the project check of the output folder.
  for (const file of ["output/timeline_review_v1.hf", "output/meta.txt", "output/plan.txt"]) {
    assert.deepEqual(kindsOfPath(file), only(), file);
  }
  // The toolkit's own files are not the video's.
  assert.deepEqual(kindsOf(["claude_ve_all", "gfx", "t.html"]), only());
  assert.deepEqual(kindsOf([]), only());
});

test("the name of the video never changes the kind of its files", () => {
  // Absolute paths of the stream: only what follows the working folder counts.
  const video = "/Edits/Chan/Best Plan for graphics and QA";
  assert.deepEqual(kindsOfPath(`${video}/CLAUDE_VE/notes.md`), only());
  assert.deepEqual(kindsOfPath(`${video}/CLAUDE_VE/timeline.py`), only({ plan: true }));
  // Without a working folder, only the file name is looked at.
  assert.deepEqual(kindsOfPath(`${video}/notes.md`), only());
  assert.deepEqual(kindsOfPath(`${video}/plan.md`), only({ plan: true }));
  // Windows separators.
  assert.deepEqual(
    kindsOfPath("C:\\Edits\\Chan\\Video\\CLAUDE_VE\\gfx_src\\a\\index.html"),
    only({ graphics: true }),
  );
  assert.deepEqual(componentsInWork("/a/output/x.hf"), ["output", "x.hf"]);
  assert.deepEqual(componentsInWork("rel/./x.md"), ["rel", "x.md"]);
});

test("words, not substrings, name a plan", () => {
  for (const plan of ["plan", "edit_plan", "PLAN-v2", "planning notes", "timeline2", "cues"]) {
    assert.ok(isPlanName(plan.toLowerCase()), plan);
  }
  for (const other of ["inspect", "explanation", "template", "specimen_x"]) {
    // "specimen" starts with "spec": a known and harmless over-match, kept honest here.
    assert.equal(isPlanName(other), other === "specimen_x", other);
  }
});

test("evidence counts only files written since the start", () => {
  const start = 1_800_000_000_000;
  /**
   * @param {string} file
   * @param {number} afterSeconds
   */
  const at = (file, afterSeconds) => ({ path: file, modified: start + afterSeconds * 1000 });
  const files = [
    at("claude_ve/transcripts/old.json", -3600),
    at("claude_ve/audio/a1.wav", 5),
    at("claude_ve/timeline.py", 6),
    at("claude_ve/gfx_src/a/index.html", 7),
    at("output/meta.txt", 8),
  ];
  assert.deepEqual(evidence(files, start), {
    audio: true,
    transcript: false,
    plan: true,
    graphics: true,
    qualityCheck: false,
    files: 4,
  });
  // A file written half a second before the start (whole-second file systems) still counts.
  const edge = [at("claude_ve/qa_sheet.jpg", 0)];
  assert.ok(evidence(edge, start + 900).qualityCheck);
  assert.deepEqual(evidence([], start), { ...only(), files: 0 });
});

test("scan lists files relative and lower case and skips links and caches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-work-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-work-target-"));
  try {
    /** @param {string} rel */
    const make = (rel) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    };
    make("CLAUDE_VE/Transcripts/A1.full.json");
    make("CLAUDE_VE/gfx_src/hook/node_modules/pkg/index.js");
    make("CLAUDE_VE/gfx_src/hook/.hyperframes/state.json");
    make("CLAUDE_VE/__pycache__/x.pyc");
    make("output/Meta.txt");
    fs.writeFileSync(path.join(target, "secret.wav"), "x");
    try {
      fs.symlinkSync(target, path.join(dir, "CLAUDE_VE/link"), "dir");
      fs.symlinkSync(path.join(target, "secret.wav"), path.join(dir, "CLAUDE_VE/link.wav"));
    } catch {
      // No symlinks on this system: the rest of the test still holds.
    }
    const paths = scan(dir)
      .map((f) => f.path)
      .sort();
    assert.deepEqual(paths, ["claude_ve/transcripts/a1.full.json", "output/meta.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("scan stops at its time limit and never fails on a missing folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-work-"));
  try {
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    // A clock that jumps a second at every look: the scan gives up after the first entry.
    let t = 0;
    const found = scan(dir, { clock: { now: () => (t += 1000) }, maxMs: 1500 });
    assert.ok(found.length < 5);
    assert.deepEqual(scan(path.join(dir, "missing")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- busy workers ----

/**
 * A watch with a fake clock and a fake CPU: `cpu.total` is what the next sample returns.
 * @param {{ supported?: boolean, map?: boolean }} [options]
 */
function watch({ supported = true, map = false } = {}) {
  const state = {
    now: 1_000_000,
    /** CPU seconds of pid 11, 12. */
    cpu: new Map([
      [11, 0],
      [12, 0],
    ]),
    /** @type {number[][]} */
    asked: [],
  };
  const w = createWorkerWatch({
    clock: { now: () => state.now },
    supported,
    sample: (pids) => {
      state.asked.push([...pids]);
      return map ? new Map(state.cpu) : [...state.cpu.values()].reduce((a, b) => a + b, 0);
    },
  });
  return { state, w };
}

for (const map of [false, true]) {
  test(`a process using a tenth of a core makes the computer busy for 90 seconds (${map ? "per pid" : "total"})`, async () => {
    const { state, w } = watch({ map });
    await w.refresh([11, 12]); // the first look only sets the base
    assert.equal(w.busy(), false);
    state.now += 5000;
    state.cpu.set(11, 0.4); // under 0.5 s of 5 s
    await w.refresh([11, 12]);
    assert.equal(w.busy(), false);
    state.now += 5000;
    state.cpu.set(11, 0.4 + 0.5); // exactly a tenth of a core
    await w.refresh([11, 12]);
    assert.equal(w.busy(), true);
    assert.deepEqual(state.asked[0], [11, 12]);
    // Held for the hold time after the last busy look, then over.
    state.now += BUSY_HOLD_MS - 1;
    assert.equal(w.busy(), true);
    state.now += 2;
    assert.equal(w.busy(), false);
  });
}

test("a burst keeps extending the hold and a quiet look does not shorten it", async () => {
  const { state, w } = watch();
  await w.refresh([11]);
  state.now += 5000;
  state.cpu.set(11, 2);
  await w.refresh([11]);
  state.now += 60_000;
  await w.refresh([11]); // quiet look 60 s later
  assert.equal(w.busy(), true); // 90 s from the burst, 30 s left
  state.now += 29_000;
  assert.equal(w.busy(), true);
  state.now += 2000;
  assert.equal(w.busy(), false);
});

test("looks less than a second apart say nothing", async () => {
  const { state, w } = watch();
  await w.refresh([11]);
  state.now += 500;
  state.cpu.set(11, 5);
  await w.refresh([11]);
  assert.equal(w.busy(), false);
});

test("a process that ended never counts as growth", async () => {
  const { state, w } = watch();
  state.cpu.set(11, 100);
  await w.refresh([11, 12]);
  state.now += 5000;
  state.cpu.delete(11); // the total drops
  await w.refresh([12]);
  assert.equal(w.busy(), false);
});

test("per pid, a process that is new since the last look is not counted", async () => {
  const { state, w } = watch({ map: true });
  await w.refresh([11]);
  state.now += 5000;
  state.cpu.set(13, 50); // started after the base look: no baseline to grow from
  await w.refresh([11, 13]);
  assert.equal(w.busy(), false);
});

test("where CPU time cannot be read nothing is ever busy", async () => {
  const { state, w } = watch({ supported: false });
  await w.refresh([11]);
  state.now += 5000;
  state.cpu.set(11, 100);
  await w.refresh([11]);
  assert.equal(w.busy(), false);
  assert.equal(state.asked.length, 0);
  assert.deepEqual(w.idle(false), { workersBusy: false, skip: false });
});

test("a model is reminded to wait at most every five minutes, and a deliverable overrules", async () => {
  const { state, w } = watch();
  await w.refresh([11]);
  state.now += 5000;
  state.cpu.set(11, 3);
  await w.refresh([11]);
  assert.deepEqual(w.idle(false), { workersBusy: true, skip: false });
  w.noteWaitMessage();
  // Reminded a moment ago: this idle moment is left alone.
  state.now += 10_000;
  state.cpu.set(11, 6);
  await w.refresh([11]);
  assert.deepEqual(w.idle(false), { workersBusy: true, skip: true });
  // ... unless a deliverable exists, which is decided as ever.
  assert.deepEqual(w.idle(true), { workersBusy: true, skip: false });
  // After the interval it is due again (the computer is still busy).
  state.now += WAIT_MESSAGE_EVERY_MS;
  state.cpu.set(11, 60);
  await w.refresh([11]);
  assert.deepEqual(w.idle(false), { workersBusy: true, skip: false });
});

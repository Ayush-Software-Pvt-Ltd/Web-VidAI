// The header, the MACHINE line and the LIMITS line (docs/SPEC.md section 8, "Prompt").

import assert from "node:assert/strict";
import test from "node:test";
import {
  followUpOn,
  headerBlock,
  hfCommandLine,
  joinPath,
  limitsLine,
  machineLine,
  parentOf,
  programBlocks,
  separatorOf,
  trimBlock,
} from "../../src/jobs/promptHeader.js";
import { KEEP_WORKING, OPENCODE2_PROGRAM } from "../../src/jobs/promptTexts.js";
import { editInput } from "./promptSupport.js";

test("the header lists the absolute paths, the type, the check, the machine and the limits", () => {
  assert.deepEqual(headerBlock(editInput()).split("\n"), [
    "MAIN_FOLDER = /Users/e/Editing/Tech Reviews/2026-11-01 Unboxing",
    "CHANNEL_FOLDER = /Users/e/Editing/Tech Reviews",
    "TOOLKIT_FOLDER = /srv/vidai/toolkit/CLAUDE_VE_ALL",
    "PYTHON = /srv/vidai/toolkit/venv/bin/python",
    "Channel Name: Tech Reviews",
    "VIDEO_TYPE = Long",
    "BROLL_FOLDER = /Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/B-Roll",
    "PROJECT_FOLDER = /Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/output/2026-11-01 Unboxing.hf",
    'CHECK_COMMAND = node /srv/vidai/server/src/timeline/checkCli.js "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/output/2026-11-01 Unboxing.hf"',
    "MACHINE: macOS 15.4.1; CPU Apple M3 Max, 16 logical processors; memory 48 GB; GPU Apple M3 Max",
    "LIMITS: Use at most 6 processor cores and 2 GPU tasks at a time; the toolkit already obeys this through VE_CPU_CORES and the GPU slot files, so do not start heavy programs in parallel yourself.",
  ]);
  const short = { ...editInput(), videoType: /** @type {const} */ ("short") };
  assert.ok(headerBlock(short).includes("\nVIDEO_TYPE = Short\n"));
});

test("the machine line leaves out what is unknown", () => {
  const all = {
    os: "Windows",
    osVersion: "11 Pro (10.0.26100)",
    cpu: "12th Gen Intel Core i7-12700",
    logicalCores: 20,
    memoryGb: 32,
    gpu: "NVIDIA GeForce RTX 3060; Intel UHD Graphics 770",
  };
  assert.equal(
    machineLine(all),
    "MACHINE: Windows 11 Pro (10.0.26100); CPU 12th Gen Intel Core i7-12700, 20 logical processors; memory 32 GB; GPU NVIDIA GeForce RTX 3060; Intel UHD Graphics 770",
  );
  assert.equal(
    machineLine({ ...all, osVersion: null, gpu: null, memoryGb: null }),
    "MACHINE: Windows; CPU 12th Gen Intel Core i7-12700, 20 logical processors",
  );
  assert.equal(
    machineLine({ ...all, cpu: null }),
    "MACHINE: Windows 11 Pro (10.0.26100); 20 logical processors; memory 32 GB; GPU NVIDIA GeForce RTX 3060; Intel UHD Graphics 770",
  );
  assert.equal(
    machineLine({ ...all, logicalCores: null, memoryGb: null, gpu: null }),
    "MACHINE: Windows 11 Pro (10.0.26100); CPU 12th Gen Intel Core i7-12700",
  );
  assert.equal(
    machineLine({
      os: "Linux",
      osVersion: null,
      cpu: null,
      logicalCores: 1,
      memoryGb: null,
      gpu: null,
    }),
    "MACHINE: Linux; 1 logical processor",
  );
  assert.equal(
    machineLine({
      os: "macOS",
      osVersion: null,
      cpu: null,
      logicalCores: null,
      memoryGb: null,
      gpu: null,
    }),
    "MACHINE: macOS",
  );
});

test("the limits line says the budget in words, singular and plural", () => {
  assert.equal(
    limitsLine({ cpuCores: 6, gpuTasks: 2 }),
    "LIMITS: Use at most 6 processor cores and 2 GPU tasks at a time; the toolkit already obeys this through VE_CPU_CORES and the GPU slot files, so do not start heavy programs in parallel yourself.",
  );
  assert.ok(
    limitsLine({ cpuCores: 1, gpuTasks: 1 }).startsWith(
      "LIMITS: Use at most 1 processor core and 1 GPU task at a time;",
    ),
  );
  // Nonsense is made at least one, and whole.
  assert.ok(
    limitsLine({ cpuCores: 0, gpuTasks: Number.NaN }).includes("1 processor core and 1 GPU task "),
  );
  assert.ok(
    limitsLine({ cpuCores: 3.9, gpuTasks: 2.2 }).includes("3 processor cores and 2 GPU tasks "),
  );
  assert.equal(limitsLine({ cpuCores: 4, gpuTasks: 1 }).split("\n").length, 1);
});

test("paths are joined with the separator of their base, on both systems", () => {
  assert.equal(separatorOf("/srv/x"), "/");
  assert.equal(separatorOf("C:\\VidAI\\toolkit"), "\\");
  assert.equal(joinPath("/srv/x/", "ve.py"), "/srv/x/ve.py");
  assert.equal(joinPath("C:\\a\\b", "ve.py"), "C:\\a\\b\\ve.py");
  assert.equal(parentOf("C:\\a\\toolkit\\CLAUDE_VE_ALL"), "C:\\a\\toolkit");
  assert.equal(parentOf("/srv/vidai/toolkit/CLAUDE_VE_ALL/"), "/srv/vidai/toolkit");
  assert.equal(
    hfCommandLine(editInput()),
    '"/srv/vidai/toolkit/venv/bin/python" "/srv/vidai/toolkit/CLAUDE_VE_ALL/ve.py" hf "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing"',
  );
});

test("program and setup blocks and follow-ups", () => {
  assert.deepEqual(programBlocks("claudeSubscription", "claudeCode"), []);
  assert.deepEqual(programBlocks("anthropicApi", "claudeCode"), [KEEP_WORKING]);
  assert.deepEqual(programBlocks("opencodeGo", "opencode2"), [OPENCODE2_PROGRAM, KEEP_WORKING]);
  assert.deepEqual(programBlocks("openaiApi", "opencode2"), [OPENCODE2_PROGRAM, KEEP_WORKING]);
  assert.equal(followUpOn("Cut 2s.", "claudeSubscription"), "Cut 2s.");
  assert.equal(followUpOn("Cut 2s.", "opencodeGo"), `Cut 2s.\n\n${KEEP_WORKING}`);
  assert.equal(trimBlock("\n\r\nText\n\n"), "Text");
});

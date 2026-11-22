import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRendererOutput } from "../../src/render/rendererOutput.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "support",
  "fixtures",
  "hyperframes-render",
  "success.log",
);

function reader() {
  /** @type {string[]} */
  const statuses = [];
  /** @type {{ code: string, pct: number, activity: string }[]} */
  const progress = [];
  /** @type {string[]} */
  const stages = [];
  const output = createRendererOutput({
    status: (text) => void statuses.push(text),
    progress: (update, activity) =>
      void progress.push({ code: update.code, pct: update.pct, activity }),
    stage: (stage) => void stages.push(stage),
  });
  return { output, statuses, progress, stages };
}

describe("renderer output", () => {
  it("turns the real output into stage lines and progress", () => {
    const { output, statuses, progress } = reader();
    for (const line of fs.readFileSync(fixture, "utf8").split("\n")) output.line(line);
    assert.ok(statuses.includes("Compiling the project"));
    assert.ok(statuses.includes("Extracting video frames"));
    assert.ok(statuses.includes("Processing the audio"));
    assert.ok(statuses.some((s) => /^Capturing frames \(1500 frames\)$/u.test(s)));
    assert.ok(statuses.includes("Encoding the video"));
    assert.ok(statuses.includes("Assembling the file"));
    assert.ok(statuses.some((s) => /^Captured 25% of the frames \(\d+ of 1500\)$/u.test(s)));
    assert.ok(statuses.some((s) => /^Captured 75% of the frames/u.test(s)));
    assert.ok(statuses.some((s) => s.startsWith("Renderer timings: ")));
    assert.equal(statuses.filter((s) => s === "Compiling the project").length, 1);
    assert.ok(progress.length > 20);
    assert.ok(progress.some((p) => p.activity.startsWith("Capturing frame ")));
    assert.ok(statuses.every((s) => !s.includes("@hf-") && !s.includes("█")));
  });

  it("reads the output recorded from the real renderer on a 3 second project", () => {
    const { output, statuses, progress } = reader();
    const real = fixture.replace("success.log", "success-tiny.log");
    for (const line of fs.readFileSync(real, "utf8").split("\n")) output.line(line);
    assert.ok(statuses.includes("Capturing frames (90 frames)"));
    assert.ok(statuses.some((s) => /^Captured 75% of the frames/u.test(s)));
    assert.equal(progress.at(-1)?.code, "assemble");
    assert.ok(statuses.every((s) => !s.includes("@hf-")));
  });

  it("recomputes the percent of a stage from done and total", () => {
    const { output, progress } = reader();
    output.line('@hf-progress {"code":"capture","done":30,"total":120,"pct":40}');
    assert.equal(progress[0]?.pct, 25);
  });

  it("keeps a stage without numbers as a stage change", () => {
    const { output, stages, statuses } = reader();
    output.line('@hf-progress {"code":"start_browsers"}');
    assert.ok(stages.length + statuses.length >= 1);
  });

  it("copies warnings, at most twenty, and keeps the tail for failures", () => {
    const { output, statuses } = reader();
    for (let i = 0; i < 30; i += 1) output.line(`[WARN] thing ${i}`);
    assert.equal(statuses.filter((s) => s.startsWith("[WARN]")).length, 20);
    assert.equal(output.tail().length, 30);
    assert.equal(output.tail().at(-1), "[WARN] thing 29");
  });

  it("keeps only the last 80 lines and skips the text bar and the result", () => {
    const { output } = reader();
    for (let i = 0; i < 100; i += 1) output.line(`line ${i}`);
    output.line("  ██░░  50%  Capturing");
    output.line('@hf-result {"version":1}');
    const tail = output.tail();
    assert.equal(tail.length, 80);
    assert.equal(tail[0], "line 20");
    assert.equal(tail.at(-1), "line 99");
  });

  it("keeps the diagnostic line for the failure sentence", () => {
    const { output } = reader();
    output.line('@hf-diagnostic {"code":"X"}');
    assert.deepEqual(output.tail(), ['@hf-diagnostic {"code":"X"}']);
  });
});

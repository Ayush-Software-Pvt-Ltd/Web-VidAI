// The real capture, with the pinned HyperFrames and a real browser: runs only with
// `VIDAI_TEST_REAL_SNAPSHOT=1` (and ffmpeg installed). It checks by numbers that the right frame
// and the right area were captured, and that the project folder is left as it was.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findHyperframesCli } from "../../src/timeline/lint.js";
import { createNotePictures } from "../../src/timeline/notePictures.js";
import {
  fpsOf,
  listTree,
  meanRgb,
  pngDimensions,
  realFfmpeg,
  tempFolder,
  writeNoteProject,
} from "./noteSupport.js";

const ffmpeg = realFfmpeg();
const enabled = process.env.VIDAI_TEST_REAL_SNAPSHOT === "1" && ffmpeg !== null;

/** @param {string} file */
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test(
  "the real capture of two requests: right frame, right area, project untouched",
  { skip: !enabled, timeout: 300_000 },
  async () => {
    const project = tempFolder("vidai-note-project-");
    const work = tempFolder("vidai-note-work-");
    try {
      writeNoteProject(project.dir, /** @type {string} */ (ffmpeg));
      const before = listTree(project.dir);
      const indexBefore = sha(path.join(project.dir, "index.html"));
      const editBefore = sha(path.join(project.dir, "edit.json"));
      /** @type {string[]} */
      const lines = [];
      const pictures = createNotePictures({
        cli: findHyperframesCli(),
        ffmpeg,
        workDir: work.dir,
        log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      });
      const first = path.join(work.dir, "notes", "one");
      const second = path.join(work.dir, "notes", "two");
      const started = Date.now();
      const [withShape, whole] = await pictures.capture({
        projectDir: project.dir,
        fps: fpsOf(30, 1),
        width: 1920,
        height: 1080,
        requests: [
          { frame: 90, shape: { cx: 0.15, cy: 0.85, rx: 0.1, ry: 0.1 }, folder: first },
          { frame: 30, shape: null, folder: second },
        ],
      });
      const seconds = (Date.now() - started) / 1000;
      console.log(`real capture of 2 requests (3 pictures plus outline): ${seconds.toFixed(1)} s`);
      assert.ok(withShape?.frame && withShape.closeup && withShape.marked, lines.join("\n"));
      assert.ok(whole?.frame, lines.join("\n"));
      assert.equal(whole.closeup, null);

      // Sizes: 1280 on the long side, 16:9.
      assert.deepEqual(pngDimensions(withShape.frame), { width: 1280, height: 720 });
      assert.deepEqual(pngDimensions(whole.frame), { width: 1280, height: 720 });

      // Request 2 (frame 30, no overlay yet): red tells the source frame (30), green and blue the place.
      const [r2, g2, b2] = meanRgb(/** @type {string} */ (ffmpeg), whole.frame, null);
      assert.ok(Math.abs(r2 - 30) <= 4, `frame 30: red ${r2}`);
      assert.ok(
        Math.abs(g2 - 127) <= 6 && Math.abs(b2 - 127) <= 6,
        `frame 30: green ${g2} blue ${b2}`,
      );
      // The lower left of that frame is plain video, not white.
      const corner2 = meanRgb(/** @type {string} */ (ffmpeg), whole.frame, {
        x: 64,
        y: 540,
        w: 256,
        h: 144,
      });
      assert.ok(corner2[0] <= 40, `no overlay at frame 30: red ${corner2[0]}`);

      // Request 1 (frame 90 = source frame 180 under the white box): the whole frame at the top right
      // shows red = 180, the box is white.
      const [r1] = meanRgb(/** @type {string} */ (ffmpeg), withShape.frame, {
        x: 960,
        y: 0,
        w: 320,
        h: 200,
      });
      assert.ok(Math.abs(r1 - 180) <= 4, `frame 90: red ${r1}`);
      const box = meanRgb(/** @type {string} */ (ffmpeg), withShape.frame, {
        x: 100,
        y: 560,
        w: 200,
        h: 120,
      });
      assert.ok(
        box.every((c) => c >= 250),
        `the overlay box is white in the whole frame: ${box}`,
      );

      // The close-up covers x 2 to 28 percent and y 72 to 98 percent: its middle is the white box, its
      // top left corner is video with green about 72 percent and blue about 2 percent.
      const cu = pngDimensions(withShape.closeup);
      assert.ok(
        Math.max(cu.width, cu.height) >= 800 && Math.max(cu.width, cu.height) <= 1600,
        JSON.stringify(cu),
      );
      assert.ok(
        Math.abs(cu.width / cu.height - (0.26 * 1920) / (0.26 * 1080)) < 0.03,
        JSON.stringify(cu),
      );
      const middle = meanRgb(/** @type {string} */ (ffmpeg), withShape.closeup, {
        x: Math.round(cu.width * 0.3),
        y: Math.round(cu.height * 0.3),
        w: Math.round(cu.width * 0.4),
        h: Math.round(cu.height * 0.4),
      });
      assert.ok(
        middle.every((c) => c >= 250),
        `closeup middle is white: ${middle}`,
      );
      const corner = meanRgb(/** @type {string} */ (ffmpeg), withShape.closeup, {
        x: 0,
        y: 0,
        w: 8,
        h: 8,
      });
      assert.ok(Math.abs(corner[0] - 180) <= 6, `closeup corner red ${corner[0]}`);
      assert.ok(Math.abs(corner[1] - 0.72 * 255) <= 12, `closeup corner green ${corner[1]}`);
      assert.ok(corner[2] <= 20, `closeup corner blue ${corner[2]}`);

      // The marked copy differs from the clean frame on the outline only: the box centre stays white,
      // and the ellipse's right end (x 25 percent, y 85 percent) is red.
      const end = meanRgb(/** @type {string} */ (ffmpeg), withShape.marked, {
        x: 319,
        y: 610,
        w: 1,
        h: 4,
      });
      assert.ok(end[0] >= 240 && end[1] <= 90 && end[2] <= 90, `outline is red: ${end}`);
      const clean = meanRgb(/** @type {string} */ (ffmpeg), withShape.frame, {
        x: 319,
        y: 610,
        w: 1,
        h: 4,
      });
      assert.ok(
        clean.every((c) => c >= 235),
        `the same place is white without the outline: ${clean}`,
      );

      // The project folder is exactly as it was: nothing added, files unchanged.
      assert.deepEqual(listTree(project.dir), before);
      assert.equal(sha(path.join(project.dir, "index.html")), indexBefore);
      assert.equal(sha(path.join(project.dir, "edit.json")), editBefore);
      // And the temporary folder of the run is gone.
      assert.deepEqual(
        fs.readdirSync(work.dir).filter((n) => n.startsWith("snapshot-")),
        [],
      );
      const kb = (/** @type {string} */ f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
      console.log(
        `sizes: frame ${kb(withShape.frame)}, closeup ${kb(withShape.closeup)} ${JSON.stringify(cu)}, marked ${kb(withShape.marked)}`,
      );
      console.log(lines.join("\n"));
    } finally {
      project.cleanup();
      work.cleanup();
    }
  },
);

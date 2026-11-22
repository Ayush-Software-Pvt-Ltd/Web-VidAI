import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readProjectFacts } from "../../src/render/projectFacts.js";
import { writeProject } from "./helpers.js";

/** @type {string[]} */
const dirs = [];
function project(/** @type {Parameters<typeof writeProject>[1]} */ shape) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-facts-"));
  dirs.push(dir);
  writeProject(dir, shape);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("project facts", () => {
  for (const [data, expected] of /** @type {const} */ ([
    ["30", "30"],
    ["25", "25"],
    ["30000/1001", "30000/1001"],
    ["29.97", "30000/1001"],
  ])) {
    it(`reads the frame rate ${data} as ${expected}`, async () => {
      const facts = await readProjectFacts(project({ fps: data, seconds: 4 }));
      assert.equal(facts.fps, expected);
      assert.equal(facts.frames, Math.round(4 * facts.fpsValue));
    });
  }

  it("tells a Short from a Long and gives the length in seconds", async () => {
    const short = await readProjectFacts(project({ width: 1080, height: 1920, seconds: 90 }));
    assert.equal(short.portrait, true);
    assert.equal(Math.round(short.seconds), 90);
    assert.equal((await readProjectFacts(project({}))).portrait, false);
  });

  it("explains a project that cannot be read", async () => {
    const dir = project({});
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body></body></html>");
    await assert.rejects(readProjectFacts(dir), /no root composition/u);
    fs.rmSync(path.join(dir, "index.html"));
    await assert.rejects(readProjectFacts(dir), /no index\.html/u);
    fs.writeFileSync(
      path.join(dir, "index.html"),
      '<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-fps="30"></div>',
    );
    await assert.rejects(readProjectFacts(dir), /no length/u);
  });
});

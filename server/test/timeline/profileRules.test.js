// Rules 10 (references, also in the composition files and also files that are not there) and 12
// (a full-screen graphic hides the video) on whole project folders. The cases of
// `fixtures/project-rules.json` are run by the toolkit's `test_project_rules.py` too, so the two
// checkers stay in step.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkProject } from "../../src/timeline/profile.js";
import { ROOT_SCRIPT } from "../../src/timeline/rootScript.js";

const TABLE = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "..", "support", "fixtures", "project-rules.json"),
    "utf8",
  ),
);

const AROLL =
  '<video id="a-1" class="clip" src="assets/media/v.mp4" data-start="0" data-duration="4" data-media-start="0" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="L" style="z-index:0"></video>';

/** @param {"graphic" | "overlay"} kind */
const host = (kind) => {
  const track = kind === "graphic" ? 1 : 2;
  return `<div id="g-1" class="clip" data-composition-id="g-1" data-composition-src="compositions/g-1.html" data-start="1" data-duration="2" data-track-index="${track}" data-vidai-kind="${kind}" data-vidai-label="G" style="z-index:${track}"></div>`;
};

/**
 * A project folder with one A-roll clip and the host g-1 whose file is `composition`.
 * @param {"graphic" | "overlay"} kind
 * @param {string} composition
 * @param {(dir: string) => void} [more]
 */
function makeProject(kind, composition, more) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-rules-"));
  fs.mkdirSync(path.join(dir, "shared", "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shared", "js", "gsap.min.js"), "//");
  fs.mkdirSync(path.join(dir, "assets", "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "media", "v.mp4"), "x");
  fs.mkdirSync(path.join(dir, "compositions"));
  fs.writeFileSync(path.join(dir, "compositions", "g-1.html"), composition);
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<html><head><script src="shared/js/gsap.min.js"></script></head><body><div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="4">${AROLL}${host(kind)}</div><script>${ROOT_SCRIPT}</script></body></html>`,
  );
  fs.writeFileSync(
    path.join(dir, "edit.json"),
    JSON.stringify({
      toolkitVersion: "1",
      fps: "30",
      width: 1920,
      height: 1080,
      sources: [
        {
          name: "v.mp4",
          path: "assets/media/v.mp4",
          originalPath: "/x/v.mp4",
          frames: 300,
          fps: "30",
        },
      ],
      graphics: [],
    }),
  );
  more?.(dir);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the shared table has the cases of rules 10 and 12", () => {
  assert.ok(TABLE.cases.length > 20);
  const rules = new Set(TABLE.cases.flatMap((/** @type {{ rules: number[] }} */ c) => c.rules));
  assert.deepEqual([...rules].sort(), [10, 12]);
});

for (const item of TABLE.cases) {
  test(`shared table: ${item.name} (${item.rules.length ? `rule ${item.rules.join(" and ")}` : "fine"})`, async () => {
    const project = makeProject(item.hostKind, item.composition);
    try {
      const violations = await checkProject(project.dir);
      const rules = [...new Set(violations.map((v) => v.rule))].sort((a, b) => a - b);
      assert.deepEqual(rules, item.rules, JSON.stringify(violations));
    } finally {
      project.cleanup();
    }
  });
}

test("rule 12: the sentence names the graphic and says what to do", async () => {
  const bare = TABLE.cases.find(
    (/** @type {{ name: string }} */ c) => c.name === "no background at all",
  );
  const project = makeProject("graphic", bare.composition);
  try {
    const violations = await checkProject(project.dir);
    assert.deepEqual(violations, [
      {
        rule: 12,
        elementId: "g-1",
        message:
          'The full-screen graphic "g-1" has no opaque background over the whole frame, so the video shows through it; give its page a background color or image.',
      },
    ]);
  } finally {
    project.cleanup();
  }
});

test("rule 10: a reference in a composition file names the file and the element", async () => {
  const item = TABLE.cases.find((/** @type {{ name: string }} */ c) => c.name === "a drive letter");
  const project = makeProject(item.hostKind, item.composition);
  try {
    const violations = await checkProject(project.dir);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0]?.message ?? "", /compositions\/g-1\.html/);
    assert.match(violations[0]?.message ?? "", /C:\/pics\/x\.png/);
  } finally {
    project.cleanup();
  }
});

test("rule 10: a file that is not in the project is named, in index.html and in a composition", async () => {
  const item = TABLE.cases.find(
    (/** @type {{ name: string }} */ c) => c.name === "a file that is not in the project",
  );
  const project = makeProject(item.hostKind, item.composition, (dir) => {
    const file = path.join(dir, "index.html");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace("</div><script>", '<img id="ov-9" src="assets/gone.png"></div><script>'),
    );
  });
  try {
    const messages = (await checkProject(project.dir))
      .filter((v) => v.rule === 10)
      .map((v) => v.message);
    assert.ok(
      messages.some((m) => m.includes('"assets/gone.png"') && m.includes("not in the project")),
      messages.join("\n"),
    );
    assert.ok(
      messages.some(
        (m) =>
          m.includes("compositions/g-1.html") &&
          m.includes('"assets/gfx/g-1/nope.png"') &&
          m.includes("not in the project"),
      ),
      messages.join("\n"),
    );
  } finally {
    project.cleanup();
  }
});

test("rule 10: a link to a file elsewhere on disk is fine, a broken link is not", async () => {
  const good = TABLE.cases.find(
    (/** @type {{ name: string }} */ c) => c.name === "a root background color",
  );
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-rules-out-"));
  fs.writeFileSync(path.join(outside, "real.mp4"), "x");
  const project = makeProject(good.hostKind, good.composition, (dir) => {
    fs.symlinkSync(path.join(outside, "real.mp4"), path.join(dir, "assets", "media", "link.mp4"));
    fs.symlinkSync(
      path.join(outside, "missing.mp4"),
      path.join(dir, "assets", "media", "dead.mp4"),
    );
    const file = path.join(dir, "compositions", "g-1.html");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(
          "<h1>Hi</h1>",
          '<img src="assets/media/link.mp4"><img src="assets/media/dead.mp4"><img src="assets/media/a%20b.png">',
        ),
    );
  });
  try {
    const messages = (await checkProject(project.dir)).map((v) => v.message);
    assert.equal(messages.length, 2, messages.join("\n"));
    assert.ok(messages.some((m) => m.includes("assets/media/dead.mp4")));
    assert.ok(messages.some((m) => m.includes("assets/media/a%20b.png")));
  } finally {
    project.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

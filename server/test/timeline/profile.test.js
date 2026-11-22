import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import {
  checkDocument,
  checkProject,
  trackFitsKind,
  validateEditJson,
} from "../../src/timeline/profile.js";
import { pathProblem } from "../../src/timeline/profilePaths.js";
import { ROOT_SCRIPT, isRootScript } from "../../src/timeline/rootScript.js";
import { copyProject, fixture, toCrlf, withAttr } from "./helpers.js";

const long = fixture("long");
const short = fixture("short");

/** @param {string} html @param {ReturnType<typeof fixture>} [f] */
const check = (html, f = long) => checkDocument(parseProject(html), f.facts);

/** @param {{ rule: number }[]} violations */
const rulesOf = (violations) => [...new Set(violations.map((v) => v.rule))];

/**
 * Asserts the variant breaks exactly the given rules and that one sentence for the first rule names
 * the element and matches the text.
 * @param {string} html
 * @param {number[]} rules
 * @param {string | null} elementId
 * @param {RegExp} sentence
 */
function expectBreaks(html, rules, elementId, sentence) {
  const violations = check(html);
  assert.deepEqual(rulesOf(violations), rules, JSON.stringify(violations));
  const hit = violations.find((v) => v.rule === rules[0] && sentence.test(v.message));
  assert.ok(hit, `no sentence matching ${sentence} in ${JSON.stringify(violations)}`);
  assert.equal(hit.elementId, elementId);
  if (elementId && elementId !== "root") {
    assert.ok(hit.message.includes(`"${elementId}"`), `the sentence names ${elementId}`);
  }
}

const replaceOnce = (
  /** @type {string} */ html,
  /** @type {string} */ a,
  /** @type {string} */ b,
) => {
  assert.ok(html.includes(a), `fixture lacks ${a}`);
  return html.replace(a, b);
};

test("both fixtures satisfy the profile, also with CRLF and a BOM", () => {
  assert.deepEqual(check(long.html), []);
  assert.deepEqual(check(short.html, short), []);
  assert.deepEqual(check(toCrlf(long.html)), []);
  assert.deepEqual(check(`\ufeff${long.html}`), []);
});

test("trackFitsKind is the track table of rule 4", () => {
  const table = {
    aroll: [0],
    broll: [1],
    graphic: [1],
    overlay: [2],
    hit: [3],
    fade: [4],
    sfx: [10, 11, 99],
    music: [10, 12],
  };
  for (const [kind, tracks] of Object.entries(table)) {
    for (let t = 0; t < 14; t += 1) {
      assert.equal(
        trackFitsKind(kind, t),
        tracks.includes(t) || (t >= 10 && tracks.includes(10)),
        `${kind} ${t}`,
      );
    }
  }
  assert.equal(trackFitsKind("nonsense", 0), false);
});

test("rule 1: the root", () => {
  const root = (/** @type {string} */ a, /** @type {string} */ b) => replaceOnce(long.html, a, b);
  expectBreaks(
    root('<div id="root"', '<section id="root"').replace(/<\/div>(\s*<script)/, "</section>$1"),
    [1],
    "root",
    /is a <section>; it must be a <div>/,
  );
  expectBreaks(
    root('data-composition-id="main"', 'data-composition-id="other"'),
    [1],
    "root",
    /data-composition-id="main"/,
  );
  expectBreaks(
    root('data-start="0" data-width', 'data-start="2" data-width'),
    [1],
    "root",
    /data-start="0"/,
  );
  expectBreaks(
    root('data-width="1920"', 'data-width="1280"'),
    [1],
    "root",
    /1920 by 1080 \(Long\) or 1080 by 1920/,
  );
  expectBreaks(root(' data-fps="30"', ""), [1], "root", /needs data-fps/);
  expectBreaks(
    root('data-duration="45"', 'data-duration="soon"'),
    [1],
    "root",
    /data-duration is not a number of seconds/,
  );
  const empty = check("<html><body></body></html>");
  assert.ok(
    empty.some(
      (v) => v.rule === 1 && v.elementId === null && /has no root element/.test(v.message),
    ),
  );
});

test("rule 1: the root agrees with edit.json", () => {
  const html = replaceOnce(long.html, 'data-fps="30"', 'data-fps="25"');
  const violations = check(html);
  assert.ok(
    violations.some((v) => v.rule === 1 && /edit\.json says/.test(v.message)),
    JSON.stringify(violations),
  );
});

test("rule 2: every clip is a direct child of the root and a video, audio, img or host div", () => {
  const nested = replaceOnce(
    long.html,
    '<video id="a-1"',
    '<div id="wrap"><video id="deep" class="clip" src="assets/media/aroll.mp4" data-start="0" data-duration="1" data-track-index="0"></video></div>\n<video id="a-1"',
  );
  const violations = check(nested);
  assert.ok(
    violations.some(
      (v) => v.rule === 2 && v.elementId === "deep" && /not a direct child/.test(v.message),
    ),
    JSON.stringify(violations),
  );
  const section = long.html
    .replace('<div id="g-1"', '<section id="g-1"')
    .replace(/(<section id="g-1"[\s\S]*?)<\/div>/, "$1</section>");
  const v2 = check(section);
  assert.ok(
    v2.some((v) => v.rule === 2 && v.elementId === "g-1"),
    JSON.stringify(v2),
  );
  const noSrc = withAttr(long.html, "ov-2", { src: "" });
  assert.ok(
    check(noSrc).some(
      (v) => v.rule === 2 && v.elementId === "ov-2" && /has no src/.test(v.message),
    ),
  );
  const hostAsVideo = long.html
    .replace(/<div id="g-1"([^>]*)>/, '<video id="g-1"$1 src="assets/media/aroll.mp4">')
    .replace(/(<video id="g-1"[\s\S]*?)<\/div>/, "$1</video>");
  assert.ok(
    check(hostAsVideo).some(
      (v) =>
        v.rule === 2 &&
        v.elementId === "g-1" &&
        /either media or a motion graphic host/.test(v.message),
    ),
    JSON.stringify(check(hostAsVideo)),
  );
});

test("rule 3: id, class, numbers, frame boundaries, 9 decimals, track, kind and label", () => {
  expectBreaks(
    replaceOnce(long.html, 'id="a-2" class="clip"', 'id="a-2"'),
    [3],
    "a-2",
    /does not have class="clip"/,
  );
  expectBreaks(
    replaceOnce(long.html, 'id="a-2"', 'id="a-1"'),
    [3],
    "a-1",
    /shares its id with another element/,
  );
  expectBreaks(
    replaceOnce(long.html, 'id="a-2" class', 'id="a 2" class'),
    [3],
    "a 2",
    /id with a space in it/,
  );
  expectBreaks(
    withAttr(long.html, "b-2", { "data-vidai-kind": "wat" }),
    [3],
    "b-2",
    /not one of aroll, broll/,
  );
  expectBreaks(
    withAttr(long.html, "b-2", { "data-track-index": "x" }),
    [3],
    "b-2",
    /not a whole number/,
  );
  expectBreaks(
    withAttr(long.html, "b-2", { "data-vidai-label": "" }),
    [3],
    "b-2",
    /no data-vidai-label/,
  );
  expectBreaks(
    withAttr(long.html, "b-2", { "data-start": "10s" }),
    [3],
    "b-2",
    /data-start="10s", which is not a number of seconds/,
  );
  expectBreaks(
    withAttr(long.html, "b-2", { "data-duration": "0" }),
    [3],
    "b-2",
    /data-duration of 0/,
  );
  const off = check(withAttr(long.html, "b-2", { "data-start": "10.02" }));
  assert.deepEqual(rulesOf(off), [3]);
  assert.match(off[0]?.message ?? "", /frame boundary/);
});

test("rule 3: nine decimals are fine, ten decimals are refused", () => {
  const ok = withAttr(long.html, "b-2", { "data-start": "10.033333333" });
  assert.deepEqual(
    rulesOf(check(ok)).filter((r) => r === 3),
    [],
    "9 decimals",
  );
  const six = withAttr(long.html, "b-2", { "data-start": "10.033333" });
  assert.deepEqual(
    rulesOf(check(six)).filter((r) => r === 3),
    [],
    "6 decimals still read as the same frame",
  );
  const ten = check(withAttr(long.html, "b-2", { "data-start": "10.0333333333" }));
  assert.ok(
    ten.some((v) => v.rule === 3 && v.elementId === "b-2" && /decimals/.test(v.message)),
    JSON.stringify(ten),
  );
});

test("rule 4: tracks and z-index", () => {
  const onTrack = check(
    withAttr(long.html, "a-2", { "data-track-index": "1", style: "z-index:1" }),
  );
  assert.deepEqual(
    rulesOf(onTrack).filter((r) => r === 4),
    [4],
  );
  assert.ok(
    onTrack.some(
      (v) =>
        v.rule === 4 &&
        v.elementId === "a-2" &&
        /an A-roll clip on track 1, but A-roll clips belong on track 0/.test(v.message),
    ),
  );
  expectBreaks(
    withAttr(long.html, "a-2", { style: "z-index:3" }),
    [4],
    "a-2",
    /has z-index:3 but sits on track 0; its z-index must equal its track/,
  );
  expectBreaks(withAttr(long.html, "a-2", { style: "color:red" }), [4], "a-2", /z-index/);
  const sound = check(withAttr(long.html, "s-1", { "data-track-index": "5" }));
  assert.ok(
    sound.some((v) => v.rule === 4 && v.elementId === "s-1"),
    JSON.stringify(sound),
  );
});

test("rule 5: the A-roll starts at 0, has no gaps and no overlaps, and ends at the root's duration", () => {
  expectBreaks(
    withAttr(long.html, "a-1", { "data-start": "1" }),
    [5],
    "a-1",
    /first A-roll clip and starts at frame 30; the A-roll must start at frame 0/,
  );
  const gap = check(withAttr(long.html, "a-2", { "data-start": "5.5" }));
  assert.deepEqual(rulesOf(gap), [5]);
  assert.ok(
    gap.some((v) => v.elementId === "a-2" && /gap of 15 frames/.test(v.message)),
    JSON.stringify(gap),
  );
  const overlap = check(withAttr(long.html, "a-2", { "data-start": "4.5" }));
  assert.ok(
    overlap.some(
      (v) => v.rule === 5 && v.elementId === "a-2" && /overlap by 15 frames/.test(v.message),
    ),
    JSON.stringify(overlap),
  );
  const end = check(replaceOnce(long.html, 'data-duration="45"', 'data-duration="46"'));
  assert.deepEqual(rulesOf(end), [5]);
  assert.ok(
    end.some((v) => v.elementId === "root" && /ends at frame 1350/.test(v.message)),
    JSON.stringify(end),
  );
  const none = check(long.html.replace(/<video id="a-\d"[^>]*><\/video>\s*/g, ""));
  assert.ok(
    none.some((v) => v.rule === 5),
    JSON.stringify(none),
  );
});

test("rule 5: no clip of any track ends after the end of the video", () => {
  // h-3 starts at 40 and lasts 1 second; start 44.5 makes it end at 45.5 (frame 1365 of 1350).
  const late = check(withAttr(long.html, "h-3", { "data-start": "44.5" }));
  assert.deepEqual(rulesOf(late), [5], JSON.stringify(late));
  const hit = late.find((v) => v.elementId === "h-3");
  assert.ok(hit, JSON.stringify(late));
  assert.match(hit.message, /ends at frame 1365 .*after the end of the video at frame 1350/);
  assert.ok(hit.message.includes('"h-3"'));
  // Sound clips count too.
  const music = check(withAttr(long.html, "m-1", { "data-duration": "46" }));
  assert.ok(
    music.some((v) => v.rule === 5 && v.elementId === "m-1"),
    JSON.stringify(music),
  );
  // Ending exactly at the end is fine (the fixture's fade does).
  assert.deepEqual(check(long.html), []);
});

test("rule 6: clips on one track do not overlap", () => {
  const html = withAttr(long.html, "b-2", { "data-start": "2.5" });
  const violations = check(html);
  assert.deepEqual(rulesOf(violations), [6], JSON.stringify(violations));
  assert.ok(violations.some((v) => v.elementId === "b-2" || v.elementId === "b-1"));
  assert.ok(
    violations.every((v) => /overlap|track 1/.test(v.message)),
    JSON.stringify(violations),
  );
});

test("rule 7: media clips stay inside their source", () => {
  expectBreaks(
    withAttr(long.html, "a-2", { "data-media-start": "5000" }),
    [7],
    "a-2",
    /plays aroll\.mp4 from 5000 seconds/,
  );
  const unknown = check(withAttr(long.html, "a-2", { src: "assets/media/unknown.mp4" }));
  assert.ok(
    unknown.some(
      (v) => v.rule === 7 && v.elementId === "a-2" && /does not list under sources/.test(v.message),
    ),
    JSON.stringify(unknown),
  );
  const rate = check(withAttr(long.html, "a-2", { "data-media-start": "199" }));
  assert.ok(
    rate.some((v) => v.rule === 7 && v.elementId === "a-2"),
    "7 seconds from second 199 of a 200 s file",
  );
  const edge = check(withAttr(long.html, "a-2", { "data-media-start": "193" }));
  assert.deepEqual(rulesOf(edge), [], "ends exactly at the end of the file");
  const broll = check(withAttr(long.html, "b-1", { "data-media-start": "69" }));
  assert.ok(
    broll.some((v) => v.rule === 7 && v.elementId === "b-1"),
    "the 25 fps B-roll source is measured in its own frames",
  );
});

test("rule 8: a motion graphic host and its file", () => {
  expectBreaks(
    withAttr(long.html, "g-1", { "data-composition-src": "compositions/other.html" }),
    [8],
    "g-1",
    /it must be compositions\/g-1\.html/,
  );
  const id = check(withAttr(long.html, "g-1", { "data-composition-id": "g-9" }));
  assert.ok(
    id.some((v) => v.rule === 8 && v.elementId === "g-1"),
    JSON.stringify(id),
  );
});

test("rule 9: index.html holds no animation", () => {
  expectBreaks(
    replaceOnce(long.html, "</body>", "<script>alert(1)</script></body>"),
    [9],
    null,
    /holds a script other than VidAI's fixed root script/,
  );
  expectBreaks(withAttr(long.html, "b-2", { onclick: "x()" }), [9], "b-2", /event handler onclick/);
  const ref = check(withAttr(long.html, "b-2", { "data-start": "a-1" }));
  assert.ok(
    ref.some(
      (v) => v.rule === 9 && v.elementId === "b-2" && /refers to another clip/.test(v.message),
    ),
    JSON.stringify(ref),
  );
  const noScript = check(long.html.replace(/<script>[\s\S]*?<\/script>/, ""));
  assert.ok(
    noScript.some((v) => v.rule === 9 && /root script/.test(v.message)),
    JSON.stringify(noScript),
  );
  const edited = check(long.html.replace("gsap.timeline", "gsap.timeline /* x */"));
  assert.ok(
    edited.some((v) => v.rule === 9),
    "a changed root script is a violation",
  );
  const lib = check(
    replaceOnce(long.html, "<script>", '<script src="shared/gsap.min.js"></script>\n<script>'),
  );
  assert.deepEqual(lib, [], "the design kit's library script is allowed");
  const cdn = check(
    replaceOnce(
      long.html,
      "<script>",
      '<script src="https://cdn.example.com/gsap.js"></script>\n<script>',
    ),
  );
  assert.ok(
    cdn.some((v) => v.rule === 9 || v.rule === 10),
    JSON.stringify(cdn),
  );
});

test("rule 10: references stay inside the project", () => {
  const bad = [
    "../x.png",
    "/etc/passwd",
    "http://x.example/y.png",
    "//host/x.png",
    "file:///x",
    "data:image/png;base64,AA",
    "a\\b.png",
    "%2e%2e/x.png",
    "assets/%2E%2E/x",
    "C:/x.png",
    "a/../b.png",
    "javascript:x",
    "assets/a%00.png",
    "\\\\host\\share\\a.png",
    "",
  ];
  for (const p of bad) assert.notEqual(pathProblem(p), null, JSON.stringify(p));
  for (const p of ["assets/ok.png", "./a.png", "shared/card.png", "assets/a b.png"]) {
    assert.equal(pathProblem(p), null, p);
  }
  for (const src of bad.filter((p) => p !== "")) {
    const html = withAttr(long.html, "ov-2", { src });
    const v = check(html).filter((x) => x.rule === 10);
    assert.ok(
      v.length > 0 && v.every((x) => x.elementId === "ov-2"),
      `src ${JSON.stringify(src)}: ${JSON.stringify(v)}`,
    );
    assert.ok(v[0]?.message.includes('"ov-2"'));
  }
});

test("rule 10: references in style attributes and style elements", () => {
  const style = check(
    withAttr(long.html, "ov-2", { style: "z-index:2;background:url(http://evil.example/x.png)" }),
  );
  assert.ok(
    style.some((v) => v.rule === 10 && v.elementId === "ov-2"),
    JSON.stringify(style),
  );
  const import_ = check(
    replaceOnce(
      long.html,
      "</head>",
      '<style>@import "https://evil.example/a.css";</style></head>',
    ),
  );
  assert.ok(
    import_.some((v) => v.rule === 10),
    JSON.stringify(import_),
  );
  const link = check(
    replaceOnce(long.html, "</head>", '<link rel="stylesheet" href="//evil.example/a.css"></head>'),
  );
  assert.ok(
    link.some((v) => v.rule === 10),
    JSON.stringify(link),
  );
  const ok = check(
    replaceOnce(
      long.html,
      "</head>",
      '<style>.x{background:url("shared/card.png")}</style></head>',
    ),
  );
  assert.deepEqual(ok, []);
});

test("the root script is exact and CRLF-tolerant", () => {
  assert.equal(isRootScript(ROOT_SCRIPT), true);
  assert.equal(isRootScript(`\n  ${ROOT_SCRIPT}\n`), true);
  assert.equal(isRootScript(ROOT_SCRIPT.replace(/\n/g, "\r\n")), true);
  assert.equal(isRootScript(`${ROOT_SCRIPT}\nalert(1);`), false);
  assert.equal(isRootScript(ROOT_SCRIPT.replace("paused: true", "paused: false")), false);
  assert.equal(isRootScript(""), false);
});

test("validateEditJson accepts the fixtures' shape and refuses broken ones with sentences", () => {
  const good = JSON.parse(long.editText);
  const ok = validateEditJson(good);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.facts);
  assert.deepEqual(ok.facts.fps, { num: 30, den: 1 });
  assert.equal(ok.facts.width, 1920);
  const rational = validateEditJson({ ...good, fps: "30000/1001" });
  assert.deepEqual(rational.facts?.fps, { num: 30000, den: 1001 });
  const numeric = validateEditJson({ ...good, fps: 25 });
  assert.deepEqual(numeric.facts?.fps, { num: 25, den: 1 });
  const cases = [
    [null, /edit\.json/],
    [{ ...good, fps: "soon" }, /fps/],
    [{ ...good, width: "wide" }, /width/],
    [{ ...good, sources: "none" }, /sources/],
    [{ ...good, sources: [{ ...good.sources[0], frames: -1 }] }, /frames/],
    [{ ...good, sources: [good.sources[0], good.sources[0]] }, /repeats the path/],
    [{ ...good, graphics: [{ id: "g-1" }] }, /graphics/],
    [{ ...good, toolkitVersion: "" }, /toolkitVersion/],
  ];
  for (const [value, pattern] of cases) {
    const result = validateEditJson(value);
    assert.equal(result.facts, null, JSON.stringify(value)?.slice(0, 80));
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some((e) => pattern.test(e)),
      `${pattern}: ${result.errors.join(" | ")}`,
    );
  }
});

test("checkProject reads the files of a project folder", async () => {
  const { dir, cleanup } = copyProject("long");
  try {
    assert.deepEqual(await checkProject(dir), []);
    fs.rmSync(path.join(dir, "compositions", "g-1.html"));
    const missing = await checkProject(dir);
    assert.deepEqual(
      missing.map((v) => [v.rule, v.elementId]),
      [[8, "g-1"]],
    );
    assert.match(missing[0]?.message ?? "", /needs compositions\/g-1\.html, which does not exist/);
    fs.writeFileSync(path.join(dir, "compositions", "g-1.html"), "<div>no template</div>");
    const bad = await checkProject(dir);
    assert.deepEqual(
      bad.map((v) => [v.rule, v.elementId]),
      [[8, "g-1"]],
    );
    fs.writeFileSync(path.join(dir, "edit.json"), "{ not json");
    const json = await checkProject(dir);
    assert.ok(
      json.some((v) => v.rule === 1 && /edit\.json is not valid JSON/.test(v.message)),
      JSON.stringify(json),
    );
    fs.rmSync(path.join(dir, "edit.json"));
    const none = await checkProject(dir);
    assert.ok(
      none.some((v) => v.rule === 1 && /edit\.json/.test(v.message)),
      JSON.stringify(none),
    );
  } finally {
    cleanup();
  }
  const gone = await checkProject(path.join(dir, "nowhere"));
  assert.deepEqual(
    gone.map((v) => v.rule),
    [1],
  );
});

test("checkProject never follows a link out of the project folder", async () => {
  const { dir, cleanup } = copyProject("long");
  const outside = fs.mkdtempSync(path.join(path.dirname(dir), "vidai-outside-"));
  try {
    fs.writeFileSync(
      path.join(outside, "g-1.html"),
      fs.readFileSync(path.join(dir, "compositions", "g-1.html")),
    );
    fs.rmSync(path.join(dir, "compositions", "g-1.html"));
    fs.symlinkSync(path.join(outside, "g-1.html"), path.join(dir, "compositions", "g-1.html"));
    const violations = await checkProject(dir);
    assert.ok(
      violations.some((v) => v.rule === 8 || v.rule === 10),
      JSON.stringify(violations),
    );
    assert.ok(violations.every((v) => v.elementId === "g-1" || v.elementId === null));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

// ---- Rule 7 for a B-roll with motion (its video is in compositions/<id>.html) -------------------

const motion = fixture("motion");

/** @param {string} id @param {(text: string) => string} change */
function withComposition(id, change) {
  const compositions = new Map(motion.facts.compositions);
  compositions.set(id, change(/** @type {string} */ (compositions.get(id))));
  return { ...motion, facts: { ...motion.facts, compositions } };
}

test("rule 7: the motion fixture is clean and a B-roll with motion is checked like a plain one", () => {
  assert.deepEqual(check(motion.html, motion), []);
  // The in-point is past the end of the source: broll.mp4 is 60 s long.
  const past = withComposition("b-1", (t) =>
    t.replace('data-media-start="2"', 'data-media-start="59"'),
  );
  const v = check(motion.html, past);
  assert.deepEqual(
    v.map((x) => [x.rule, x.elementId]),
    [[7, "b-1"]],
  );
  assert.match(
    v[0]?.message ?? "",
    /compositions\/b-1\.html.*only 1 min long|compositions\/b-1\.html/,
  );
  // Exactly up to the end is fine: 57 s + 3 s.
  const edge = withComposition("b-1", (t) =>
    t
      .replace('data-media-start="2"', 'data-media-start="57"')
      .replace('data-duration="58"', 'data-duration="3"'),
  );
  assert.deepEqual(check(motion.html, edge), []);
});

test("rule 7: a B-roll with motion plays a file edit.json lists, and its video lasts as long as the host", () => {
  const unlisted = withComposition("b-2", (t) =>
    t.replace("assets/media/broll.mp4", "assets/media/other.mp4"),
  );
  const u = check(motion.html, unlisted);
  assert.deepEqual(rulesOf(u), [7]);
  assert.match(u[0]?.message ?? "", /other\.mp4.*does not list/);
  const short = withComposition("b-2", (t) => t.replace('data-duration="50"', 'data-duration="1"'));
  const s = check(motion.html, short);
  assert.deepEqual(
    s.map((x) => [x.rule, x.elementId]),
    [[7, "b-2"]],
  );
  assert.match(
    s[0]?.message ?? "",
    /is 2 seconds long, but the video in compositions\/b-2\.html lasts only 1 seconds/,
  );
});

test("rule 7 leaves a graphic and a file in another shape alone", () => {
  const other = withComposition(
    "b-1",
    () => "<template><div id='b-1-root' data-composition-id='b-1'></div></template>",
  );
  assert.deepEqual(check(motion.html, other), []);
});

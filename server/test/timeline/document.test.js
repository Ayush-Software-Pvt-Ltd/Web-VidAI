import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEdits,
  attrEdits,
  decodeEntities,
  escapeAttrValue,
  insertCopyAfter,
  parseProject,
  removeElement,
  setAttribute,
  uniqueId,
} from "../../src/timeline/document.js";
import { fixture, toCrlf } from "./helpers.js";

/** @param {string} body @param {string} [eol] */
const page = (body, eol = "\n") =>
  [
    "<!doctype html>",
    "<html>",
    "<body>",
    '  <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="4">',
    body,
    "  </div>",
    "</body>",
    "</html>",
    "",
  ].join(eol);

const clip = (/** @type {string} */ id, extra = "") =>
  `<video id="${id}" class="clip" src="a.mp4" data-start="0" data-duration="2" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="x"${extra}></video>`;

/** @param {string} html @param {string} id */
const element = (html, id) => {
  const found = parseProject(html).clips.find((c) => c.id === id);
  assert.ok(found, id);
  return found.element;
};

test("parseProject reads the root and every clip of the Long fixture", () => {
  const { html } = fixture("long");
  const parsed = parseProject(html);
  assert.equal(parsed.problems.length, 0);
  assert.equal(parsed.root?.compositionId, "main");
  assert.equal(parsed.root?.width, 1920);
  assert.equal(parsed.root?.height, 1080);
  assert.deepEqual(parsed.root?.fps, { num: 30, den: 1 });
  assert.equal(parsed.root?.duration, 1350);
  assert.equal(parsed.clips.length, 22);
  assert.equal(parsed.scripts.length, 2);
  const a7 = parsed.clips.find((c) => c.id === "a-7");
  assert.ok(a7);
  assert.equal(a7.tag, "video");
  assert.equal(a7.kind, "aroll");
  assert.equal(a7.label, "Offer");
  assert.equal(a7.track, 0);
  assert.equal(a7.start, 990);
  assert.equal(a7.duration, 200);
  assert.equal(a7.mediaStart, 3015);
  assert.equal(a7.src, "assets/media/aroll.mp4");
  assert.equal(a7.hasClipClass, true);
  const g1 = parsed.clips.find((c) => c.id === "g-1");
  assert.equal(g1?.isHost, true);
  assert.equal(g1?.compositionSrc, "compositions/g-1.html");
  assert.equal(g1?.compositionId, "g-1");
  const b3 = parsed.clips.find((c) => c.id === "b-3");
  assert.equal(b3?.track, 1, "an unquoted data-track-index is read");
  assert.equal(b3?.element.void, true);
  assert.equal(b3?.element.selfClosing, true);
  assert.equal(
    parsed.clips.find((c) => c.id === "b-1")?.start,
    60,
    "single-quoted values are read",
  );
});

test("attribute spans cover quoted, single-quoted, unquoted, multi-line and tab-separated tags", () => {
  const { html } = fixture("long");
  const parsed = parseProject(html);
  const attr = (/** @type {string} */ id, /** @type {string} */ name) => {
    const found = parsed.clips.find((c) => c.id === id)?.element.attrs.find((a) => a.name === name);
    assert.ok(found, `${id} ${name}`);
    return found;
  };
  const text = (/** @type {{ valueStart: number, valueEnd: number }} */ a) =>
    html.slice(a.valueStart, a.valueEnd);
  assert.equal(text(attr("a-1", "data-duration")), "5");
  assert.equal(attr("a-1", "data-duration").quote, '"');
  assert.equal(text(attr("b-1", "data-start")), "2");
  assert.equal(attr("b-1", "data-start").quote, "'");
  assert.equal(text(attr("b-3", "data-track-index")), "1");
  assert.equal(attr("b-3", "data-track-index").quote, "");
  assert.equal(text(attr("a-4", "data-media-start")), "45.5");
  assert.equal(text(attr("fade-1", "data-start")), "43");
  assert.equal(attr("a-1", "playsinline").hasValue, false);
});

test("setAttribute changes only the value and keeps the quote character", () => {
  const { html } = fixture("long");
  const parsed = parseProject(html);
  const get = (/** @type {string} */ id) =>
    /** @type {import("../../src/timeline/document.js").ParsedClip} */ (
      parsed.clips.find((c) => c.id === id)
    ).element;
  const out = setAttribute(html, get("b-1"), "data-start", "9.5");
  assert.equal(out, html.replace("data-start='2'", "data-start='9.5'"));
  const out2 = setAttribute(html, get("a-1"), "data-vidai-label", `Say "hi" & <go>`);
  assert.equal(
    out2,
    html.replace(
      'data-vidai-label="Hook"',
      'data-vidai-label="Say &quot;hi&quot; &amp; &lt;go&gt;"',
    ),
  );
  assert.equal(parseProject(out2).clips[0]?.label, 'Say "hi" & <go>');
  const out3 = setAttribute(html, get("b-1"), "data-vidai-label", "it's");
  assert.ok(out3.includes("data-vidai-label='it&#39;s'"));
});

test("an unquoted attribute is rewritten quoted, a missing one is added after the last attribute", () => {
  const { html } = fixture("long");
  const b3 = /** @type {import("../../src/timeline/document.js").ParsedClip} */ (
    parseProject(html).clips.find((c) => c.id === "b-3")
  ).element;
  const out = setAttribute(html, b3, "data-track-index", 1);
  assert.equal(out, html.replace("data-track-index=1", 'data-track-index="1"'));
  const added = setAttribute(html, b3, "data-media-start", "0");
  assert.equal(
    added,
    html.replace('style="z-index:1" />', 'style="z-index:1" data-media-start="0" />'),
  );
  const a1 = /** @type {import("../../src/timeline/document.js").ParsedClip} */ (
    parseProject(html).clips.find((c) => c.id === "a-1")
  ).element;
  const flag = setAttribute(html, a1, "playsinline", "yes");
  assert.ok(flag.includes('playsinline="yes" data-has-audio'));
  const many = applyEdits(
    html,
    attrEdits(a1, { "data-x": "1", "data-y": "2", "data-start": "0.5" }),
  );
  assert.ok(many.includes('style="z-index:0" data-x="1" data-y="2">'));
  assert.ok(many.includes('data-start="0.5"'));
});

test("a tag with no attributes gets the new attribute after the tag name", () => {
  const html = page("    <img id='p'>\n");
  const el = parseProject(html);
  assert.equal(el.problems.length, 0);
  const root = /** @type {import("../../src/timeline/document.js").ParsedRoot} */ (el.root);
  assert.ok(root);
  const out = applyEdits(
    "<img>",
    attrEdits({ ...root.element, attrs: [], nameEnd: 4, duplicates: [] }, { id: "x" }),
  );
  assert.equal(out, '<img id="x">');
});

test("escaping", () => {
  assert.equal(escapeAttrValue(`a&b"c<d>e'f`, '"'), "a&amp;b&quot;c&lt;d&gt;e'f");
  assert.equal(escapeAttrValue(`a&b"c'd`, "'"), 'a&amp;b"c&#39;d');
  assert.equal(escapeAttrValue("a\nb\r\tc\0", '"'), "a&#10;b&#13;&#9;c");
  assert.equal(
    decodeEntities("a&amp;b &lt;&#65;&#x42;&quot; &unknown; &#0;"),
    'a&b <AB" &unknown; &#0;',
  );
  assert.throws(() => attrEdits(element(page(`    ${clip("a")}\n`), "a"), { "bad name": "1" }), {
    code: "invalidInput",
  });
});

test("removing an element removes its line when the line holds nothing else", () => {
  const html = page(`    ${clip("a")}\n    ${clip("b")}\n    ${clip("c")}\n`);
  const out = removeElement(html, element(html, "b"));
  assert.equal(out, page(`    ${clip("a")}\n    ${clip("c")}\n`));
});

test("removing an element that shares its line removes only the element", () => {
  const html = page(`    ${clip("a")} <!-- keep -->${clip("b")}\n`);
  assert.equal(removeElement(html, element(html, "b")), page(`    ${clip("a")} <!-- keep -->\n`));
  assert.equal(
    removeElement(html, element(html, "a")),
    page(` <!-- keep -->${clip("b")}\n`.replace(/^/, "    ")),
  );
});

test("removing handles CRLF, a BOM before the first line, multi-line elements and the last line", () => {
  const multi = `    <video\n      id="m"\n      class="clip"\n      src="a.mp4"\n      data-start="0"\n    ></video>\n`;
  const html = toCrlf(page(`    ${clip("a")}\n${multi}    ${clip("c")}\n`));
  const out = removeElement(html, element(html, "m"));
  assert.equal(out, toCrlf(page(`    ${clip("a")}\n    ${clip("c")}\n`)));
  const bom = `\ufeff<div id="root" data-composition-id="main" data-start="0" data-width="1" data-height="1" data-fps="30" data-duration="1">${clip("x")}</div>`;
  assert.equal(parseProject(bom).bom, true);
  assert.equal(removeElement(bom, element(bom, "x")), bom.replace(clip("x"), ""));
  const first = `\ufeff<video id="x" class="clip"></video>\n<div id="root">\n</div>\n`;
  assert.equal(parseProject(first).bom, true);
  const p = parseProject(first);
  assert.ok(p.root);
  const lone = `\ufeff${clip("v")}\n<div id="root" data-composition-id="main" data-fps="30">\n</div>`;
  const parsedLone = parseProject(lone);
  assert.equal(parsedLone.clips.length, 0, "a clip outside the root is not a clip");
  assert.ok(parsedLone.problems.some((x) => x.rule === 2));
});

test("inserting a copy goes on its own line with the same indentation and line ending", () => {
  const html = page(`    ${clip("a")}\n    ${clip("c")}\n`);
  const out = insertCopyAfter(html, element(html, "a"), { id: "a-2", "data-start": "2" });
  assert.equal(
    out,
    page(
      `    ${clip("a")}\n    ${clip("a-2").replace('data-start="0"', 'data-start="2"')}\n    ${clip("c")}\n`,
    ),
  );
  const crlf = toCrlf(html);
  const outCrlf = insertCopyAfter(crlf, element(crlf, "a"), { id: "a-2" });
  assert.equal(outCrlf, toCrlf(page(`    ${clip("a")}\n    ${clip("a-2")}\n    ${clip("c")}\n`)));
  assert.ok(!outCrlf.replace(/\r\n/g, "").includes("\n"), "no bare line feed was introduced");
});

test("inserting after an element with trailing blanks or other content on its line", () => {
  const html = page(`    ${clip("a")}   \n    ${clip("c")}\n`);
  const out = insertCopyAfter(html, element(html, "a"), { id: "n" });
  assert.equal(out, page(`    ${clip("a")}   \n    ${clip("n")}\n    ${clip("c")}\n`));
  const shared = page(`    ${clip("a")}${clip("c")}\n`);
  assert.equal(
    insertCopyAfter(shared, element(shared, "a"), { id: "n" }),
    page(`    ${clip("a")}${clip("n")}${clip("c")}\n`),
  );
  const lastNoEol = `<div id="root" data-composition-id="main" data-fps="30">\n  ${clip("a")}`;
  const parsed = parseProject(lastNoEol);
  const el = /** @type {import("../../src/timeline/document.js").ParsedClip} */ (parsed.clips[0])
    .element;
  assert.equal(
    insertCopyAfter(lastNoEol, el, { id: "n" }),
    `<div id="root" data-composition-id="main" data-fps="30">\n  ${clip("a")}\n  ${clip("n")}`,
  );
});

test("copies of multi-line and void elements are inserted whole", () => {
  const html = page(`    <img\n      id="p" class="clip"\n      src="p.png" />\n`);
  const out = insertCopyAfter(html, element(html, "p"), { id: "p-2" });
  assert.equal(
    out,
    page(
      `    <img\n      id="p" class="clip"\n      src="p.png" />\n    <img\n      id="p-2" class="clip"\n      src="p.png" />\n`,
    ),
  );
});

test("duplicate attributes are reported and refused for editing", () => {
  const html = page(`    ${clip("a", ' data-start="9"')}\n`);
  const parsed = parseProject(html);
  assert.deepEqual(parsed.clips[0]?.element.duplicates, ["data-start"]);
  assert.equal(parsed.clips[0]?.start, 0, "the first one counts, like in a browser");
  assert.ok(
    parsed.problems.some((p) => p.rule === 3 && /data-start more than once/.test(p.message)),
  );
  assert.throws(
    () => setAttribute(html, element(html, "a"), "data-start", "1"),
    /data-start more than once/,
  );
  assert.equal(
    setAttribute(html, element(html, "a"), "data-duration", "1").includes('data-duration="1"'),
    true,
  );
});

test("self-closing non-void elements and missing end tags are reported and refused", () => {
  const html = page(`    <video id="a" class="clip" src="a.mp4" />\n    ${clip("b")}\n`);
  const parsed = parseProject(html);
  assert.ok(
    parsed.problems.some(
      (p) => p.rule === 2 && /self-closing/.test(p.message) && p.elementId === "a",
    ),
  );
  const a = parsed.clips[0];
  assert.ok(a);
  assert.throws(() => removeElement(html, a.element), /self-closing/);
  const open = page(`    <video id="a" class="clip" src="a.mp4">\n`);
  const p2 = parseProject(open);
  assert.ok(p2.problems.some((p) => /no closing tag/.test(p.message)));
});

test("CRLF files give offsets into the original text", () => {
  const { html } = fixture("long");
  const crlf = toCrlf(html);
  const parsed = parseProject(crlf);
  assert.equal(parsed.eol, "\r\n");
  assert.equal(parsed.clips.length, 22);
  for (const c of parsed.clips) {
    assert.equal(crlf.slice(c.element.start, c.element.start + 1), "<");
    assert.ok(
      crlf.slice(c.element.start, c.element.end).includes(`id="${c.id}"`) ||
        crlf.slice(c.element.start, c.element.end).includes(`id='${c.id}'`),
    );
  }
  const out = setAttribute(
    crlf,
    parsed.clips[3]?.element ?? /** @type {never} */ (null),
    "data-start",
    "9",
  );
  assert.equal(out, crlf.replace('data-start="16"', 'data-start="9"'));
  assert.equal(parseProject(html).eol, "\n");
});

test("a BOM is kept and offsets still match", () => {
  const { html } = fixture("long");
  const bom = `\ufeff${html}`;
  const parsed = parseProject(bom);
  assert.equal(parsed.bom, true);
  assert.equal(parsed.clips.length, 22);
  const a2 = parsed.clips[1];
  assert.ok(a2);
  const out = setAttribute(bom, a2.element, "data-duration", "8");
  assert.equal(
    out,
    bom.replace('data-start="5" data-duration="7"', 'data-start="5" data-duration="8"'),
  );
  assert.equal(out.charCodeAt(0), 0xfeff);
});

test("elements with a data-start outside the root's direct children are reported", () => {
  const html = page(
    `    <div id="wrap"><video id="deep" class="clip" data-start="0" src="a.mp4"></video></div>\n    ${clip("a")}\n`,
  );
  const parsed = parseProject(html);
  assert.equal(parsed.clips.length, 1);
  assert.ok(
    parsed.problems.some(
      (p) => p.rule === 2 && p.elementId === "deep" && /not a direct child/.test(p.message),
    ),
  );
});

test("uniqueId derives from the old id and avoids taken ones", () => {
  assert.equal(uniqueId("a-3", new Set()), "a-3-2");
  assert.equal(uniqueId("a-3", new Set(["a-3-2", "a-3-3"])), "a-3-4");
});

test("applyEdits refuses overlapping edits", () => {
  assert.throws(() =>
    applyEdits("abcdef", [
      { start: 0, end: 3, text: "x" },
      { start: 2, end: 4, text: "y" },
    ]),
  );
  assert.equal(
    applyEdits("abcdef", [
      { start: 3, end: 3, text: "-" },
      { start: 0, end: 1, text: "A" },
    ]),
    "Abc-def",
  );
});

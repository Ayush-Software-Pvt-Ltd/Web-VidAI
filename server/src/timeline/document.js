// Reading a HyperFrames project's `index.html` and changing it without rewriting it
// (docs/SPEC.md sections 10 and 11).
//
// The document is parsed with parse5 only to learn where elements are; every change is a splice of
// the original text at source offsets (an attribute value, a whole clip element, an inserted copy), so
// every other byte (line endings, quoting, comments, whitespace, a BOM) stays as it was. The start tag
// of each element of interest is scanned a second time by `scanStartTag`, because the HTML parser
// silently drops duplicate attributes and hides how a value was quoted.

import { parse } from "parse5";
import { invalidInput } from "../errors.js";
import { parseFps, readSeconds } from "./frames.js";

/** @typedef {import("./frames.js").Fps} Fps */
/** @typedef {import("parse5").DefaultTreeAdapterMap["element"]} Node5Element */
/** @typedef {import("parse5").DefaultTreeAdapterMap["parentNode"]} Node5Parent */

/**
 * One attribute as written in the start tag. Offsets are into the whole text (BOM included).
 * @typedef {Object} ParsedAttr
 * @property {string} name Lower-case name.
 * @property {number} start First character of the name.
 * @property {number} end After the last character of the attribute (after the closing quote).
 * @property {number} valueStart First character of the value, quotes excluded (== end when none).
 * @property {number} valueEnd After the last character of the value, quotes excluded.
 * @property {'"' | "'" | ""} quote How the value is quoted ("" for unquoted or no value).
 * @property {boolean} hasValue Whether there is an `=`.
 * @property {string} value The value with character references decoded ("" without value).
 */

/**
 * @typedef {Object} ParsedElement
 * @property {string} tag Lower-case tag name.
 * @property {ParsedAttr[]} attrs In source order.
 * @property {string[]} duplicates Names written more than once in the start tag.
 * @property {number} start `<` of the start tag.
 * @property {number} startTagEnd After the `>` of the start tag.
 * @property {number} end After the end tag (or the start tag of a void element).
 * @property {number} nameEnd After the tag name.
 * @property {boolean} selfClosing The start tag ends with `/>`.
 * @property {boolean} void An element that has no end tag in HTML (img, ...).
 * @property {boolean} unclosed A non-void element without an end tag.
 */

/**
 * @typedef {Object} TimeAttr
 * @property {boolean} present
 * @property {string | null} text Raw value (null when absent).
 * @property {boolean} numeric A plain non-negative decimal number.
 * @property {number | null} exact The value in frames, fractional when between frames.
 * @property {number | null} frames The nearest whole frame.
 * @property {boolean} onFrame Falls on a frame boundary within the tolerance.
 */

/**
 * @typedef {Object} ParsedClip
 * @property {number} index Position among the clips in the document, from 0.
 * @property {ParsedElement} element
 * @property {string} tag
 * @property {string | null} id
 * @property {boolean} hasClipClass
 * @property {boolean} isHost A motion graphic host (`data-composition-src`).
 * @property {string | null} kind `data-vidai-kind` as written.
 * @property {string | null} label `data-vidai-label`.
 * @property {number | null} track `data-track-index` as an integer, null if absent or not one.
 * @property {string | null} trackText
 * @property {TimeAttr} startAttr
 * @property {TimeAttr} durationAttr
 * @property {TimeAttr} mediaStartAttr
 * @property {number | null} start Frames (null when not a number).
 * @property {number | null} duration Frames.
 * @property {number | null} mediaStart In-point in frames (fractional allowed), 0 when absent.
 * @property {string | null} rateText `data-playback-rate` as written.
 * @property {number | null} rate Playback rate (1 when absent), null when not a number.
 * @property {string | null} src
 * @property {string | null} compositionSrc
 * @property {string | null} compositionId
 * @property {string | null} style The `style` attribute.
 */

/**
 * @typedef {Object} ParsedRoot
 * @property {ParsedElement} element
 * @property {string | null} id
 * @property {string | null} compositionId
 * @property {string | null} startText
 * @property {number | null} width
 * @property {number | null} height
 * @property {string | null} fpsText
 * @property {Fps | null} fps
 * @property {TimeAttr} durationAttr
 * @property {number | null} duration Frames.
 */

/**
 * A fault of the text itself (not of VidAI's rules) that makes the document unsafe to read or edit.
 * @typedef {Object} ParseProblem
 * @property {number} rule The profile rule it belongs to (1 to 10).
 * @property {string | null} elementId
 * @property {string} message
 */

/**
 * @typedef {Object} ParsedScript
 * @property {ParsedElement} element
 * @property {string | null} src
 * @property {string} text Text between the tags.
 */

/**
 * @typedef {Object} ParsedProject
 * @property {string} html The text as given.
 * @property {boolean} bom Whether it starts with a byte order mark.
 * @property {string} eol The line ending the file mostly uses ("\n" or "\r\n").
 * @property {ParsedRoot | null} root
 * @property {ParsedClip[]} clips
 * @property {ParsedScript[]} scripts
 * @property {Map<string, number>} idCounts How often each `id` occurs on any element.
 * @property {ParseProblem[]} problems
 * @property {HtmlTree} tree
 */

/**
 * @typedef {Object} HtmlTree
 * @property {Node5Parent} document
 * @property {number} offset Added to parse5 offsets (the BOM).
 */

/** An edit of the text: replace [start, end) by `text`. */
/** @typedef {{ start: number, end: number, text: string }} TextEdit */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/**
 * Parses HTML keeping source offsets. A leading BOM is skipped for parse5 and added back to offsets.
 * @param {string} html
 * @returns {HtmlTree}
 */
export function parseHtml(html) {
  const offset = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  const document = parse(offset ? html.slice(1) : html, { sourceCodeLocationInfo: true });
  return { document, offset };
}

/**
 * Calls `visit` for every element in document order, template contents included.
 * @param {Node5Parent | { childNodes?: unknown[], content?: unknown }} node
 * @param {(element: Node5Element, parent: Node5Parent) => void} visit
 */
export function walkElements(node, visit) {
  const parent = /** @type {Node5Parent} */ (node);
  for (const child of /** @type {{ childNodes?: unknown[] }} */ (node).childNodes ?? []) {
    const element = /** @type {Node5Element} */ (child);
    if (typeof element.tagName === "string") {
      visit(element, parent);
      walkElements(element, visit);
    }
  }
  const content = /** @type {{ content?: Node5Parent }} */ (node).content;
  if (content) walkElements(content, visit);
}

/**
 * @param {Node5Element} node
 * @param {string} name
 * @returns {string | null} The first value of the attribute (parse5 keeps the first of duplicates).
 */
export function nodeAttr(node, name) {
  for (const attr of node.attrs) if (attr.name === name) return attr.value;
  return null;
}

/** @param {string} text @returns {string} Character references decoded (the common ones). */
export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (all, dec, hex, name) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : all;
      }
      return Object.hasOwn(named, name) ? named[/** @type {keyof typeof named} */ (name)] : all;
    },
  );
}

/**
 * Escapes a value for writing inside quotes.
 * @param {string} value
 * @param {'"' | "'"} quote
 * @returns {string}
 */
export function escapeAttrValue(value, quote) {
  let out = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  out = quote === '"' ? out.replace(/"/g, "&quot;") : out.replace(/'/g, "&#39;");
  return out
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;")
    .replace(/\0/g, "");
}

/**
 * Scans the start tag text [start, end) of `html` the way the HTML tokenizer does.
 * @param {string} html
 * @param {number} start `<`
 * @param {number} end After `>`
 * @returns {{ nameEnd: number, attrs: ParsedAttr[], selfClosing: boolean }}
 */
export function scanStartTag(html, start, end) {
  let i = start + 1;
  while (i < end && !/[\s/>]/.test(html[i] ?? "")) i++;
  const nameEnd = i;
  /** @type {ParsedAttr[]} */
  const attrs = [];
  let selfClosing = false;
  while (i < end) {
    const c = html[i] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/") {
      if (html[i + 1] === ">" && i + 2 === end) selfClosing = true;
      i++;
    } else if (c === ">") {
      break;
    } else {
      const nameStart = i;
      i++;
      while (i < end && !/[\s/>=]/.test(html[i] ?? "")) i++;
      const name = html.slice(nameStart, i).toLowerCase();
      let j = i;
      while (j < end && /\s/.test(html[j] ?? "")) j++;
      if (html[j] === "=") {
        j++;
        while (j < end && /\s/.test(html[j] ?? "")) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, j + 1);
          const valueEnd = close === -1 || close >= end ? end - 1 : close;
          attrs.push({
            name,
            start: nameStart,
            end: Math.min(valueEnd + 1, end),
            valueStart: j + 1,
            valueEnd,
            quote: q,
            hasValue: true,
            value: decodeEntities(html.slice(j + 1, valueEnd)),
          });
          i = Math.min(valueEnd + 1, end);
        } else {
          let k = j;
          while (k < end && !/[\s>]/.test(html[k] ?? "")) k++;
          attrs.push({
            name,
            start: nameStart,
            end: k,
            valueStart: j,
            valueEnd: k,
            quote: "",
            hasValue: true,
            value: decodeEntities(html.slice(j, k)),
          });
          i = k;
        }
      } else {
        attrs.push({
          name,
          start: nameStart,
          end: i,
          valueStart: i,
          valueEnd: i,
          quote: "",
          hasValue: false,
          value: "",
        });
      }
    }
  }
  return { nameEnd, attrs, selfClosing };
}

/**
 * @param {string} html
 * @param {Node5Element} node
 * @param {number} offset
 * @returns {ParsedElement | null} Null for an element the parser made up (no source position).
 */
export function elementOf(html, node, offset) {
  const loc = node.sourceCodeLocation;
  if (!loc || !loc.startTag) return null;
  const start = loc.startTag.startOffset + offset;
  const startTagEnd = loc.startTag.endOffset + offset;
  const scanned = scanStartTag(html, start, startTagEnd);
  const seen = new Set();
  /** @type {string[]} */
  const duplicates = [];
  for (const attr of scanned.attrs) {
    if (seen.has(attr.name) && !duplicates.includes(attr.name)) duplicates.push(attr.name);
    seen.add(attr.name);
  }
  const isVoid = VOID_TAGS.has(node.tagName);
  return {
    tag: node.tagName,
    attrs: scanned.attrs,
    duplicates,
    start,
    startTagEnd,
    end:
      (isVoid ? loc.startTag.endOffset : loc.endTag ? loc.endTag.endOffset : loc.endOffset) +
      offset,
    nameEnd: scanned.nameEnd,
    selfClosing: scanned.selfClosing,
    void: isVoid,
    unclosed: !isVoid && !loc.endTag,
  };
}

/**
 * @param {ParsedElement} element
 * @param {string} name
 * @returns {ParsedAttr | null} The first attribute of that name.
 */
export function findAttr(element, name) {
  return element.attrs.find((a) => a.name === name) ?? null;
}

/**
 * @param {ParsedElement} element
 * @param {string} name
 * @returns {string | null} The decoded value of the first attribute of that name, null if absent.
 */
export function attrValue(element, name) {
  return findAttr(element, name)?.value ?? null;
}

const ORDINALS = ["th", "st", "nd", "rd"];
/** @param {number} n 1-based */
function ordinal(n) {
  const mod = n % 100;
  return `${n}${mod >= 11 && mod <= 13 ? "th" : (ORDINALS[n % 10] ?? "th")}`;
}

/**
 * How a sentence names an element: `The video clip "a-3"`.
 * @param {{ id: string | null, tag: string, isHost?: boolean, index?: number }} clip
 * @returns {string}
 */
export function describeClip(clip) {
  const noun = clip.isHost
    ? "motion graphic"
    : clip.tag === "video"
      ? "video clip"
      : clip.tag === "audio"
        ? "audio clip"
        : clip.tag === "img"
          ? "picture clip"
          : `<${clip.tag}> element`;
  if (clip.id) return `The ${noun} "${clip.id}"`;
  if (clip.index === undefined) return `A ${noun} without an id`;
  return `The ${ordinal(clip.index + 1)} clip in index.html (a <${clip.tag}> element without an id)`;
}

/** @param {string | null} text @param {Fps | null} fps @returns {TimeAttr} */
function timeAttr(text, fps) {
  if (text === null)
    return {
      present: false,
      text: null,
      numeric: false,
      exact: null,
      frames: null,
      onFrame: false,
    };
  const reading = fps ? readSeconds(text, fps) : null;
  const numeric = /^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(text);
  return {
    present: true,
    text,
    numeric,
    exact: reading && numeric ? reading.exact : null,
    frames: reading && numeric ? reading.frames : null,
    onFrame: reading && numeric ? reading.onFrame : false,
  };
}

/** @param {string} html @returns {string} The line ending the file mostly uses. */
function dominantEol(html) {
  const crlf = (html.match(/\r\n/g) ?? []).length;
  const lf = (html.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Reads `index.html` into the root's facts and every clip. Never throws for content problems: faults
 * of the text itself (duplicate attributes, self-closing forms, missing end tags) are listed in
 * `problems`; the profile check turns them into violations and the edit functions refuse them.
 * @param {string} html
 * @returns {ParsedProject}
 */
export function parseProject(html) {
  const tree = parseHtml(html);
  const { offset } = tree;
  /** @type {ParseProblem[]} */
  const problems = [];
  /** @type {Map<string, number>} */
  const idCounts = new Map();
  /** @type {ParsedScript[]} */
  const scripts = [];
  /** @type {Node5Element[]} */
  const all = [];
  walkElements(tree.document, (node) => {
    all.push(node);
    const id = nodeAttr(node, "id");
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  });
  const rootNode = all.find((node) => nodeAttr(node, "id") === "root") ?? null;

  for (const node of all) {
    if (node.tagName !== "script") continue;
    const element = elementOf(html, node, offset);
    if (!element) continue;
    const text = node.childNodes
      .map((c) => /** @type {{ value?: string }} */ (c).value ?? "")
      .join("");
    scripts.push({ element, src: attrValue(element, "src"), text });
  }

  /** @type {ParsedRoot | null} */
  let root = null;
  /** @type {ParsedClip[]} */
  const clips = [];
  const rootEl = rootNode ? elementOf(html, rootNode, offset) : null;
  if (rootNode && rootEl) {
    const fpsText = attrValue(rootEl, "data-fps");
    const fps = parseFps(fpsText);
    const number = (/** @type {string | null} */ t) =>
      t !== null && /^\d+$/.test(t.trim()) ? Number(t.trim()) : null;
    const durationAttr = timeAttr(attrValue(rootEl, "data-duration"), fps);
    root = {
      element: rootEl,
      id: attrValue(rootEl, "id"),
      compositionId: attrValue(rootEl, "data-composition-id"),
      startText: attrValue(rootEl, "data-start"),
      width: number(attrValue(rootEl, "data-width")),
      height: number(attrValue(rootEl, "data-height")),
      fpsText,
      fps,
      durationAttr,
      duration: durationAttr.frames,
    };
    for (const name of rootEl.duplicates) {
      problems.push({
        rule: 1,
        elementId: "root",
        message: `The root element has the attribute ${name} more than once; keep only one.`,
      });
    }
    if (rootEl.unclosed) {
      problems.push({
        rule: 1,
        elementId: "root",
        message:
          "The root element has no closing tag, so the clips cannot be told apart from what follows it.",
      });
    }
    for (const child of rootNode.childNodes) {
      const node = /** @type {Node5Element} */ (child);
      if (typeof node.tagName !== "string") continue;
      const element = elementOf(html, node, offset);
      if (!element) continue;
      const classes = (attrValue(element, "class") ?? "").split(/\s+/);
      const hasClipClass = classes.includes("clip");
      const isHost = findAttr(element, "data-composition-src") !== null;
      const timed = findAttr(element, "data-start") !== null;
      const media = element.tag === "video" || element.tag === "audio" || element.tag === "img";
      if (!(hasClipClass || timed || media || isHost)) continue;
      clips.push(buildClip(clips.length, element, hasClipClass, isHost, fps, problems));
    }
    const direct = new Set(
      rootNode.childNodes.filter(
        (c) => typeof (/** @type {Node5Element} */ (c).tagName) === "string",
      ),
    );
    for (const node of all) {
      if (node === rootNode || direct.has(node)) continue;
      const strayEl = findStray(node);
      if (strayEl) {
        const id = nodeAttr(node, "id");
        const name = id ? `The <${node.tagName}> element "${id}"` : `A <${node.tagName}> element`;
        problems.push({
          rule: 2,
          elementId: id,
          message: `${name} has a data-start but is not a direct child of the root, so it is not a clip; every clip must be a direct child of the root element in index.html.`,
        });
      }
    }
  }

  return {
    html,
    bom: offset === 1,
    eol: dominantEol(html),
    root,
    clips,
    scripts,
    idCounts,
    problems,
    tree,
  };
}

/** @param {Node5Element} node @returns {boolean} */
function findStray(node) {
  return (
    nodeAttr(node, "data-start") !== null ||
    (nodeAttr(node, "class") ?? "").split(/\s+/).includes("clip")
  );
}

/**
 * @param {number} index
 * @param {ParsedElement} element
 * @param {boolean} hasClipClass
 * @param {boolean} isHost
 * @param {Fps | null} fps
 * @param {ParseProblem[]} problems
 * @returns {ParsedClip}
 */
function buildClip(index, element, hasClipClass, isHost, fps, problems) {
  const id = attrValue(element, "id");
  const get = (/** @type {string} */ n) => attrValue(element, n);
  const named = describeClip({ id: id || null, tag: element.tag, isHost, index });
  for (const name of element.duplicates) {
    problems.push({
      rule: 3,
      elementId: id || null,
      message: `${named} has the attribute ${name} more than once; keep only one.`,
    });
  }
  if (element.selfClosing && !element.void) {
    problems.push({
      rule: 2,
      elementId: id || null,
      message: `${named} is written in a self-closing form (/>), which HTML does not allow for <${element.tag}>; write a separate closing tag.`,
    });
  } else if (element.unclosed) {
    problems.push({ rule: 2, elementId: id || null, message: `${named} has no closing tag.` });
  }
  const startAttr = timeAttr(get("data-start"), fps);
  const durationAttr = timeAttr(get("data-duration"), fps);
  const mediaStartAttr = timeAttr(get("data-media-start"), fps);
  const trackText = get("data-track-index");
  const rateText = get("data-playback-rate");
  const rate =
    rateText === null ? 1 : /^\d+(\.\d+)?$/.test(rateText.trim()) ? Number(rateText.trim()) : null;
  return {
    index,
    element,
    tag: element.tag,
    id: id === null || id === "" ? null : id,
    hasClipClass,
    isHost,
    kind: get("data-vidai-kind"),
    label: get("data-vidai-label"),
    track: trackText !== null && /^\d+$/.test(trackText.trim()) ? Number(trackText.trim()) : null,
    trackText,
    startAttr,
    durationAttr,
    mediaStartAttr,
    start: startAttr.frames,
    duration: durationAttr.frames,
    mediaStart: mediaStartAttr.present ? mediaStartAttr.exact : 0,
    rateText,
    rate,
    src: get("src"),
    compositionSrc: get("data-composition-src"),
    compositionId: get("data-composition-id"),
    style: get("style"),
  };
}

// ---------------------------------------------------------------- edits

/**
 * Refuses an element whose text cannot be edited safely.
 * @param {ParsedElement} element
 * @param {string} [name] The attribute about to be changed.
 */
function assertEditable(element, name) {
  const id = attrValue(element, "id");
  const who = id ? `The <${element.tag}> element "${id}"` : `A <${element.tag}> element`;
  if (name && element.duplicates.includes(name)) {
    throw invalidInput(
      `${who} has the attribute ${name} more than once, so it cannot be edited until only one is left.`,
    );
  }
  if (element.selfClosing && !element.void) {
    throw invalidInput(
      `${who} is written in a self-closing form (/>), which HTML does not allow, so it cannot be edited.`,
    );
  }
  if (element.unclosed) throw invalidInput(`${who} has no closing tag, so it cannot be edited.`);
}

/**
 * Edits that set (or add) attributes of an element, touching nothing else: a quoted value is
 * replaced inside its quotes (same quote character), an unquoted or value-less attribute becomes
 * `name="value"`, new attributes are inserted together after the last attribute.
 * @param {ParsedElement} element
 * @param {Record<string, string | number>} changes
 * @returns {TextEdit[]}
 */
export function attrEdits(element, changes) {
  /** @type {TextEdit[]} */
  const edits = [];
  let added = "";
  for (const [rawName, rawValue] of Object.entries(changes)) {
    const name = rawName.toLowerCase();
    if (!/^[a-z_][a-z0-9_:.-]*$/.test(name))
      throw invalidInput(`"${rawName}" is not a valid attribute name.`);
    assertEditable(element, name);
    const value = String(rawValue);
    const attr = findAttr(element, name);
    if (attr && attr.quote) {
      edits.push({
        start: attr.valueStart,
        end: attr.valueEnd,
        text: escapeAttrValue(value, attr.quote),
      });
    } else if (attr) {
      edits.push({
        start: attr.start,
        end: attr.end,
        text: `${name}="${escapeAttrValue(value, '"')}"`,
      });
    } else {
      added += ` ${name}="${escapeAttrValue(value, '"')}"`;
    }
  }
  if (added) {
    const last = element.attrs[element.attrs.length - 1];
    const at = last ? last.end : element.nameEnd;
    edits.push({ start: at, end: at, text: added });
  }
  return edits;
}

/**
 * Edits that remove attributes from an element (with the blanks in front of each), touching nothing
 * else. Names that are not there are skipped.
 * @param {string} html The text `element` was parsed from.
 * @param {ParsedElement} element
 * @param {string[]} names
 * @returns {TextEdit[]}
 */
export function attrRemovalEdits(html, element, names) {
  /** @type {TextEdit[]} */
  const edits = [];
  for (const raw of names) {
    const name = raw.toLowerCase();
    const attr = findAttr(element, name);
    if (!attr) continue;
    assertEditable(element, name);
    let start = attr.start;
    while (start > element.nameEnd && /[ \t\r\n]/.test(html[start - 1] ?? "")) start--;
    edits.push({ start, end: attr.end, text: "" });
  }
  return edits;
}

/**
 * Applies non-overlapping edits to `html`.
 * @param {string} html
 * @param {TextEdit[]} edits
 * @returns {string}
 */
export function applyEdits(html, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  let limit = Infinity;
  for (const edit of sorted) {
    if (edit.end > limit) throw new Error("Overlapping text edits.");
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    limit = edit.start;
  }
  return out;
}

/**
 * Sets or adds one attribute; everything else stays byte for byte.
 * @param {string} html The text `element` was parsed from.
 * @param {ParsedElement} element
 * @param {string} name
 * @param {string | number} value
 * @returns {string}
 */
export function setAttribute(html, element, name, value) {
  return applyEdits(html, attrEdits(element, { [name]: value }));
}

/**
 * @param {string} html
 * @param {number} start
 * @param {number} end
 * @returns {{ lineStart: number, lineEnd: number, next: number, alone: boolean, indent: string, eol: string }}
 *   The line(s) the span [start, end) sits on: `lineEnd` is at the line terminator, `next` after it.
 */
function lineContext(html, start, end) {
  let lineStart = start;
  while (lineStart > 0 && html[lineStart - 1] !== "\n" && html[lineStart - 1] !== "\r") lineStart--;
  let lineEnd = end;
  while (lineEnd < html.length && html[lineEnd] !== "\n" && html[lineEnd] !== "\r") lineEnd++;
  const eol = html.startsWith("\r\n", lineEnd)
    ? "\r\n"
    : html[lineEnd] === "\n" || html[lineEnd] === "\r"
      ? (html[lineEnd] ?? "")
      : "";
  const before = html.slice(lineStart, start);
  const after = html.slice(end, lineEnd);
  const bomSkip = lineStart === 0 && before.startsWith("﻿") ? before.slice(1) : before;
  return {
    lineStart,
    lineEnd,
    next: lineEnd + eol.length,
    alone: /^[ \t]*$/.test(bomSkip) && /^[ \t]*$/.test(after),
    indent: bomSkip,
    eol,
  };
}

/**
 * The edit that removes an element, with its whole line when the line holds nothing else.
 * @param {string} html
 * @param {ParsedElement} element
 * @returns {TextEdit}
 */
export function removalEdit(html, element) {
  assertEditable(element);
  const line = lineContext(html, element.start, element.end);
  if (!line.alone) return { start: element.start, end: element.end, text: "" };
  const bom = line.lineStart === 0 && html.charCodeAt(0) === 0xfeff ? 1 : 0;
  return { start: line.lineStart + bom, end: line.next, text: "" };
}

/**
 * Removes an element (and its line when it holds nothing else).
 * @param {string} html
 * @param {ParsedElement} element
 * @returns {string}
 */
export function removeElement(html, element) {
  return applyEdits(html, [removalEdit(html, element)]);
}

/**
 * The edit that inserts a copy of an element after it, with attributes changed. On a line of its own
 * the copy gets a line of its own with the same indentation and the file's line ending; the insertion
 * goes after any trailing blanks, so no existing byte moves or changes.
 * @param {string} html
 * @param {ParsedElement} element
 * @param {Record<string, string | number>} changes
 * @param {string[]} [remove] Attributes the copy does not keep.
 * @returns {TextEdit}
 */
export function copyAfterEdit(html, element, changes, remove = []) {
  assertEditable(element);
  const inner = [...attrEdits(element, changes), ...attrRemovalEdits(html, element, remove)].map(
    (e) => ({
      ...e,
      start: e.start - element.start,
      end: e.end - element.start,
    }),
  );
  const copy = applyEdits(html.slice(element.start, element.end), inner);
  const line = lineContext(html, element.start, element.end);
  if (!line.alone) return { start: element.end, end: element.end, text: copy };
  const eol = line.eol || dominantEol(html);
  return { start: line.lineEnd, end: line.lineEnd, text: `${eol}${line.indent}${copy}` };
}

/**
 * Inserts a copy of an element after it with attributes changed (used by split).
 * @param {string} html
 * @param {ParsedElement} element
 * @param {Record<string, string | number>} changes
 * @returns {string}
 */
export function insertCopyAfter(html, element, changes) {
  return applyEdits(html, [copyAfterEdit(html, element, changes)]);
}

/**
 * A new id derived from an old one that no element uses yet: `a-3` becomes `a-3-2`, `a-3-3`, ...
 * @param {string} base
 * @param {{ has(id: string): boolean }} taken
 * @returns {string}
 */
export function uniqueId(base, taken) {
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

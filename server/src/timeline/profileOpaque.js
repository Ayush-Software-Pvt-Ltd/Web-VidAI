// Profile rule 12 (docs/SPEC.md section 10): a full-screen graphic (a host of the kind `graphic`, on
// the B-roll track, so the clip under it is hidden) has an opaque background over the whole frame.
// Its composition file is read as text and never run; a person on the timeline sees the video
// through any part that paints nothing.
//
// What counts as opaque, the same reading as the toolkit's `hides_the_video`:
// - the composition's root paints a background (a color that is not transparent and has alpha above
//   0, a gradient, an image, or anything with `var(...)`), or
// - its first child is a picture, footage or canvas (`img`, `video`, `canvas`), or
// - its first child paints a background and covers the whole frame (`inset: 0`, all four sides 0,
//   `100%` of width and height, or the frame's own size in pixels).
// Rules are read only when their selector is one plain `#id` or `.class` of the element (or a list of
// them); the element's `style` attribute comes last.

import { parseHtml, walkElements } from "./document.js";

/**
 * @typedef {object} CssElement
 * @property {string} tag
 * @property {Map<string, string>} attrs
 * @property {number | null} parent Index of the parent element in the same list.
 */

const NOT_COLORS = new Set(
  (
    "transparent none inherit initial unset revert repeat no-repeat repeat-x repeat-y space round center " +
    "top bottom left right cover contain auto fixed scroll local border-box padding-box content-box " +
    "text to at from"
  ).split(" "),
);

/** @param {string} text @param {string} sep @returns {string[]} The text cut at `sep` outside parentheses and quotes. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** @param {string} text @returns {[string, string][]} Property and value pairs of a style attribute or a rule's inside. */
function declarations(text) {
  /** @type {[string, string][]} */
  const out = [];
  for (const part of splitTop(text, ";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name && value) out.push([name, value]);
  }
  return out;
}

/** @param {string} css @returns {{ selector: string, inside: string }[]} The rules at the top level (comments removed); an at-rule block is one entry. */
function cssRules(css) {
  const out = [];
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open < 0) return out;
    let depth = 1;
    let k = open + 1;
    while (k < css.length && depth) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") depth--;
      k++;
    }
    const selector = (css.slice(i, open).split(";").pop() ?? "").trim();
    out.push({ selector, inside: css.slice(open + 1, k - 1) });
    i = k;
  }
}

/** @param {string} value @returns {boolean} False for transparent, none and a color with alpha 0; true for anything that draws. */
function colorPaints(value) {
  let v = value.toLowerCase().replace("!important", "").trim();
  if (v.includes("var(")) return true;
  v = v.replace(
    /(?:linear|radial|conic|repeating-\w+)-gradient\([^)]*(?:\([^)]*\)[^)]*)*\)|url\([^)]*\)/g,
    " ",
  );
  const tokens = /#[0-9a-f]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\([^)]*\)|[a-z][a-z-]*/g;
  for (const [t] of v.matchAll(tokens)) {
    if (t.startsWith("#")) {
      if ((t.length === 5 && t[4] === "0") || (t.length === 9 && t.slice(7) === "00")) continue;
      return true;
    }
    if (t.includes("(")) {
      const parts = t.slice(t.indexOf("(") + 1, -1).split(/[,/]/);
      if (parts.length >= 4 || t.includes("/")) {
        const alpha = (parts.at(-1) ?? "").trim().replace(/%+$/, "");
        if (alpha !== "" && Number(alpha) === 0) continue;
      }
      return true;
    }
    if (!NOT_COLORS.has(t) && !/^[a-z]*(?:px|em|rem|vw|vh|deg|turn|rad|%)$/.test(t)) return true;
  }
  return false;
}

/** @param {string} value @returns {boolean} Whether a background value holds a gradient or an image. */
const picture = (value) => /gradient\(|url\(/i.test(value);

/** @param {[string, string][]} decls @returns {boolean} Whether the background that applies after the cascade draws anything. */
function backgroundPaints(decls) {
  /** @type {[string, string][]} */
  let kept = [];
  for (const [prop, value] of decls) {
    if (prop === "background") kept = [["background", value]];
    else if (prop.startsWith("background-"))
      kept = [...kept.filter(([k]) => k !== prop), [prop, value]];
  }
  let painted = false;
  for (const [prop, value] of kept) {
    if (prop === "background") painted = picture(value) || colorPaints(value);
    else if (prop === "background-color") painted = painted || colorPaints(value);
    else if (prop === "background-image")
      painted = painted || picture(value) || value.toLowerCase().includes("var(");
  }
  return painted;
}

/** @param {[string, string][]} decls @param {number} width @param {number} height @returns {boolean} Whether the declarations make a box over the whole frame. */
function coversFrame(decls, width, height) {
  const d = new Map(decls);
  const zero = (/** @type {string | undefined} */ v) =>
    /^0+(?:\.0+)?(?:px|%)?$/.test((v ?? "").trim());
  const position = d.get("position");
  if (position === "absolute" || position === "fixed") {
    const inset = d.get("inset");
    if (inset && inset.split(/\s+/).filter(Boolean).every(zero)) return true;
    if (["top", "left", "right", "bottom"].every((k) => zero(d.get(k)))) return true;
  }
  const full = (/** @type {string | undefined} */ value, /** @type {number} */ edge) => {
    const v = (value ?? "").trim().toLowerCase();
    const px = /^([\d.]+)px$/.exec(v);
    return (
      v === "100%" ||
      v === (edge === width ? "100vw" : "100vh") ||
      (px !== null && Number(px[1]) >= edge)
    );
  };
  return full(d.get("width"), width) && full(d.get("height"), height);
}

/**
 * @param {string} text A composition file.
 * @returns {{ elements: CssElement[], css: string[] }}
 */
function readComposition(text) {
  const tree = parseHtml(text);
  /** @type {CssElement[]} */
  const elements = [];
  /** @type {string[]} */
  const css = [];
  /** @type {Map<unknown, number>} */
  const indexOf = new Map();
  walkElements(tree.document, (node, parent) => {
    if (node.tagName === "style") {
      css.push(
        node.childNodes.map((c) => /** @type {{ value?: string }} */ (c).value ?? "").join(""),
      );
      return;
    }
    if (node.tagName === "script") return;
    indexOf.set(node, elements.length);
    elements.push({
      tag: node.tagName,
      attrs: new Map(node.attrs.map((a) => [a.name, a.value])),
      parent: indexOf.get(parent) ?? null,
    });
  });
  return { elements, css };
}

/**
 * Whether the page of a full-screen graphic hides the video under it.
 * @param {string} text The text of `compositions/<id>.html`.
 * @param {string} id The composition id of the host.
 * @param {number} width The frame width.
 * @param {number} height The frame height.
 * @returns {boolean} True when it has an opaque background over the whole frame, or has no root that could be read (rule 8 says so then).
 */
export function hidesTheVideo(text, id, width, height) {
  const { elements, css } = readComposition(text);
  const rootIndex = elements.findIndex((e) => e.attrs.get("data-composition-id") === id);
  if (rootIndex < 0) return true;
  const rules = css.flatMap((chunk) => cssRules(chunk.replace(/\/\*[\s\S]*?\*\//g, "")));
  /** @param {number} i */
  const declared = (i) => {
    const attrs = elements[i]?.attrs ?? new Map();
    const ids = attrs.get("id") ? [attrs.get("id")] : [];
    const classes = (attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
    /** @type {[string, string][]} */
    const out = [];
    for (const rule of rules) {
      const matches = rule.selector.split(",").some((one) => {
        const s = one.trim();
        return (
          (s[0] === "#" && ids.includes(s.slice(1))) ||
          (s[0] === "." && classes.includes(s.slice(1)))
        );
      });
      if (matches) out.push(...declarations(rule.inside));
    }
    out.push(...declarations(attrs.get("style") ?? ""));
    return out;
  };
  if (backgroundPaints(declared(rootIndex))) return true;
  const first = elements.findIndex((e) => e.parent === rootIndex);
  if (first < 0) return false;
  if (["video", "img", "canvas"].includes(elements[first]?.tag ?? "")) return true;
  const own = declared(first);
  return backgroundPaints(own) && coversFrame(own, width, height);
}

// Profile rule 10 (docs/SPEC.md section 10): every `src` and every file reference is a relative path
// inside the project without `..`; nothing is loaded from the network.
//
// What is allowed: a reference is accepted when, after decoding percent escapes (up to three rounds,
// so "%252e" is caught too), it is not empty, holds no control character and no backslash, has no
// scheme (so `http:`, `https:`, `file:`, `data:`, `blob:`, `javascript:` and Windows drives `C:` are
// all refused), does not start with `/` or `//`, and has no `..` segment. A query string or fragment
// is ignored for the path test; a value that is only a fragment (`#shape`, a reference inside the
// document) is allowed. Links under `assets/media/` may point outside the project folder on disk;
// that is checked when files are served, not here.

import { nodeAttr, walkElements } from "./document.js";

/** @typedef {import("./document.js").HtmlTree} HtmlTree */

/**
 * @param {string} value
 * @returns {string | null} Null when the reference is fine, else why it is not (a clause).
 */
export function pathProblem(value) {
  const trimmed = value.trim();
  if (trimmed === "") return "is empty";
  if (trimmed.startsWith("#")) return null;
  let current = trimmed;
  for (let round = 0; round < 4; round++) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(current)) return "holds a control character";
    if (current.includes("\\")) return "holds a backslash";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(current))
      return "has a scheme (such as http: or file:), so it points outside the project";
    if (current.startsWith("/"))
      return current.startsWith("//")
        ? "starts with // (a link to another host)"
        : "starts with a slash (an absolute path)";
    const path = current.split(/[?#]/)[0] ?? "";
    if (path.split("/").some((segment) => segment === ".."))
      return 'holds a ".." segment, which leaves the project folder';
    // Only ASCII escapes matter for the tests above; a malformed escape is left as it is.
    const decoded = current.replace(/%([0-7][0-9a-fA-F])/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    if (decoded === current) return null;
    current = decoded;
  }
  return null;
}

/**
 * @typedef {Object} Reference
 * @property {string} elementId The element's id ("" when it has none).
 * @property {string} tag
 * @property {string} where The attribute or place it was found in ("src", "style attribute", ...).
 * @property {string} value
 */

const URL_ATTRS = new Set([
  "src",
  "href",
  "data-composition-src",
  "poster",
  "action",
  "formaction",
  "background",
  "data-src",
]);

/**
 * Every file reference of a style text: `url(...)` and `@import "..."`.
 * @param {string} css
 * @returns {string[]}
 */
export function cssReferences(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  /** @type {string[]} */
  const found = [];
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    found.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  for (const m of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi))
    found.push(m[1] ?? m[2] ?? "");
  return found;
}

/**
 * Every file reference in a parsed document (template contents included): the attributes in
 * `URL_ATTRS`, `srcset`, `xlink:href`, `url(...)` in `style` attributes and `<style>` elements.
 * @param {HtmlTree} tree
 * @returns {Reference[]}
 */
export function collectReferences(tree) {
  /** @type {Reference[]} */
  const refs = [];
  walkElements(tree.document, (node) => {
    const elementId = nodeAttr(node, "id") ?? "";
    const tag = node.tagName;
    for (const attr of node.attrs) {
      const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      if (URL_ATTRS.has(name) || name === "xlink:href") {
        refs.push({ elementId, tag, where: name, value: attr.value });
      } else if (name === "srcset") {
        for (const candidate of attr.value.split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) refs.push({ elementId, tag, where: "srcset", value: url });
        }
      } else if (name === "style") {
        for (const value of cssReferences(attr.value))
          refs.push({ elementId, tag, where: "style attribute", value });
      }
    }
    if (tag === "style") {
      const text = node.childNodes
        .map((c) => /** @type {{ value?: string }} */ (c).value ?? "")
        .join("");
      for (const value of cssReferences(text))
        refs.push({ elementId, tag, where: "style element", value });
    }
  });
  return refs;
}

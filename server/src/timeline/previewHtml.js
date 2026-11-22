// Adding the HyperFrames runtime to the project's page on the way out (docs/SPEC.md section 11).
// The project folder stays untouched: the one script tag is spliced into the bytes of the answer.
import { parse } from "parse5";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * @typedef {import("parse5").DefaultTreeAdapterMap["node"]} Node
 * @typedef {import("parse5").DefaultTreeAdapterMap["element"]} Element
 */

/**
 * @param {Node} node
 * @returns {node is Element}
 */
function isElement(node) {
  return "tagName" in node;
}

/**
 * @param {Node | undefined} node
 * @returns {{ endOffset: number } | null} The start tag as written; null when the parser implied it.
 */
function startTagOf(node) {
  const location = node?.sourceCodeLocation;
  if (location && "startTag" in location && location.startTag) return location.startTag;
  return null;
}

/**
 * Where a script has to go to become the first element of `<head>`, as an offset into `text`.
 * Without a `<head>` tag the parser makes the head itself, so a script right after the `<html>` tag
 * (or the doctype, or at the very start) ends up first in that head; a doctype is never moved.
 * @param {string} text
 * @returns {number}
 */
function insertionPoint(text) {
  const document = parse(text, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find((node) => isElement(node) && node.tagName === "html");
  if (html && isElement(html)) {
    const head = html.childNodes.find((node) => isElement(node) && node.tagName === "head");
    const headTag = startTagOf(head);
    if (headTag) return headTag.endOffset;
    const htmlTag = startTagOf(html);
    if (htmlTag) return htmlTag.endOffset;
  }
  const doctype = document.childNodes.find((node) => node.nodeName === "#documentType");
  return doctype?.sourceCodeLocation?.endOffset ?? 0;
}

/**
 * Put `<script src="..."></script>` first in `<head>` and leave every other byte as it was.
 * The text is read as Latin-1 so offsets are byte offsets and any encoding comes back unchanged.
 * @param {Buffer} html The project's `index.html`.
 * @param {string} src Address of the runtime script (plain URL characters only).
 * @returns {Buffer}
 */
export function injectRuntimeScript(html, src) {
  const hasBom = html.subarray(0, 3).equals(BOM);
  const body = hasBom ? html.subarray(3) : html;
  const text = body.toString("latin1");
  const at = insertionPoint(text);
  const tag = `<script src="${src}"></script>`;
  return Buffer.concat([
    hasBom ? BOM : Buffer.alloc(0),
    Buffer.from(text.slice(0, at), "latin1"),
    Buffer.from(tag, "latin1"),
    Buffer.from(text.slice(at), "latin1"),
  ]);
}

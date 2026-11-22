// Profile rule 8, the file side (docs/SPEC.md section 10): `compositions/<id>.html` is a HyperFrames
// sub-composition, a `<template>` holding a root with the composition id and a script that registers
// `window.__timelines["<id>"]`. The check reads the text only; the script is never run.

import { nodeAttr, parseHtml, walkElements } from "./document.js";

/** @param {string} text @returns {string} */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} html The file's text.
 * @param {string} id The composition id the host asks for.
 * @returns {string | null} A clause saying what is wrong ("holds no <template>"), or null when it is
 *   a sub-composition.
 */
export function compositionFileProblem(html, id) {
  const tree = parseHtml(html);
  /** @type {import("parse5").DefaultTreeAdapterMap["element"] | null} */
  let template = null;
  walkElements(tree.document, (node) => {
    if (!template && node.tagName === "template") template = node;
  });
  if (!template) return "has no <template>, which is what a sub-composition is wrapped in";
  const content = /** @type {import("parse5").DefaultTreeAdapterMap["template"]} */ (template)
    .content;
  let hasRoot = false;
  let registers = false;
  const registration = new RegExp(
    `window\\s*\\.\\s*__timelines\\s*\\[\\s*(["'\`])${escapeRegExp(id)}\\1\\s*\\]\\s*=`,
  );
  walkElements(content, (node) => {
    if (nodeAttr(node, "data-composition-id") === id && node.tagName !== "script") hasRoot = true;
    if (node.tagName === "script" && nodeAttr(node, "src") === null) {
      const text = node.childNodes
        .map((c) => /** @type {{ value?: string }} */ (c).value ?? "")
        .join("");
      if (registration.test(text)) registers = true;
    }
  });
  if (!hasRoot) return `holds no element with data-composition-id="${id}" inside its <template>`;
  if (!registers)
    return `has no script inside its <template> that registers window.__timelines["${id}"]`;
  return null;
}

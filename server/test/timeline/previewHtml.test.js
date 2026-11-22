import assert from "node:assert/strict";
import test from "node:test";
import { injectRuntimeScript } from "../../src/timeline/previewHtml.js";

const SRC = "/p/TOKEN/__hf/runtime.js";
const TAG = `<script src="${SRC}"></script>`;

/** @param {string | Buffer} html */
const inject = (html) =>
  injectRuntimeScript(typeof html === "string" ? Buffer.from(html, "utf8") : html, SRC).toString(
    "utf8",
  );

test("the script becomes the first element of head and nothing else changes", () => {
  const html =
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n  <body></body>\n</html>\n';
  const out = inject(html);
  assert.equal(out, html.replace("<head>", `<head>${TAG}`));
});

test("attributes, uppercase tags and a comment before head are handled", () => {
  const html =
    '<!DOCTYPE html><!-- <head> --><HTML><HEAD data-x=">"><title>t</title></HEAD><BODY></BODY></HTML>';
  assert.equal(inject(html), html.replace('<HEAD data-x=">">', `<HEAD data-x=">">${TAG}`));
});

test("a head word in a script or comment is not mistaken for the head", () => {
  const html =
    "<!doctype html><html><!-- <head> --><head><script>var s='<head>';</script></head><body></body></html>";
  assert.equal(inject(html), html.replace("<head><script>", `<head>${TAG}<script>`));
});

test("without a head tag the script goes right after the html tag", () => {
  const html = "<!doctype html>\n<html>\n<body><p>x</p></body>\n</html>\n";
  assert.equal(inject(html), html.replace("<html>", `<html>${TAG}`));
});

test("without head and html tags the script goes after the doctype, never before it", () => {
  const html = "<!doctype html><body>hi</body>";
  assert.equal(inject(html), `<!doctype html>${TAG}<body>hi</body>`);
});

test("a fragment without anything gets the script first", () => {
  assert.equal(inject("<div>x</div>"), `${TAG}<div>x</div>`);
  assert.equal(inject(""), TAG);
});

test("CRLF line endings and a byte order mark stay as they are", () => {
  const html =
    "﻿<!doctype html>\r\n<html>\r\n<head>\r\n<meta charset=utf-8>\r\n</head>\r\n</html>\r\n";
  assert.equal(inject(html), html.replace("<head>", `<head>${TAG}`));
});

test("bytes that are not valid UTF-8 come back unchanged", () => {
  const before = Buffer.from('<html><head><meta charset="latin1"></head><body>', "latin1");
  const odd = Buffer.from([0xe9, 0xff, 0x80, 0x0d, 0x0a]);
  const input = Buffer.concat([before, odd, Buffer.from("</body></html>")]);
  const out = injectRuntimeScript(input, SRC);
  const at = input.indexOf("<head>") + "<head>".length;
  assert.deepEqual(out.subarray(0, at), input.subarray(0, at));
  assert.equal(out.subarray(at, at + TAG.length).toString(), TAG);
  assert.deepEqual(out.subarray(at + TAG.length), input.subarray(at));
});

test("multi-byte text before the head keeps its offsets", () => {
  const html = "<!doctype html><!-- ä中文😀 --><html><head></head></html>";
  assert.equal(inject(html), html.replace("<head>", `<head>${TAG}`));
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { rawRequest, startServer } from "./support.js";

describe("the built UI", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  before(async () => {
    t = await startServer({
      files: {
        "index.html": "<!doctype html><title>VidAI</title>",
        "assets/app-abc123.js": "console.log(1)",
        "assets/app-abc123.css": "body{}",
        "assets/logo.svg": "<svg/>",
        "favicon.ico": "ico",
        "sub/page.html": "<p>sub</p>",
        "sub/index.html": "<p>sub index</p>",
      },
    });
    // Something outside dist/ that a traversal would reach.
    fs.writeFileSync(path.join(t.dir, "secret.txt"), "TOP SECRET");
    fs.symlinkSync(path.join(t.dir, "secret.txt"), path.join(t.uiDist, "link.txt"));
  });
  after(() => t.close());

  test("/ and unknown paths give index.html, which is never cached", async () => {
    for (const urlPath of ["/", "/channels/abc", "/setup", "/deep/er/path/", "/index.html"]) {
      const reply = await t.request("GET", urlPath);
      assert.equal(reply.status, 200, urlPath);
      assert.equal(reply.text, "<!doctype html><title>VidAI</title>", urlPath);
      assert.equal(reply.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(reply.headers["cache-control"], "no-cache");
    }
  });

  test("hashed assets are cached for a year as immutable, with their content types", async () => {
    const js = await t.request("GET", "/assets/app-abc123.js");
    assert.equal(js.text, "console.log(1)");
    assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable");
    const css = await t.request("GET", "/assets/app-abc123.css");
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
    const svg = await t.request("GET", "/assets/logo.svg");
    assert.equal(svg.headers["content-type"], "image/svg+xml");
  });

  test("other files are no-cache", async () => {
    const reply = await t.request("GET", "/favicon.ico");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["cache-control"], "no-cache");
    assert.equal(reply.headers["content-type"], "image/x-icon");
  });

  test("a folder serves its index.html", async () => {
    assert.equal((await t.request("GET", "/sub/")).text, "<p>sub index</p>");
    assert.equal((await t.request("GET", "/sub")).text, "<p>sub index</p>");
  });

  test("a missing asset or file is 404, not the page", async () => {
    for (const urlPath of ["/assets/missing.js", "/assets/", "/nothing.png", "/x/y.css"]) {
      const reply = await t.request("GET", urlPath);
      assert.equal(reply.status, 404, urlPath);
      assert.equal(reply.headers["content-type"], "application/json; charset=utf-8");
    }
  });

  test("HEAD answers headers only", async () => {
    const reply = await t.request("HEAD", "/assets/app-abc123.js");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-length"], "14");
    assert.equal(reply.body.length, 0);
  });

  test("ETag allows a 304", async () => {
    const first = await t.request("GET", "/");
    const again = await t.request("GET", "/", {
      headers: { "If-None-Match": String(first.headers.etag) },
    });
    assert.equal(again.status, 304);
  });

  test("other methods on UI paths are 405", async () => {
    const reply = await t.request("DELETE", "/channels", { changing: true });
    assert.equal(reply.status, 405);
  });

  test("a path can never leave the folder", async () => {
    const attempts = [
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/..%5csecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/%252e%252e%252fsecret.txt",
      "/..%00/secret.txt",
      "/assets/..\\..\\secret.txt",
      "/link.txt",
      "/%c0%ae%c0%ae/secret.txt",
    ];
    for (const attempt of attempts) {
      const reply = await t.request("GET", attempt);
      assert.ok(!reply.text.includes("TOP SECRET"), attempt);
    }
    assert.equal((await t.request("GET", "/link.txt")).status, 404);
  });

  test("a raw request with dot segments cannot leave the folder either", async () => {
    const reply = await rawRequest(
      t,
      "GET /assets/../../secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    assert.ok(!reply.includes("TOP SECRET"));
    assert.match(reply, /^HTTP\/1\.1 (200|404)/);
  });

  test("malformed percent escapes are a clean 404", async () => {
    const reply = await t.request("GET", "/%E0%A4%A");
    assert.equal(reply.status, 404);
  });

  test("a request target that is not a path is refused", async () => {
    for (const target of ["http://evil.example/x", "*"]) {
      const reply = await rawRequest(
        t,
        `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
      assert.match(reply, /^HTTP\/1\.1 400/, target);
    }
  });

  test("a double slash path is a path of this server, not another host", async () => {
    const reply = await rawRequest(
      t,
      "GET //evil.example/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /VidAI/);
  });
});

describe("a UI directory that was never built", () => {
  test("says so with a 503 and still answers the API", async () => {
    const t = await startServer();
    try {
      const reply = await t.request("GET", "/");
      assert.equal(reply.status, 503);
      assert.match(reply.text, /not been built/);
      assert.equal((await t.request("GET", "/api/x")).status, 404);
    } finally {
      await t.close();
    }
  });
});

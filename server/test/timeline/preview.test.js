import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPreview, PREVIEW_CSP } from "../../src/timeline/preview.js";
import { splitRequestedPath } from "../../src/timeline/previewPaths.js";
import { makePreviewProject, rawRequest, startRouteServer } from "../support/previewHarness.js";

const log = { info() {}, warn() {}, error() {} };
const CSP =
  "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'";

/**
 * @param {{ proxyFor?: (real: string) => string | null }} [options]
 */
async function setup(options = {}) {
  const project = makePreviewProject();
  const clock = {
    t: 1000,
    now() {
      return this.t;
    },
  };
  const runtimeFile = path.join(project.root, "runtime.js");
  fs.writeFileSync(runtimeFile, "window.__runtime = true;\n");
  const preview = createPreview({ clock, log, runtimeFile, ttlMs: 5000, ...options });
  const server = await startRouteServer(preview.routes);
  const { token, url } = preview.open({
    sessionId: "s1",
    userId: "u1",
    videoKey: "v1",
    projectDir: project.projectDir,
    videoDir: project.videoDir,
    channelDir: project.channelDir,
  });
  return {
    ...project,
    clock,
    preview,
    token,
    url,
    runtimeFile,
    /** @param {string} rest @param {{ method?: string, headers?: Record<string, string> }} [req] */
    get: (rest, req) => rawRequest(server.port, `/p/${token}/${rest}`, req),
    /** @param {string} rawPath @param {{ method?: string, headers?: Record<string, string> }} [req] */
    raw: (rawPath, req) => rawRequest(server.port, rawPath, req),
    async done() {
      preview.stop();
      await server.close();
      project.cleanup();
    },
  };
}

/** @param {{ headers: import("node:http").IncomingHttpHeaders }} answer */
function assertPreviewHeaders(answer) {
  assert.equal(answer.headers["content-security-policy"], CSP);
  assert.equal(answer.headers["access-control-allow-origin"], "*");
  assert.equal(answer.headers["x-content-type-options"], "nosniff");
  assert.equal(answer.headers["cross-origin-resource-policy"], "cross-origin");
}

test("the CSP constant is exactly the one of SPEC section 11", () => {
  assert.equal(PREVIEW_CSP, CSP);
});

test("every kind of answer carries the preview headers", async () => {
  const t = await setup();
  try {
    const answers = [
      await t.get(""),
      await t.get("index.html"),
      await t.get("compositions/g-1.html"),
      await t.get("style.css"),
      await t.get("assets/media/aroll.mp4"),
      await t.get("assets/media/aroll.mp4", { headers: { range: "bytes=0-9" } }),
      await t.get("assets/media/aroll.mp4", { headers: { range: "bytes=5000-" } }),
      await t.get("__hf/runtime.js"),
      await t.get("missing.txt"),
      await t.get("../x"),
      await t.get("assets"),
      await t.get("", { method: "HEAD" }),
      await t.raw(`/p/${"A".repeat(43)}/`),
      await t.raw("/p/short/index.html"),
      await t.raw("/p/"),
    ];
    assert.deepEqual(
      answers.map((a) => a.status),
      [200, 200, 200, 200, 200, 206, 416, 200, 404, 404, 404, 200, 404, 404, 404],
    );
    for (const answer of answers) assertPreviewHeaders(answer);
    // The server's own DENY for frames and its policy are replaced, not repeated.
    assert.equal(t.preview.routes.length, 1);
    assert.notEqual(answers[0]?.headers["x-frame-options"], "DENY");
  } finally {
    await t.done();
  }
});

test("unknown and expired tokens get a short text 404", async () => {
  const t = await setup();
  try {
    const unknown = await t.raw(`/p/${"B".repeat(43)}/index.html`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers["content-type"] ?? "", /^text\/plain/);
    assert.match(unknown.body.toString(), /not valid/);
    t.clock.t += 5000;
    const expired = await t.get("index.html");
    assert.equal(expired.status, 404);
    assert.match(expired.body.toString(), /not valid/);
    t.preview.sweep();
    const reopened = t.preview.open({
      sessionId: "s1",
      userId: "u1",
      videoKey: "v1",
      projectDir: t.projectDir,
      videoDir: t.videoDir,
      channelDir: t.channelDir,
    });
    assert.notEqual(reopened.token, t.token);
  } finally {
    await t.done();
  }
});

test("closing the session or the video stops the address", async () => {
  const t = await setup();
  try {
    assert.equal((await t.get("index.html")).status, 200);
    t.preview.closeVideo("v1");
    assert.equal((await t.get("index.html")).status, 404);
    const again = t.preview.open({
      sessionId: "s1",
      userId: "u1",
      videoKey: "v1",
      projectDir: t.projectDir,
      videoDir: t.videoDir,
      channelDir: t.channelDir,
    });
    assert.equal((await t.raw(`${again.url}index.html`)).status, 200);
    t.preview.closeSession("s1");
    assert.equal((await t.raw(`${again.url}index.html`)).status, 404);
  } finally {
    await t.done();
  }
});

test("the address without its trailing slash redirects, a wrong token does not", async () => {
  const t = await setup();
  try {
    const moved = await t.raw(`/p/${t.token}`);
    assert.equal(moved.status, 308);
    assert.equal(moved.headers.location, `/p/${t.token}/`);
    assertPreviewHeaders(moved);
    assert.equal((await t.raw(`/p/${"C".repeat(43)}`)).status, 404);
  } finally {
    await t.done();
  }
});

test("index.html is served with one runtime script first in head and no other change", async () => {
  const t = await setup();
  try {
    const original = fs.readFileSync(path.join(t.projectDir, "index.html"), "utf8");
    const tag = `<script src="/p/${t.token}/__hf/runtime.js"></script>`;
    for (const rest of ["", "index.html"]) {
      const answer = await t.get(rest);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(answer.headers["cache-control"], "no-store");
      assert.equal(answer.headers["content-length"], String(answer.body.length));
      assert.equal(answer.body.toString(), original.replace("<head>", `<head>${tag}`));
    }
    assert.equal(
      fs.readFileSync(path.join(t.projectDir, "index.html"), "utf8"),
      original,
      "the project file is never changed",
    );
  } finally {
    await t.done();
  }
});

test("the runtime is served under the token, cacheable, with Range", async () => {
  const t = await setup();
  try {
    const answer = await t.get("__hf/runtime.js");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.toString(), "window.__runtime = true;\n");
    assert.equal(answer.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(answer.headers["cache-control"] ?? "", /max-age=3600/);
    const part = await t.get("__hf/runtime.js", { headers: { range: "bytes=0-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.body.toString(), "window");
  } finally {
    await t.done();
  }
});

test("the default runtime file is the pinned package's", async () => {
  const preview = createPreview({ clock: { now: () => 0 }, log });
  const server = await startRouteServer(preview.routes);
  const project = makePreviewProject();
  try {
    const { token } = preview.open({
      sessionId: "s",
      userId: "u",
      videoKey: "k",
      projectDir: project.projectDir,
      videoDir: project.videoDir,
      channelDir: project.channelDir,
    });
    const answer = await rawRequest(server.port, `/p/${token}/__hf/runtime.js`);
    assert.equal(answer.status, 200);
    const real = path.join(
      import.meta.dirname,
      "../../../node_modules/hyperframes/dist/hyperframe.runtime.iife.js",
    );
    assert.deepEqual(answer.body, fs.readFileSync(real));
  } finally {
    preview.stop();
    await server.close();
    project.cleanup();
  }
});

test("content types of the files a project holds", async () => {
  const t = await setup();
  try {
    const media = path.join(t.projectDir, "assets");
    const names = {
      "a.mp4": "video/mp4",
      "a.mov": "video/quicktime",
      "a.m4a": "audio/mp4",
      "a.mp3": "audio/mpeg",
      "a.wav": "audio/wav",
      "a.png": "image/png",
      "a.jpg": "image/jpeg",
      "a.webp": "image/webp",
      "a.svg": "image/svg+xml",
      "a.woff2": "font/woff2",
      "a.ttf": "font/ttf",
      "a.otf": "font/otf",
      "a.json": "application/json; charset=utf-8",
      "a.js": "text/javascript; charset=utf-8",
      "a.css": "text/css; charset=utf-8",
      "a.html": "text/html; charset=utf-8",
      "a.xyz": "application/octet-stream",
      noext: "application/octet-stream",
    };
    for (const [name, type] of Object.entries(names)) {
      fs.writeFileSync(path.join(media, name), "x");
      const answer = await t.get(`assets/${name}`);
      assert.equal(answer.status, 200, name);
      assert.equal(answer.headers["content-type"], type, name);
    }
    assert.equal((await t.get("assets/a.html")).headers["cache-control"], "no-store");
    assert.equal((await t.get("compositions/g-1.html")).headers["cache-control"], "no-store");
    assert.equal(
      (await t.get("compositions/g-1.html")).body.toString(),
      "<template><div>g-1</div></template>\n",
      "compositions get no runtime script",
    );
  } finally {
    await t.done();
  }
});

test("media is served with HTTP Range through the links of assets/media", async () => {
  const t = await setup();
  try {
    const whole = await t.get("assets/media/aroll.mp4");
    assert.equal(whole.status, 200);
    assert.equal(whole.body.length, 1000);
    assert.equal(whole.headers["accept-ranges"], "bytes");
    const part = await t.get("assets/media/aroll.mp4", { headers: { range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], "bytes 10-19/1000");
    assert.equal(part.body.length, 10);
    const tail = await t.get("assets/media/aroll.mp4", { headers: { range: "bytes=-100" } });
    assert.equal(tail.headers["content-range"], "bytes 900-999/1000");
    const bad = await t.get("assets/media/aroll.mp4", { headers: { range: "bytes=2000-" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers["content-range"], "bytes */1000");
    const other = await t.get("assets/media/broll.mp4");
    assert.equal(other.status, 200, "a link into the channel directory is allowed");
    assert.equal(other.body.length, 500);
  } finally {
    await t.done();
  }
});

test("HEAD answers like GET without a body", async () => {
  const t = await setup();
  try {
    for (const rest of ["", "style.css", "assets/media/aroll.mp4", "__hf/runtime.js"]) {
      const get = await t.get(rest);
      const head = await t.get(rest, { method: "HEAD" });
      assert.equal(head.status, 200, rest);
      assert.equal(head.body.length, 0, rest);
      assert.equal(head.headers["content-length"], get.headers["content-length"], rest);
      assert.equal(head.headers["content-type"], get.headers["content-type"], rest);
      assertPreviewHeaders(head);
    }
    const missing = await t.get("nothing", { method: "HEAD" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.length, 0);
    assertPreviewHeaders(missing);
  } finally {
    await t.done();
  }
});

test("only GET and HEAD are routed", async () => {
  const t = await setup();
  try {
    const put = await t.get("index.html", { method: "PUT" });
    assert.equal(put.status, 405);
  } finally {
    await t.done();
  }
});

test("path safety: text rules", async () => {
  const t = await setup();
  try {
    const refused = [
      "../index.html",
      "%2e%2e/index.html",
      "%2E%2E%2Findex.html",
      "compositions//g-1.html",
      "compositions/",
      "compositions",
      "/index.html",
      "%2Findex.html",
      "..%2F..%2Fsecret.txt",
      "a%5Cb",
      "compositions%5Cg-1.html",
      "index.html%00.png",
      "%00",
      ".hyperframes/secret.json",
      "%2Ehyperframes/secret.json",
      "compositions/.hidden",
      ".git/config",
      "C:/Windows/win.ini",
      "C%3A%5CWindows",
      "index.html:stream",
    ];
    for (const rest of refused) {
      const answer = await t.get(rest);
      assert.equal(answer.status, 404, `${rest} -> ${answer.status}`);
      assertPreviewHeaders(answer);
    }
    assert.equal(
      (await t.raw(`/p/${t.token}/..%2f..%2f..%2fetc/passwd`)).status,
      404,
      "an absolute-looking escape",
    );
    assert.equal((await t.raw(`/p/${t.token}/../../etc/passwd`)).status, 404);
    // Sanity: the allowed neighbours of those paths do work, so the 404s above are the rules.
    assert.equal((await t.get("compositions/g-1.html")).status, 200);
    assert.equal((await t.get("data.json")).status, 200);
    assert.equal((await t.get("%64ata.json")).status, 200, "a plain escape is decoded once");
    assert.equal((await t.get("%2564ata.json")).status, 404, "never decoded twice");
  } finally {
    await t.done();
  }
});

test("path safety: dot segments are refused as text and URL parsing cannot make them escape", async () => {
  for (const requested of ["..", "../a", "a/..", "a/../b", ".", "./a", "a/./b", "...", "a/.b"]) {
    assert.equal(splitRequestedPath(requested), null, requested);
  }
  assert.deepEqual(splitRequestedPath(""), ["index.html"]);
  assert.deepEqual(splitRequestedPath("compositions/g-1.html"), ["compositions", "g-1.html"]);
  assert.deepEqual(splitRequestedPath("a.b/c..d"), ["a.b", "c..d"]);
  const t = await setup();
  try {
    // The HTTP layer resolves plain dot segments before the route sees them; they stay inside.
    assert.equal((await t.get("compositions/../index.html")).status, 200);
    assert.equal((await t.get("compositions/%2e%2e/index.html")).status, 200);
    assert.equal((await t.get("../../..//etc/passwd")).status, 404);
  } finally {
    await t.done();
  }
});

test("path safety: directories are never listed", async () => {
  const t = await setup();
  try {
    for (const rest of ["compositions", "assets", "assets/media", "shared"]) {
      assert.equal((await t.get(rest)).status, 404, rest);
    }
  } finally {
    await t.done();
  }
});

test("path safety: a link inside the project that points elsewhere is refused", async () => {
  const t = await setup();
  try {
    const p = t.projectDir;
    fs.symlinkSync(path.join(t.outsideDir, "secret.txt"), path.join(p, "shared", "leak.txt"));
    fs.symlinkSync(t.outsideDir, path.join(p, "linked-dir"));
    fs.symlinkSync(path.join(t.root, "outside", "secret.txt"), path.join(p, "assets", "leak.mp4"));
    fs.symlinkSync("../../../..", path.join(p, "compositions", "up"));
    fs.symlinkSync(path.join(t.outsideDir, "secret.txt"), path.join(p, "compositions", "x.html"));
    fs.symlinkSync(path.join(t.outsideDir, "secret.txt"), path.join(p, "assets", "media", "x"));
    fs.symlinkSync(path.join(t.outsideDir, "secret.txt"), path.join(p, "style2.css"));
    const refused = [
      "shared/leak.txt",
      "linked-dir/secret.txt",
      "assets/leak.mp4",
      "compositions/up/outside/secret.txt",
      "compositions/x.html",
      "assets/media/x",
      "style2.css",
      "assets/media/evil.mp4",
    ];
    for (const rest of refused) {
      const answer = await t.get(rest);
      assert.equal(answer.status, 404, rest);
      assert.doesNotMatch(answer.body.toString(), /secret/);
    }
  } finally {
    await t.done();
  }
});

test("path safety: an index.html that is a link out is refused", async () => {
  const t = await setup();
  try {
    fs.rmSync(path.join(t.projectDir, "index.html"));
    fs.symlinkSync(path.join(t.outsideDir, "secret.txt"), path.join(t.projectDir, "index.html"));
    assert.equal((await t.get("")).status, 404);
    assert.equal((await t.get("index.html")).status, 404);
  } finally {
    await t.done();
  }
});

test("path safety: the assets/media exception reaches only the video folder and channel", async () => {
  const t = await setup();
  try {
    const media = path.join(t.projectDir, "assets", "media");
    // Inside the channel directory but under the video's own folder: allowed.
    assert.equal((await t.get("assets/media/aroll.mp4")).status, 200);
    // A link to a folder is not an entry the exception covers beyond the entry itself.
    fs.symlinkSync(path.join(t.videoDir, "aroll"), path.join(media, "dir"));
    assert.equal((await t.get("assets/media/dir/a.mp4")).status, 404);
    // A link from a media entry to a file next to the channel directory is refused.
    fs.writeFileSync(path.join(t.root, "beside.mp4"), "beside");
    fs.symlinkSync(path.join(t.root, "beside.mp4"), path.join(media, "beside.mp4"));
    assert.equal((await t.get("assets/media/beside.mp4")).status, 404);
    // A chain of links ending outside is judged by the real target.
    fs.symlinkSync(path.join(media, "evil.mp4"), path.join(media, "chain.mp4"));
    assert.equal((await t.get("assets/media/chain.mp4")).status, 404);
    // The exception does not apply to other folders of the project.
    fs.symlinkSync(
      path.join(t.videoDir, "aroll", "a.mp4"),
      path.join(t.projectDir, "assets", "other.mp4"),
    );
    assert.equal((await t.get("assets/other.mp4")).status, 404);
    fs.mkdirSync(path.join(t.projectDir, "assets", "media", "sub"));
    fs.symlinkSync(
      path.join(t.videoDir, "aroll", "a.mp4"),
      path.join(t.projectDir, "assets", "media", "sub", "deep.mp4"),
    );
    assert.equal((await t.get("assets/media/sub/deep.mp4")).status, 404);
  } finally {
    await t.done();
  }
});

test("a hard link or a copy in assets/media is an ordinary project file", async () => {
  const t = await setup();
  try {
    fs.linkSync(
      path.join(t.videoDir, "aroll", "a.mp4"),
      path.join(t.projectDir, "assets", "media", "hard.mp4"),
    );
    const answer = await t.get("assets/media/hard.mp4");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.length, 1000);
  } finally {
    await t.done();
  }
});

test("a preview copy replaces the original when it exists and the original otherwise", async () => {
  /** @type {string[]} */
  const asked = [];
  /** @type {{ copy: string | null }} */
  const state = { copy: null };
  const t = await setup({
    proxyFor(real) {
      asked.push(real);
      return state.copy;
    },
  });
  try {
    const copy = path.join(t.root, "copy.mp4");
    fs.writeFileSync(copy, Buffer.alloc(100, 1));
    const real = fs.realpathSync(path.join(t.videoDir, "aroll", "a.mp4"));

    assert.equal((await t.get("assets/media/aroll.mp4")).body.length, 1000);
    state.copy = copy;
    const served = await t.get("assets/media/aroll.mp4", { headers: { range: "bytes=0-9" } });
    assert.equal(served.status, 206);
    assert.equal(served.headers["content-range"], "bytes 0-9/100");
    assert.equal(served.headers["content-type"], "video/mp4");
    assert.equal(asked.at(-1), real, "it is asked with the real path");
    state.copy = path.join(t.root, "not-made-yet.mp4");
    assert.equal((await t.get("assets/media/aroll.mp4")).body.length, 1000);
    state.copy = t.root;
    assert.equal((await t.get("assets/media/aroll.mp4")).body.length, 1000, "a folder is no copy");
  } finally {
    await t.done();
  }
});

test("a failing proxyFor falls back to the original", async () => {
  const t = await setup({
    proxyFor() {
      throw new Error("broken");
    },
  });
  try {
    assert.equal((await t.get("assets/media/aroll.mp4")).body.length, 1000);
  } finally {
    await t.done();
  }
});

test("no cookie is read: a request with a session cookie behaves the same and sets none", async () => {
  const t = await setup();
  try {
    const answer = await t.get("data.json", { headers: { cookie: "vidai_session=abc" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["set-cookie"], undefined);
  } finally {
    await t.done();
  }
});

test("conditional requests are answered 304 with the preview headers", async () => {
  const t = await setup();
  try {
    const first = await t.get("style.css");
    const etag = first.headers.etag ?? "";
    assert.notEqual(etag, "");
    const again = await t.get("style.css", { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
    assertPreviewHeaders(again);
  } finally {
    await t.done();
  }
});

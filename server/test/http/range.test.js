import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parseRange, serveFile } from "../../src/http/range.js";
import { startServer } from "./support.js";

describe("parseRange", () => {
  test("start-end, open-ended and suffix ranges", () => {
    assert.deepEqual(parseRange("bytes=0-3", 10), { kind: "range", start: 0, end: 3 });
    assert.deepEqual(parseRange("bytes=4-", 10), { kind: "range", start: 4, end: 9 });
    assert.deepEqual(parseRange("bytes=-3", 10), { kind: "range", start: 7, end: 9 });
    assert.deepEqual(parseRange("bytes=-30", 10), { kind: "range", start: 0, end: 9 });
    assert.deepEqual(parseRange("bytes=8-99", 10), { kind: "range", start: 8, end: 9 });
    assert.deepEqual(parseRange(" Bytes = 1-2 ", 10), { kind: "range", start: 1, end: 2 });
  });

  test("unsatisfiable and malformed ranges", () => {
    for (const header of [
      "bytes=10-",
      "bytes=10-12",
      "bytes=5-2",
      "bytes=-0",
      "bytes=-",
      "bytes=",
      "bytes=a-b",
      "bytes=1-2-3",
      "bytes=99999999999999999999-",
    ]) {
      assert.deepEqual(parseRange(header, 10), { kind: "unsatisfiable" }, header);
    }
    assert.deepEqual(parseRange("bytes=0-", 0), { kind: "unsatisfiable" });
    assert.deepEqual(parseRange("bytes=-5", 0), { kind: "unsatisfiable" });
  });

  test("no header, another unit and several ranges give the whole file", () => {
    assert.deepEqual(parseRange(undefined, 10), { kind: "whole" });
    assert.deepEqual(parseRange("items=0-3", 10), { kind: "whole" });
    assert.deepEqual(parseRange("bytes=0-1,4-5", 10), { kind: "whole" });
  });
});

describe("serveFile through a route", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  /** @type {{ done: Promise<void> | null }} */
  const last = { done: null };
  const content = "0123456789";

  before(async () => {
    /** @type {Awaited<ReturnType<typeof startServer>> | null} */
    let self = null;
    t = await startServer({
      deps: {
        routes: [
          {
            method: "GET",
            path: "/f/*",
            auth: "none",
            handler: (req, res, ctx) => {
              const name = ctx.params.rest ?? "";
              const download = ctx.url.searchParams.get("download");
              last.done = serveFile(req, res, path.join(self?.dir ?? "", "media", name), {
                download: download === null ? undefined : download === "1" ? true : download,
                contentType: ctx.url.searchParams.get("type") ?? undefined,
              });
              return last.done;
            },
          },
        ],
      },
    });
    self = t;
    fs.mkdirSync(path.join(t.dir, "media"));
    fs.writeFileSync(path.join(t.dir, "media", "a.txt"), content);
    fs.writeFileSync(path.join(t.dir, "media", "empty.bin"), "");
    fs.writeFileSync(path.join(t.dir, "media", "big.mp4"), Buffer.alloc(3 * 1024 * 1024, 7));
    fs.mkdirSync(path.join(t.dir, "media", "folder"));
  });
  after(() => t.close());

  test("a whole file has length, type, Accept-Ranges and validators", async () => {
    const reply = await t.request("GET", "/f/a.txt");
    assert.equal(reply.status, 200);
    assert.equal(reply.text, content);
    assert.equal(reply.headers["content-length"], "10");
    assert.equal(reply.headers["accept-ranges"], "bytes");
    assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8");
    assert.ok(reply.headers.etag);
    assert.ok(reply.headers["last-modified"]);
  });

  test("start-end", async () => {
    const reply = await t.request("GET", "/f/a.txt", { headers: { Range: "bytes=2-5" } });
    assert.equal(reply.status, 206);
    assert.equal(reply.text, "2345");
    assert.equal(reply.headers["content-range"], "bytes 2-5/10");
    assert.equal(reply.headers["content-length"], "4");
  });

  test("open-ended and suffix", async () => {
    const open = await t.request("GET", "/f/a.txt", { headers: { Range: "bytes=7-" } });
    assert.equal(open.status, 206);
    assert.equal(open.text, "789");
    assert.equal(open.headers["content-range"], "bytes 7-9/10");
    const suffix = await t.request("GET", "/f/a.txt", { headers: { Range: "bytes=-4" } });
    assert.equal(suffix.text, "6789");
    assert.equal(suffix.headers["content-range"], "bytes 6-9/10");
  });

  test("an end past the file is clamped", async () => {
    const reply = await t.request("GET", "/f/a.txt", { headers: { Range: "bytes=8-100" } });
    assert.equal(reply.status, 206);
    assert.equal(reply.text, "89");
  });

  test("invalid ranges are 416 with the size", async () => {
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=x-y", "bytes=-0"]) {
      const reply = await t.request("GET", "/f/a.txt", { headers: { Range: range } });
      assert.equal(reply.status, 416, range);
      assert.equal(reply.headers["content-range"], "bytes */10");
      assert.equal(reply.body.length, 0);
    }
  });

  test("several ranges are answered with the whole file", async () => {
    const reply = await t.request("GET", "/f/a.txt", { headers: { Range: "bytes=0-1,5-6" } });
    assert.equal(reply.status, 200);
    assert.equal(reply.text, content);
  });

  test("HEAD sends the headers of the GET and no body, also with a range", async () => {
    const head = await t.request("HEAD", "/f/a.txt");
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "10");
    assert.equal(head.body.length, 0);
    const ranged = await t.request("HEAD", "/f/a.txt", { headers: { Range: "bytes=1-3" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-length"], "3");
    assert.equal(ranged.body.length, 0);
  });

  test("an empty file is 200 with no body and any range is 416", async () => {
    const whole = await t.request("GET", "/f/empty.bin");
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["content-length"], "0");
    const ranged = await t.request("GET", "/f/empty.bin", { headers: { Range: "bytes=0-0" } });
    assert.equal(ranged.status, 416);
  });

  test("a missing file or a folder is notFound", async () => {
    for (const name of ["nope.txt", "folder", "a.txt/x"]) {
      const reply = await t.request("GET", `/f/${name}`);
      assert.equal(reply.status, 404, name);
      assert.equal(reply.json.code, "notFound");
    }
  });

  test("If-None-Match gives 304", async () => {
    const first = await t.request("GET", "/f/a.txt");
    const again = await t.request("GET", "/f/a.txt", {
      headers: { "If-None-Match": String(first.headers.etag) },
    });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
  });

  test("download names the file safely, also for strange names", async () => {
    const own = await t.request("GET", "/f/a.txt?download=1");
    assert.equal(
      own.headers["content-disposition"],
      `attachment; filename="a.txt"; filename*=UTF-8''a.txt`,
    );
    const odd = await t.request(
      "GET",
      `/f/a.txt?download=${encodeURIComponent('Café "x"\r\n.mp4')}`,
    );
    const disposition = String(odd.headers["content-disposition"]);
    assert.ok(!/[\r\n]/.test(disposition));
    assert.equal(
      disposition,
      `attachment; filename="Caf_ _x___.mp4"; filename*=UTF-8''Caf%C3%A9%20%22x%22%0D%0A.mp4`,
    );
  });

  test("a given content type wins over the extension", async () => {
    const reply = await t.request("GET", "/f/a.txt?type=image/png");
    assert.equal(reply.headers["content-type"], "image/png");
  });

  test("the default security headers stay on file answers", async () => {
    const reply = await t.request("GET", "/f/a.txt");
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
  });

  test("a client that aborts mid-stream ends the answer and releases the file", async () => {
    await new Promise((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port: t.port, path: "/f/big.mp4", ca: t.tls.cert, agent: false },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve(undefined);
          });
        },
      );
      req.on("error", () => {});
      req.on("error", reject);
      req.end();
    });
    const done = last.done;
    assert.ok(done);
    const outcome = await Promise.race([
      done.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    assert.equal(outcome, "done");
  });
});

// The HTTP side of storage (SPEC section 14) through a real server: upload bytes, upload state and
// the files of a video folder. Every route is signed-in only and reaches the caller's own things.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { startServer } from "../http/support.js";
import { createWorld } from "./support.js";

/** @typedef {Awaited<ReturnType<typeof startServer>>} Server */

describe("storage routes", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {Server} */
  let server;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;
  /** @type {string} */
  let videoDir;
  /** @type {string} */
  let videoId;
  /** @type {string} */
  let outside;
  /** @type {any} */
  let channel;

  beforeEach(async () => {
    world = createWorld({ storageRoots: ["share"], uploadOptions: { idleMs: 2000 } });
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    outside = world.mkdir("outside");
    const dir = world.mkdir("share/channel");
    channel = await world.makeChannel(alice, "Chan", { location: { kind: "link", dir } });
    videoId = (await world.mod.api.channels.createVideo(alice.id, channel.id, "Video 1")).id;
    await world.mod.api.channels.createVideo(alice.id, channel.id, "Video 2");
    videoDir = path.join(dir, "Video 1");
    server = await startServer({
      deps: {
        routes: world.mod.routes,
        authenticate: (token) => {
          const user = token === "alice" ? alice : token === "bob" ? bob : null;
          return user
            ? { id: `s-${token}`, user: { id: user.id, email: user.email, role: "user" } }
            : null;
        },
      },
    });
  });
  afterEach(async () => {
    await server.close();
    world.cleanup();
  });

  /** @param {string} user @param {Record<string, string>} [extra] */
  const as = (user, extra = {}) => ({ Cookie: `vidai_session=${user}`, ...extra });
  /** @param {string} user @param {string} id @param {number | string} offset @param {string | Buffer} body */
  const put = (user, id, offset, body) =>
    server.request("PUT", `/api/upload/${id}?offset=${offset}`, {
      changing: true,
      headers: as(user, { "Content-Type": "application/octet-stream" }),
      body,
    });
  /** @param {string} user @param {string} id */
  const state = (user, id) => server.request("GET", `/api/upload/${id}`, { headers: as(user) });
  /** @param {Partial<{ videoId: string, name: string, size: number }>} [input] */
  const ticket = (input = {}, user = alice) =>
    world.mod.api.uploads.create(user, {
      videoId,
      folder: "video",
      name: "clip.mp4",
      size: 10,
      ...input,
    });
  /** @param {string} video @param {string} file @param {string} [user] @param {Record<string,string>} [headers] */
  const file = (video, file, user = "alice", headers = {}) =>
    server.request(
      "GET",
      `/api/file?video=${encodeURIComponent(video)}&path=${encodeURIComponent(file)}`,
      { headers: as(user, headers) },
    );

  describe("upload", () => {
    test("every route needs a session", async () => {
      const made = await ticket();
      assert.equal((await server.request("GET", `/api/upload/${made.id}`)).status, 401);
      assert.equal(
        (
          await server.request("PUT", `/api/upload/${made.id}?offset=0`, {
            changing: true,
            body: "x",
          })
        ).status,
        401,
      );
      assert.equal((await server.request("GET", "/api/file?video=a&path=b")).status, 401);
      assert.equal((await put("nobody", made.id, 0, "x")).status, 401);
      assert.deepEqual(fs.readdirSync(videoDir), []);
    });

    test("pieces in order make the file, and GET says how far it is", async () => {
      const made = await ticket();
      const first = await put("alice", made.id, 0, "01234");
      assert.equal(first.status, 200);
      assert.deepEqual(first.json, { received: 5, done: false });
      assert.deepEqual((await state("alice", made.id)).json, {
        received: 5,
        size: 10,
        done: false,
      });
      const second = await put("alice", made.id, 5, "56789");
      assert.deepEqual(second.json, { received: 10, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "0123456789");
    });

    test("a wrong offset is 409 with the right offset in a header, and changes nothing", async () => {
      const made = await ticket();
      await put("alice", made.id, 0, "01234");
      const wrong = await put("alice", made.id, 2, "XXXXX");
      assert.equal(wrong.status, 409);
      assert.equal(wrong.headers["x-upload-received"], "5");
      assert.equal(wrong.json.code, "conflict");
      assert.deepEqual((await state("alice", made.id)).json.received, 5);
    });

    test("an offset that is not a number is 400", async () => {
      const made = await ticket();
      for (const offset of ["", "abc", "-1", "1.5", "99999999999999999999", "0x10"]) {
        assert.equal((await put("alice", made.id, offset, "x")).status, 400, offset);
      }
      assert.deepEqual(fs.readdirSync(videoDir), []);
    });

    test("bytes beyond the declared size are 400 and the upload can go on", async () => {
      const made = await ticket();
      await put("alice", made.id, 0, "01234");
      assert.equal((await put("alice", made.id, 5, "56789XYZ")).status, 400);
      assert.equal((await state("alice", made.id)).json.received, 5);
      assert.equal((await put("alice", made.id, 5, "56789")).json.done, true);
    });

    test("another user's upload is 404 for every request", async () => {
      const made = await ticket({ size: 10 });
      await put("alice", made.id, 0, "01234");
      const before = fs.readdirSync(videoDir).sort();
      assert.equal((await state("bob", made.id)).status, 404);
      assert.equal((await put("bob", made.id, 5, "56789")).status, 404);
      const unknown = await state("bob", "0".repeat(32));
      assert.equal((await state("bob", made.id)).text, unknown.text);
      assert.deepEqual(fs.readdirSync(videoDir).sort(), before);
    });

    test("an id that is not 32 hex digits matches no route", async () => {
      for (const id of ["abc", "../x", "Z".repeat(32), "a".repeat(33)]) {
        const reply = await server.request("PUT", `/api/upload/${id}?offset=0`, {
          changing: true,
          headers: as("alice"),
          body: "x",
        });
        assert.ok(reply.status === 404 || reply.status === 400, `${id}: ${reply.status}`);
      }
    });

    test("a body over 32 MB is refused and nothing is written", async () => {
      const made = await ticket({ size: 100 * 1024 * 1024 });
      const body = Buffer.alloc(32 * 1024 * 1024 + 1, 1);
      const reply = await put("alice", made.id, 0, body);
      assert.equal(reply.status, 413);
      assert.equal(reply.json.code, "tooLarge");
      assert.deepEqual(fs.readdirSync(videoDir), []);
      assert.equal((await state("alice", made.id)).json.received, 0);
    });

    test("a body of exactly 32 MB is accepted", async () => {
      const made = await ticket({ size: 33 * 1024 * 1024 });
      const body = Buffer.alloc(32 * 1024 * 1024, 2);
      const reply = await put("alice", made.id, 0, body);
      assert.equal(reply.status, 200);
      assert.equal(reply.json.received, body.length);
      const part = fs.readdirSync(videoDir).find((name) => name.endsWith(".part")) ?? "";
      assert.equal(fs.statSync(path.join(videoDir, part)).size, body.length);
    });
  });

  describe("upload with a smaller limit and no declared length", () => {
    test("a chunked body over the limit is 413 and the part file is cut back", async () => {
      await server.close();
      world.cleanup();
      world = createWorld({ storageRoots: ["share"], uploadOptions: { maxChunkBytes: 1000 } });
      alice = world.makeUser("alice@example.com");
      const dir = world.mkdir("share/channel");
      channel = await world.makeChannel(alice, "Chan", { location: { kind: "link", dir } });
      videoId = (await world.mod.api.channels.createVideo(alice.id, channel.id, "Video 1")).id;
      videoDir = path.join(dir, "Video 1");
      server = await startServer({
        deps: {
          routes: world.mod.routes,
          authenticate: () => ({
            id: "s",
            user: { id: alice.id, email: alice.email, role: "user" },
          }),
        },
      });
      const made = await ticket({ size: 100_000 });
      const reply = await new Promise(
        (/** @type {(r: { status: number }) => void} */ resolve, reject) => {
          const req = https.request(
            {
              host: "127.0.0.1",
              port: server.port,
              method: "PUT",
              path: `/api/upload/${made.id}?offset=0`,
              ca: server.tls.cert,
              agent: false,
              headers: {
                "X-VidAI": "1",
                Origin: server.origin,
                Cookie: "vidai_session=x",
                "Transfer-Encoding": "chunked",
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on("error", reject);
          for (let index = 0; index < 40; index++) req.write(Buffer.alloc(100, 3));
          req.end();
        },
      );
      assert.equal(reply.status, 413);
      const part = fs.readdirSync(videoDir).find((name) => name.endsWith(".part"));
      assert.equal(part === undefined ? 0 : fs.statSync(path.join(videoDir, part)).size, 0);
    });
  });

  describe("files of a video", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(videoDir, "clip.mp4"), "0123456789");
      fs.mkdirSync(path.join(videoDir, "output"));
      fs.writeFileSync(path.join(videoDir, "output", "notes.txt"), "hello");
      fs.writeFileSync(path.join(videoDir, "page.html"), "<script>alert(1)</script>");
      fs.writeFileSync(path.join(videoDir, "image.svg"), "<svg onload='alert(1)'/>");
      fs.writeFileSync(path.join(path.dirname(videoDir), "Video 2", "other.txt"), "other video");
      fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
    });

    test("serves a file of the video, with ranges", async () => {
      const whole = await file(videoId, "clip.mp4");
      assert.equal(whole.status, 200);
      assert.equal(whole.text, "0123456789");
      assert.equal(whole.headers["content-type"], "video/mp4");
      assert.equal(whole.headers["cache-control"], "private, no-cache");
      assert.equal(whole.headers["content-security-policy"], "sandbox");
      const part = await file(videoId, "clip.mp4", "alice", { Range: "bytes=2-4" });
      assert.equal(part.status, 206);
      assert.equal(part.text, "234");
      assert.equal((await file(videoId, "output/notes.txt")).text, "hello");
      // A backslash is not a separator here, and not a legal part of a name either.
      assert.equal((await file(videoId, "output\\notes.txt")).status, 400);
    });

    test("pages and scripts are never shown in place", async () => {
      for (const name of ["page.html", "image.svg"]) {
        const reply = await file(videoId, name);
        assert.equal(reply.status, 200);
        assert.equal(reply.headers["content-type"], "application/octet-stream", name);
        assert.match(String(reply.headers["content-disposition"]), /^attachment/);
        assert.equal(reply.headers["content-security-policy"], "sandbox");
      }
      const text = await file(videoId, "output/notes.txt");
      assert.ok(String(text.headers["content-type"]).startsWith("text/plain"));
    });

    test("download=1 forces a download", async () => {
      const reply = await server.request(
        "GET",
        `/api/file?video=${encodeURIComponent(videoId)}&path=clip.mp4&download=1`,
        { headers: as("alice") },
      );
      assert.match(String(reply.headers["content-disposition"]), /^attachment/);
    });

    test("a path that leaves the video folder is 403", async () => {
      for (const target of [
        "../Video 2/other.txt",
        "..",
        "output/../../Video 2/other.txt",
        "output/../clip.mp4",
        "/etc/passwd",
        path.join(outside, "secret.txt"),
        "\\windows\\system32",
        ".",
        "output/..",
      ]) {
        const reply = await file(videoId, target);
        assert.equal(reply.status, 403, `${target} gave ${reply.status}`);
        assert.ok(!reply.text.includes("top secret") && !reply.text.includes("other video"));
      }
    });

    test("a NUL byte or no path is 400", async () => {
      assert.equal((await file(videoId, "clip.mp4\0.txt")).status, 400);
      assert.equal((await file(videoId, "")).status, 400);
      const none = await server.request("GET", `/api/file?video=${encodeURIComponent(videoId)}`, {
        headers: as("alice"),
      });
      assert.equal(none.status, 400);
    });

    test("a link to a file outside is 403, to a file of another video too", async () => {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(videoDir, "leak.txt"));
      fs.symlinkSync(
        path.join(path.dirname(videoDir), "Video 2", "other.txt"),
        path.join(videoDir, "sibling.txt"),
      );
      for (const name of ["leak.txt", "sibling.txt"]) {
        const reply = await file(videoId, name);
        assert.equal(reply.status, 403, name);
        assert.ok(!reply.text.includes("top secret") && !reply.text.includes("other video"));
      }
    });

    test("a link to a folder outside is 403, also for files inside it", async () => {
      fs.symlinkSync(outside, path.join(videoDir, "folder-link"));
      assert.equal((await file(videoId, "folder-link/secret.txt")).status, 403);
      assert.equal((await file(videoId, "folder-link")).status, 403);
    });

    test("a link to a file inside the same video is fine", async () => {
      fs.symlinkSync(path.join(videoDir, "clip.mp4"), path.join(videoDir, "alias.mp4"));
      assert.equal((await file(videoId, "alias.mp4")).text, "0123456789");
    });

    test("another user's video is 404, the same as a video that does not exist", async () => {
      const foreign = await file(videoId, "clip.mp4", "bob");
      assert.equal(foreign.status, 404);
      const missing = await file(`${channel.id}/Nope`, "clip.mp4", "bob");
      assert.equal(missing.status, 404);
      assert.equal(foreign.text, missing.text);
      assert.ok(!foreign.text.includes("0123456789"));
      assert.equal((await file("nonsense", "clip.mp4")).status, 404);
    });

    test("a file that does not exist is 404", async () => {
      assert.equal((await file(videoId, "missing.mp4")).status, 404);
    });

    test("a folder is not a file", async () => {
      assert.ok([400, 403, 404].includes((await file(videoId, "output")).status));
    });
  });
});

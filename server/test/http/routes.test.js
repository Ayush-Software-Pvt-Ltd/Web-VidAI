import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { forbidden } from "../../src/errors.js";
import { startServer } from "./support.js";

describe("extra routes", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  /** @type {import("../../src/http/types.js").RouteContext[]} */
  const seen = [];

  before(async () => {
    t = await startServer({
      files: { "index.html": "<p>ui</p>" },
      deps: {
        routes: [
          {
            method: "GET",
            path: "/api/open",
            auth: "none",
            handler: (_req, res, ctx) => {
              seen.push(ctx);
              res.setHeader("Content-Type", "text/plain");
              res.end(ctx.session ? ctx.session.user.email : "anonymous");
            },
          },
          {
            method: "GET",
            path: "/api/private",
            auth: "session",
            handler: (_req, res, ctx) => {
              seen.push(ctx);
              res.end(ctx.session?.user.email ?? "?");
            },
          },
          {
            method: "PUT",
            path: /^\/api\/upload\/(?<id>[A-Za-z0-9]+)$/,
            auth: "session",
            handler: (_req, res, ctx) => {
              seen.push(ctx);
              res.end(`put ${ctx.params.id}`);
            },
          },
          {
            method: "GET",
            path: /^\/api\/upload\/(?<id>[A-Za-z0-9]+)$/,
            auth: "session",
            handler: (_req, res, ctx) => {
              res.end(`get ${ctx.params.id}`);
            },
          },
          {
            method: "GET",
            path: "/p/*",
            auth: "none",
            handler: (_req, res, ctx) => {
              // The preview route replaces the CSP and drops the frame ban.
              res.setHeader("Content-Security-Policy", "default-src 'self'; sandbox");
              res.removeHeader("X-Frame-Options");
              res.end(`rest=${ctx.params.rest}`);
            },
          },
          {
            method: "GET",
            path: "/api/throws",
            auth: "none",
            handler: () => {
              throw forbidden("Not yours.");
            },
          },
          {
            method: "GET",
            path: "/api/throws-late",
            auth: "none",
            handler: () => Promise.reject(new Error("secret detail")),
          },
          {
            method: "GET",
            path: "/api/breaks-midway",
            auth: "none",
            handler: (_req, res) => {
              res.write("partial");
              throw new Error("after the answer started");
            },
          },
          {
            method: "POST",
            path: "/api/post-only",
            auth: "none",
            handler: (_req, res) => {
              res.end("posted");
            },
          },
        ],
      },
    });
  });
  after(() => t.close());

  test("a route with auth none runs with and without a session", async () => {
    assert.equal((await t.request("GET", "/api/open")).text, "anonymous");
    const signedIn = await t.request("GET", "/api/open", {
      headers: { Cookie: "vidai_session=user-token" },
    });
    assert.equal(signedIn.text, "user@example.com");
  });

  test("a route with auth session answers 401 JSON without a session and never runs", async () => {
    seen.length = 0;
    const none = await t.request("GET", "/api/private");
    assert.equal(none.status, 401);
    assert.deepEqual(none.json, { code: "unauthenticated", message: "Please sign in." });
    const wrong = await t.request("GET", "/api/private", {
      headers: { Cookie: "vidai_session=unknown" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(seen.length, 0);
    const ok = await t.request("GET", "/api/private", {
      headers: { Cookie: "vidai_session=admin-token" },
    });
    assert.equal(ok.text, "admin@example.com");
  });

  test("RegExp paths give named groups and the URL, and method decides the handler", async () => {
    seen.length = 0;
    const put = await t.request("PUT", "/api/upload/abc123?x=1", {
      changing: true,
      headers: { Cookie: "vidai_session=user-token" },
    });
    assert.equal(put.text, "put abc123");
    assert.equal(seen[0]?.url.searchParams.get("x"), "1");
    assert.equal(seen[0]?.address, "127.0.0.1");
    const get = await t.request("GET", "/api/upload/abc123", {
      headers: { Cookie: "vidai_session=user-token" },
    });
    assert.equal(get.text, "get abc123");
    assert.equal((await t.request("GET", "/api/upload/bad%20id")).status, 404);
  });

  test("a changing route needs X-VidAI before authentication", async () => {
    const reply = await t.request("PUT", "/api/upload/abc123");
    assert.equal(reply.status, 403);
  });

  test("prefix paths give the decoded rest", async () => {
    const reply = await t.request("GET", "/p/tok/dir/a%20b.html");
    assert.equal(reply.text, "rest=tok/dir/a b.html");
    assert.equal((await t.request("GET", "/p/")).text, "rest=");
    assert.equal((await t.request("GET", "/p/%E0%A4%A")).status, 404);
  });

  test("a handler may replace the default security headers", async () => {
    const preview = await t.request("GET", "/p/x");
    assert.equal(preview.headers["content-security-policy"], "default-src 'self'; sandbox");
    assert.equal(preview.headers["x-frame-options"], undefined);
    assert.equal(preview.headers["x-content-type-options"], "nosniff");
    const other = await t.request("GET", "/api/open");
    assert.match(String(other.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(other.headers["x-frame-options"], "DENY");
  });

  test("a wrong method on a known path is 405 with Allow, HEAD follows GET", async () => {
    const reply = await t.request("POST", "/api/open", { changing: true });
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.allow, "GET, HEAD");
    const upload = await t.request("DELETE", "/api/upload/abc", { changing: true });
    assert.equal(upload.status, 405);
    assert.deepEqual(String(upload.headers.allow).split(", ").sort(), ["GET", "HEAD", "PUT"]);
    const head = await t.request("HEAD", "/api/open");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal((await t.request("GET", "/api/post-only")).status, 405);
  });

  test("a thrown AppError is answered, anything else is a generic internal error", async () => {
    const app = await t.request("GET", "/api/throws");
    assert.equal(app.status, 403);
    assert.deepEqual(app.json, { code: "forbidden", message: "Not yours." });
    t.logLines.length = 0;
    const other = await t.request("GET", "/api/throws-late");
    assert.equal(other.status, 400);
    assert.equal(other.json.code, "internal");
    assert.ok(!other.text.includes("secret detail"));
    assert.ok(t.logLines.some((line) => line.includes("secret detail")));
  });

  test("a handler failing after it started answering cuts the connection", async () => {
    await assert.rejects(t.request("GET", "/api/breaks-midway"));
  });

  test("built-in routes cannot be shadowed by later routes", async () => {
    // The first matching route wins and the built-ins come first.
    const own = await startServer({
      deps: {
        rpc: () => Promise.resolve("real"),
        routes: [
          {
            method: "POST",
            path: "/api/rpc/x",
            auth: "none",
            handler: (_req, res) => {
              res.end("hijacked");
            },
          },
        ],
      },
    });
    try {
      assert.equal((await own.rpc("x")).text, '"real"');
    } finally {
      await own.close();
    }
  });
});

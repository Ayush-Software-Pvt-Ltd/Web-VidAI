import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONTENT_SECURITY_POLICY } from "../../src/http/headers.js";
import { openStream, rawRequest, startServer } from "./support.js";

describe("security headers (docs/SPEC.md section 4)", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  before(async () => {
    t = await startServer({
      files: { "index.html": "<p>ui</p>", "assets/a.js": "1" },
      deps: {
        rpc: (name) =>
          name === "boom" ? Promise.reject(new Error("x")) : Promise.resolve({ ok: true }),
      },
    });
  });
  after(() => t.close());

  /** @param {import("node:http").IncomingHttpHeaders} headers */
  function assertSecure(headers) {
    assert.equal(headers["strict-transport-security"], "max-age=31536000");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "no-referrer");
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["content-security-policy"], CONTENT_SECURITY_POLICY);
  }

  test("every kind of answer carries them", async () => {
    const answers = [
      await t.request("GET", "/"),
      await t.request("GET", "/assets/a.js"),
      await t.request("GET", "/assets/missing.js"),
      await t.request("HEAD", "/"),
      await t.request("GET", "/api/nothing"),
      await t.request("GET", "/api/rpc/x"),
      await t.request("POST", "/api/rpc/x"),
      await t.request("POST", "/api/rpc/x", { changing: true }),
      await t.rpc("boom"),
      await t.request("GET", "/api/events"),
      await t.request("DELETE", "/"),
    ];
    for (const reply of answers) assertSecure(reply.headers);
    // Also an answer the HTTP parser itself refuses.
    const raw = await rawRequest(
      t,
      "GET http://x/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    assert.match(raw, /strict-transport-security: max-age=31536000/i);
  });

  test("an event stream carries them too", async () => {
    const s = await openStream(t, "user-token");
    try {
      assertSecure(s.res.headers);
    } finally {
      s.destroy();
    }
  });

  test("the policy allows what the UI needs and nothing else", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split("; ").map((part) => {
        const [name = "", ...values] = part.split(" ");
        return [name, values];
      }),
    );
    assert.deepEqual(directives["script-src"], ["'self'"]);
    assert.deepEqual(directives["style-src"], ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(directives["font-src"], ["'self'"]);
    assert.deepEqual(directives["img-src"], ["'self'", "data:", "blob:"]);
    assert.deepEqual(directives["media-src"], ["'self'", "blob:"]);
    assert.deepEqual(directives["connect-src"], ["'self'"]);
    assert.deepEqual(directives["frame-src"], ["'self'"]);
    assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
    assert.deepEqual(directives["base-uri"], ["'self'"]);
    assert.deepEqual(directives["form-action"], ["'self'"]);
    assert.deepEqual(directives["object-src"], ["'none'"]);
    assert.deepEqual(directives["default-src"], ["'none'"]);
  });
});

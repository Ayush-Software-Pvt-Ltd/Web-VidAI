import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AppError, invalidInput, notFound } from "../../src/errors.js";
import { startServer } from "./support.js";

describe("POST /api/rpc/<name>", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  /** @type {{ name: string, input: unknown, ctx: import("../../src/http/types.js").RpcContext }[]} */
  const calls = [];
  /** @type {(name: string, input: unknown) => unknown} */
  let behaviour = () => null;

  before(async () => {
    t = await startServer({
      options: { maxJsonBytes: 1024, bodyIdleMs: 150 },
      deps: {
        rpc: (name, input, ctx) => {
          calls.push({ name, input, ctx });
          return Promise.resolve(behaviour(name, input));
        },
      },
    });
  });
  after(() => t.close());

  test("answers 200 with the JSON result", async () => {
    behaviour = (name, input) => ({ echoed: input, name });
    const reply = await t.rpc("getThing", { a: 1 });
    assert.equal(reply.status, 200);
    assert.match(String(reply.headers["content-type"]), /^application\/json/);
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.deepEqual(reply.json, { echoed: { a: 1 }, name: "getThing" });
  });

  test("an undefined result is null and an empty body is a null input", async () => {
    behaviour = () => undefined;
    calls.length = 0;
    const reply = await t.rpc("ping");
    assert.equal(reply.status, 200);
    assert.equal(reply.text, "null");
    assert.equal(calls[0]?.input, null);
  });

  test("passes the session, address and user agent to the function", async () => {
    behaviour = () => null;
    calls.length = 0;
    await t.request("POST", "/api/rpc/who", {
      changing: true,
      headers: { Cookie: "a=b; vidai_session=user-token", "User-Agent": "Tests/1" },
    });
    const ctx = calls[0]?.ctx;
    assert.equal(ctx?.session?.user.email, "user@example.com");
    assert.equal(ctx?.address, "127.0.0.1");
    assert.equal(ctx?.userAgent, "Tests/1");
    const call = t.authCalls.at(-1);
    assert.deepEqual(call, { token: "user-token", address: "127.0.0.1", userAgent: "Tests/1" });
  });

  test("without a cookie or with an unknown token the session is null", async () => {
    calls.length = 0;
    t.authCalls.length = 0;
    await t.request("POST", "/api/rpc/a", { changing: true });
    await t.request("POST", "/api/rpc/b", {
      changing: true,
      headers: { Cookie: "vidai_session=nobody" },
    });
    assert.equal(calls[0]?.ctx.session, null);
    assert.equal(calls[1]?.ctx.session, null);
    // No cookie: authenticate is not even asked.
    assert.deepEqual(
      t.authCalls.map((c) => c.token),
      ["nobody"],
    );
  });

  for (const [code, status] of /** @type {const} */ ([
    ["invalidInput", 400],
    ["notReady", 400],
    ["io", 400],
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["notFound", 404],
    ["conflict", 409],
    ["tooLarge", 413],
    ["rateLimited", 429],
  ])) {
    test(`an AppError ${code} is answered ${status} with code and message`, async () => {
      behaviour = () => {
        throw new AppError(code, "Nothing here.");
      };
      const reply = await t.rpc("fails");
      assert.equal(reply.status, status);
      assert.deepEqual(reply.json, { code, message: "Nothing here." });
    });
  }

  test("an asynchronous AppError is mapped too", async () => {
    behaviour = () => Promise.reject(notFound("Gone."));
    const reply = await t.rpc("x");
    assert.equal(reply.status, 404);
  });

  test("an unexpected error becomes a generic internal error and only the log learns more", async () => {
    behaviour = () => {
      throw new Error("ENOENT: /secret/path/vidai.db at Object.<anonymous> (/srv/app.js:1:1)");
    };
    t.logLines.length = 0;
    const reply = await t.rpc("boom");
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.json, {
      code: "internal",
      message: "Something went wrong on the server.",
    });
    assert.ok(!reply.text.includes("/secret"));
    assert.ok(!reply.text.includes("at Object"));
    assert.ok(t.logLines.some((line) => line.includes("ERROR") && line.includes("/secret/path")));
  });

  test("a thrown non-Error value is internal as well", async () => {
    behaviour = () => {
      throw "plain string";
    };
    const reply = await t.rpc("boom2");
    assert.equal(reply.json.code, "internal");
    assert.ok(!reply.text.includes("plain string"));
  });

  test("a body that is not JSON is invalidInput", async () => {
    const reply = await t.request("POST", "/api/rpc/x", { changing: true, body: "{nope" });
    assert.equal(reply.status, 400);
    assert.equal(reply.json.code, "invalidInput");
  });

  test("a body over the limit is tooLarge", async () => {
    const big = JSON.stringify({ text: "x".repeat(2048) });
    const reply = await t.request("POST", "/api/rpc/x", { changing: true, body: big });
    assert.equal(reply.status, 413);
    assert.equal(reply.json.code, "tooLarge");
  });

  test("a body that is exactly at the limit is accepted", async () => {
    behaviour = () => "ok";
    const body = JSON.stringify("x".repeat(1024 - 2));
    assert.equal(Buffer.byteLength(body), 1024);
    const reply = await t.request("POST", "/api/rpc/x", { changing: true, body });
    assert.equal(reply.status, 200);
  });

  test("a client that stops sending its body gets an answer instead of a hung server", async () => {
    const { default: https } = await import("node:https");
    const reply = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port: t.port,
          method: "POST",
          path: "/api/rpc/x",
          ca: t.tls.cert,
          agent: false,
          headers: { "X-VidAI": "1", "Content-Length": "100" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.write("{");
    });
    assert.equal(reply, 400);
  });

  test("the name must be letters and digits starting with a letter", async () => {
    for (const name of ["", "1abc", "a-b", "a.b", "a%2fb", "a/b"]) {
      const reply = await t.request("POST", `/api/rpc/${name}`, { changing: true });
      assert.equal(reply.status, 404, name);
      assert.equal(reply.json.code, "notFound");
    }
  });

  test("another method on an RPC path is 405", async () => {
    const reply = await t.request("GET", "/api/rpc/getThing");
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.allow, "POST");
  });

  test("an unknown /api path is a 404 notFound", async () => {
    for (const path of ["/api", "/api/", "/api/nothing", "/api/rpc"]) {
      const reply = await t.request("GET", path);
      assert.equal(reply.status, 404, path);
      assert.equal(reply.json.code, "notFound");
    }
  });
});

describe("changing requests (docs/SPEC.md section 4)", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  before(async () => {
    t = await startServer({ deps: { rpc: () => Promise.resolve("done") } });
  });
  after(() => t.close());

  test("without X-VidAI the request is forbidden", async () => {
    const reply = await t.request("POST", "/api/rpc/x");
    assert.equal(reply.status, 403);
    assert.equal(reply.json.code, "forbidden");
  });

  test("X-VidAI must be exactly 1", async () => {
    const reply = await t.request("POST", "/api/rpc/x", { headers: { "X-VidAI": "true" } });
    assert.equal(reply.status, 403);
  });

  test("a foreign Origin is forbidden even with the header", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1", "null", t.origin + ".evil"]) {
      const reply = await t.request("POST", "/api/rpc/x", {
        headers: { "X-VidAI": "1", Origin: origin },
      });
      assert.equal(reply.status, 403, origin);
    }
  });

  test("the request's own origin passes, and so does a missing Origin", async () => {
    const same = await t.request("POST", "/api/rpc/x", {
      headers: { "X-VidAI": "1", Origin: t.origin },
    });
    assert.equal(same.status, 200);
    const none = await t.request("POST", "/api/rpc/x", { headers: { "X-VidAI": "1" } });
    assert.equal(none.status, 200);
  });

  test("PUT and DELETE routes are checked as well", async () => {
    const own = await startServer({
      deps: {
        routes: ["PUT", "DELETE"].map((method) => ({
          method: /** @type {"PUT" | "DELETE"} */ (method),
          path: "/api/thing",
          auth: /** @type {const} */ ("none"),
          handler: (_req, res) => {
            res.end("ok");
          },
        })),
      },
    });
    try {
      for (const method of ["PUT", "DELETE"]) {
        assert.equal((await own.request(method, "/api/thing")).status, 403, method);
        assert.equal((await own.request(method, "/api/thing", { changing: true })).status, 200);
      }
    } finally {
      await own.close();
    }
  });
});

describe("session cookie", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  before(async () => {
    t = await startServer({
      deps: {
        rpc: (name, _input, ctx) => {
          if (name === "login") ctx.setSessionCookie("fresh token/with+chars");
          if (name === "logout") ctx.setSessionCookie(null);
          if (name === "failAfterLogin") {
            ctx.setSessionCookie("x");
            throw invalidInput("No.");
          }
          return Promise.resolve(null);
        },
      },
    });
  });
  after(() => t.close());

  test("setSessionCookie(token) writes the cookie with every attribute", async () => {
    const reply = await t.rpc("login");
    const cookie = [reply.headers["set-cookie"]].flat().join();
    assert.ok(cookie.startsWith("vidai_session=fresh%20token%2Fwith%2Bchars;"), cookie);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) {
      assert.ok(cookie.includes(attribute), `${attribute} in ${cookie}`);
    }
  });

  test("setSessionCookie(null) clears it", async () => {
    const reply = await t.rpc("logout");
    const cookie = [reply.headers["set-cookie"]].flat().join();
    assert.ok(cookie.startsWith("vidai_session=;"), cookie);
    assert.ok(cookie.includes("Max-Age=0"));
    assert.ok(cookie.includes("HttpOnly") && cookie.includes("Secure"));
  });

  test("no cookie is written when the function does not ask for one", async () => {
    const reply = await t.rpc("other");
    assert.equal(reply.headers["set-cookie"], undefined);
  });

  test("the cookie token is decoded before authenticate sees it", async () => {
    t.authCalls.length = 0;
    await t.request("POST", "/api/rpc/x", {
      changing: true,
      headers: { Cookie: "vidai_session=fresh%20token" },
    });
    assert.equal(t.authCalls[0]?.token, "fresh token");
  });
});

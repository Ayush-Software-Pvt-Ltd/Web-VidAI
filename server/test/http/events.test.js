import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startServer, openStream } from "./support.js";

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GET /api/events", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let t;
  before(async () => {
    t = await startServer({ options: { pingMs: 40 } });
  });
  after(() => t.close());

  test("needs a session", async () => {
    const none = await t.request("GET", "/api/events");
    assert.equal(none.status, 401);
    assert.equal(none.json.code, "unauthenticated");
    const bad = await t.request("GET", "/api/events", { headers: { Cookie: "vidai_session=x" } });
    assert.equal(bad.status, 401);
  });

  test("sends the headers, hello first, then the user's events", async () => {
    const s = await openStream(t, "user-token");
    try {
      assert.equal(s.res.statusCode, 200);
      assert.match(String(s.res.headers["content-type"]), /^text\/event-stream/);
      assert.equal(s.res.headers["cache-control"], "no-store");
      assert.equal(s.res.headers["x-content-type-options"], "nosniff");
      await s.until((text) => text.includes("hello"));
      t.events.emit({
        event: "library-changed",
        payload: { n: 1 },
        userId: "u-user",
        admins: false,
      });
      await s.until((text) => text.includes("library-changed"));
      assert.equal(
        s.text().split("\n\n")[0],
        'data: {"event":"hello","payload":{"instanceId":"instance-1"}}',
      );
      assert.deepEqual(
        s.messages().map((m) => m.event),
        ["hello", "library-changed"],
      );
      assert.deepEqual(s.messages()[1].payload, { n: 1 });
    } finally {
      s.destroy();
    }
  });

  test("events are routed by user and the admin flag", async () => {
    const admin = await openStream(t, "admin-token");
    const user = await openStream(t, "user-token");
    const other = await openStream(t, "other-token");
    try {
      await Promise.all([admin, user, other].map((s) => s.until((x) => x.includes("hello"))));
      t.events.emit({ event: "a-private", payload: 1, userId: "u-user", admins: false });
      t.events.emit({ event: "b-admins-too", payload: 2, userId: "u-user", admins: true });
      t.events.emit({ event: "c-everyone", payload: 3, userId: null, admins: false });
      t.events.emit({ event: "d-end", payload: null, userId: null, admins: false });
      await Promise.all([admin, user, other].map((s) => s.until((x) => x.includes("d-end"))));
      const names = (/** @type {typeof admin} */ s) => s.messages().map((m) => m.event);
      assert.deepEqual(names(user), ["hello", "a-private", "b-admins-too", "c-everyone", "d-end"]);
      assert.deepEqual(names(admin), ["hello", "b-admins-too", "c-everyone", "d-end"]);
      assert.deepEqual(names(other), ["hello", "c-everyone", "d-end"]);
    } finally {
      for (const s of [admin, user, other]) s.destroy();
    }
  });

  test("a ping data event keeps an idle stream alive and is visible to the page", async () => {
    const s = await openStream(t, "user-token");
    try {
      await s.until(
        (text) => (text.match(/data: \{"event":"ping","payload":null\}\n\n/g) ?? []).length >= 2,
      );
      assert.ok(!s.text().includes(": ping"), "no comment line any more");
      assert.ok(s.pings() >= 2);
      assert.equal(
        s.messages().some((m) => m.event === "ping"),
        false,
        "messages() leaves the heartbeat out",
      );
    } finally {
      s.destroy();
    }
  });

  test("a ping is sent only after pingMs of silence: events restart the wait", async () => {
    const quiet = await startServer({ options: { pingMs: 300 } });
    const s = await openStream(quiet, "user-token");
    try {
      await s.until((text) => text.includes("hello"));
      // An event every 100 ms keeps the stream busy: no ping for a while.
      for (let i = 0; i < 6; i++) {
        quiet.events.emit({ event: "busy", payload: i, userId: "u-user", admins: false });
        await pause(100);
      }
      assert.equal(s.pings(), 0, "no ping while events keep coming");
      await s.until(() => s.pings() >= 1);
    } finally {
      s.destroy();
      await quiet.close();
    }
  });

  test("a foreign Origin is forbidden, the own one is fine", async () => {
    const foreign = await t.request("GET", "/api/events", {
      headers: { Cookie: "vidai_session=user-token", Origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    const own = await openStream(t, "user-token", { headers: { Origin: t.origin } });
    try {
      assert.equal(own.res.statusCode, 200);
    } finally {
      own.destroy();
    }
  });

  test("closeUser sends session-ended to that user and ends their streams only", async () => {
    const user = await openStream(t, "user-token");
    const other = await openStream(t, "other-token");
    try {
      await Promise.all([user, other].map((s) => s.until((x) => x.includes("hello"))));
      t.events.closeUser("u-user");
      await user.untilEnded();
      assert.deepEqual(
        user.messages().map((m) => m.event),
        ["hello", "session-ended"],
      );
      assert.equal(other.ended, false);
    } finally {
      user.destroy();
      other.destroy();
    }
  });
});

describe("stream lifetime", () => {
  test("the bus forgets a client that went away", async () => {
    const t = await startServer();
    let subscribed = 0;
    let unsubscribed = 0;
    const subscribe = t.events.subscribe.bind(t.events);
    t.events.subscribe = (who, listener, onClose) => {
      subscribed++;
      const off = subscribe(who, listener, onClose);
      return () => {
        unsubscribed++;
        off();
      };
    };
    try {
      const s = await openStream(t, "user-token");
      await s.until((x) => x.includes("hello"));
      assert.equal(subscribed, 1);
      s.destroy();
      for (let i = 0; i < 100 && unsubscribed === 0; i++) await pause(10);
      assert.equal(unsubscribed, 1);
      // Emitting afterwards must not fail.
      t.events.emit({ event: "x", payload: null, userId: null, admins: false });
    } finally {
      await t.close();
    }
  });

  test("close() ends open streams and returns promptly", async () => {
    const t = await startServer();
    const s = await openStream(t, "user-token");
    await s.until((x) => x.includes("hello"));
    const idle = await openStream(t, "admin-token");
    await idle.until((x) => x.includes("hello"));
    const started = Date.now();
    await t.server.close();
    assert.ok(Date.now() - started < 800, `close took ${Date.now() - started} ms`);
    await s.untilEnded();
    await idle.untilEnded();
    await t.close();
  });
});

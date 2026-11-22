// The OpenCode Go quota (docs/SPEC.md section 5, "Usage limits").

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { createApiHttp } from "../../src/agents/apiHttp.js";
import {
  NOT_FOR_THIS_KEY,
  NOT_GO,
  NO_GO_PLAN,
  NO_KEY,
  applyReading,
  createUsageService,
  emptyUsage,
  parseGoUsage,
  readingOf,
  usageUrl,
} from "../../src/agents/opencode/usage.js";
import { startProvider } from "./fakeProvider.js";

const GO_BODY = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 42, resetsAt: "2026-10-24T17:00:00.000Z" },
    weekly: { status: "ok", percent: 12.5, resetsAt: "2026-10-27T00:00:00Z" },
    monthly: { status: "rate-limited", percent: 97, resetsAt: "2026-11-03T08:15:00+00:00" },
  },
});

describe("usageUrl", () => {
  it("turns a Go address into its usage address", () => {
    assert.equal(
      usageUrl("https://opencode.ai/inference/go/anthropic"),
      "https://opencode.ai/inference/go/v1/usage",
    );
    assert.equal(
      usageUrl("https://opencode.ai/inference/go/anthropic/"),
      "https://opencode.ai/inference/go/v1/usage",
    );
    assert.equal(
      usageUrl("http://127.0.0.1:8484/inference/go/anthropic"),
      "http://127.0.0.1:8484/inference/go/v1/usage",
    );
  });

  it("is null for any other address", () => {
    assert.equal(usageUrl("https://opencode.ai/inference/anthropic"), null);
    assert.equal(usageUrl("https://gateway.example.com/anthropic"), null);
    assert.equal(usageUrl("not a url"), null);
  });
});

describe("parseGoUsage", () => {
  it("reads the three windows, a limited one as used up", () => {
    const limits = parseGoUsage(GO_BODY);
    assert.ok(limits);
    assert.equal(limits.length, 3);
    assert.deepEqual(limits[0], {
      key: "fiveHour",
      label: "5-hour limit",
      usedPercent: 42,
      resetsAt: Date.parse("2026-10-24T17:00:00.000Z"),
    });
    assert.equal(limits[1].usedPercent, 12.5);
    assert.equal(limits[2].key, "monthly");
    assert.equal(limits[2].usedPercent, 100);
    assert.equal(limits[2].resetsAt, Date.parse("2026-11-03T08:15:00Z"));
  });

  it("leaves out missing windows and refuses what is unreadable", () => {
    const partial = parseGoUsage('{"usage":{"weekly":{"percent":3}}}');
    assert.equal(partial?.length, 1);
    assert.equal(partial?.[0].resetsAt, null);
    assert.equal(parseGoUsage('{"usage":{}}'), null);
    assert.equal(parseGoUsage("nope"), null);
    assert.equal(parseGoUsage("[]"), null);
    assert.equal(parseGoUsage('{"usage":{"weekly":{"percent":"x"}}}'), null);
  });

  it("clamps a percentage into 0 to 100", () => {
    assert.equal(parseGoUsage('{"usage":{"weekly":{"percent":180}}}')?.[0].usedPercent, 100);
    assert.equal(parseGoUsage('{"usage":{"weekly":{"percent":-4}}}')?.[0].usedPercent, 0);
  });
});

describe("readingOf and applyReading", () => {
  it("turn answers into readings", () => {
    assert.equal(readingOf({ status: 200, body: GO_BODY }).kind, "limits");
    assert.equal(readingOf({ status: 200, body: "{}" }).kind, "failed");
    assert.deepEqual(readingOf({ status: 401, body: '{"error":{"type":"AuthError"}}' }), {
      kind: "unavailable",
      reason: NOT_FOR_THIS_KEY,
    });
    assert.deepEqual(
      readingOf({
        status: 403,
        body: '{"type":"error","error":{"type":"EntitlementError","message":"x"}}',
      }),
      { kind: "unavailable", reason: NO_GO_PLAN },
    );
    assert.deepEqual(readingOf({ status: 403, body: "" }), {
      kind: "unavailable",
      reason: NOT_FOR_THIS_KEY,
    });
    assert.deepEqual(readingOf({ status: 404, body: "" }), { kind: "unavailable", reason: NOT_GO });
    const failed = readingOf({ status: 503, body: "" });
    assert.equal(failed.kind === "failed" && failed.error.includes("503"), true);
  });

  it("a failed refresh keeps the last limits", () => {
    const limits = parseGoUsage('{"usage":{"rolling":{"percent":5}}}') ?? [];
    let status = applyReading(emptyUsage(), { kind: "limits", limits }, 1);
    status = applyReading(status, { kind: "failed", error: "down" }, 2);
    assert.deepEqual(status.limits, limits);
    assert.equal(status.error, "down");
    assert.equal(status.fetchedAt, 1);
    status = applyReading(status, { kind: "unavailable", reason: "no" }, 3);
    assert.deepEqual(status, { limits: [], unavailable: "no", fetchedAt: 3, error: null });
  });
});

describe("the usage service", () => {
  /** @type {(() => Promise<void>)[]} */
  const closers = [];
  after(async () => {
    for (const close of closers) await close();
  });

  /** @param {{ selected?: boolean, key?: string | null, handler?: Parameters<typeof startProvider>[0] }} [options] */
  async function setup({ selected = true, key = "oc_sk_go", handler } = {}) {
    const p = await startProvider(
      handler ??
        (({ headers }) =>
          headers.authorization === "Bearer oc_sk_go"
            ? { status: 200, body: GO_BODY }
            : {
                status: 401,
                body: '{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}',
              }),
    );
    closers.push(p.close);
    const http = createApiHttp({ version: "1" });
    let now = 1000;
    /** @type {unknown[]} */
    const updates = [];
    const state = { selected, key, baseUrl: `${p.url}/inference/go/anthropic` };
    const service = createUsageService({
      clock: { now: () => now },
      getWithKey: (url, k) => http.getWithKey(url, k),
      selected: () => state.selected,
      key: () => state.key,
      baseUrl: () => state.baseUrl,
      onUpdate: (usage) => updates.push(usage),
    });
    return { p, service, state, updates, tick: (/** @type {number} */ ms) => (now += ms) };
  }

  it("asks the Go usage address with the key and keeps the windows", async () => {
    const { p, service, updates } = await setup();
    const usage = await service.refresh();
    assert.equal(usage.limits.length, 3);
    assert.equal(p.seen[0].url, "/inference/go/v1/usage");
    assert.equal(updates.length, 1);
    assert.equal(service.usage(), usage);
  });

  it("asks nothing while edits do not run on OpenCode Go", async () => {
    const { p, service, updates } = await setup({ selected: false });
    assert.deepEqual(await service.refresh(), emptyUsage());
    assert.equal(p.seen.length, 0);
    assert.equal(updates.length, 0);
  });

  it("says why there are no meters without a key or for another address", async () => {
    const noKey = await setup({ key: null });
    assert.equal((await noKey.service.refresh()).unavailable, NO_KEY);
    assert.equal(noKey.p.seen.length, 0);
    const other = await setup();
    other.state.baseUrl = "https://opencode.ai/inference/anthropic";
    assert.equal((await other.service.refresh()).unavailable, NOT_GO);
    assert.equal(other.p.seen.length, 0);
  });

  it("shows that the key is not accepted", async () => {
    const { service, state } = await setup();
    state.key = "oc_sk_other";
    assert.equal((await service.refresh()).unavailable, NOT_FOR_THIS_KEY);
  });

  it("keeps the last limits when the service is down", async () => {
    let down = false;
    const { service } = await setup({
      handler: () => (down ? { status: 503, body: "" } : { status: 200, body: GO_BODY }),
    });
    await service.refresh();
    down = true;
    const usage = await service.refresh();
    assert.equal(usage.limits.length, 3);
    assert.match(usage.error ?? "", /503/);
  });

  it("shares one request between concurrent refreshes and forgets on reset", async () => {
    const { p, service, tick } = await setup();
    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    assert.equal(a, b);
    assert.equal(p.seen.length, 1);
    assert.equal(service.due(60_000), false);
    tick(60_000);
    assert.equal(service.due(60_000), true);
    service.reset();
    assert.deepEqual(service.usage(), emptyUsage());
    assert.equal(service.due(60_000), true);
  });

  it("drops an answer for settings that changed while it was on the way", async () => {
    /** @type {(() => void) | null} */
    let release = null;
    const { service } = await setup({
      handler: () =>
        new Promise((resolve) => (release = () => resolve({ status: 200, body: GO_BODY }))),
    });
    const pending = service.refresh();
    while (release === null) await new Promise((resolve) => setImmediate(resolve));
    service.reset();
    /** @type {() => void} */ (release)();
    await pending;
    assert.deepEqual(service.usage(), emptyUsage());
  });
});

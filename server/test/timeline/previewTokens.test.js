import assert from "node:assert/strict";
import test from "node:test";
import { createPreview } from "../../src/timeline/preview.js";
import { TOKEN_PATTERN, createTokenStore } from "../../src/timeline/previewTokens.js";

const target = { projectDir: "/p", videoDir: "/v", channelDir: "/c" };
const info = (/** @type {string} */ sessionId, /** @type {string} */ videoKey) => ({
  sessionId,
  userId: "u1",
  videoKey,
  ...target,
});

function setup(ttlMs = 1000) {
  const clock = {
    t: 0,
    now() {
      return this.t;
    },
  };
  const store = createTokenStore({ clock, ttlMs });
  return { clock, store };
}

test("a token is 32 random bytes as base64url and differs per session and video", () => {
  const { store } = setup();
  const a = store.open(info("s1", "v1"));
  const b = store.open(info("s2", "v1"));
  const c = store.open(info("s1", "v2"));
  assert.match(a, TOKEN_PATTERN);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.equal(new Set([a, b, c]).size, 3);
});

test("the same session reopening the same video gets the same token and a fresh lifetime", () => {
  const { clock, store } = setup();
  const first = store.open(info("s1", "v1"));
  clock.t = 900;
  assert.equal(store.open(info("s1", "v1")), first);
  clock.t = 1800;
  assert.notEqual(store.lookup(first), null);
  clock.t = 1900;
  assert.equal(store.lookup(first), null);
});

test("a token expires at its time to live and a new open then makes a new one", () => {
  const { clock, store } = setup();
  const first = store.open(info("s1", "v1"));
  clock.t = 999;
  assert.equal(store.lookup(first)?.videoKey, "v1");
  clock.t = 1000;
  assert.equal(store.lookup(first), null);
  assert.equal(store.size, 0);
  assert.notEqual(store.open(info("s1", "v1")), first);
});

test("sweep drops only the expired tokens", () => {
  const { clock, store } = setup();
  const old = store.open(info("s1", "v1"));
  clock.t = 600;
  const fresh = store.open(info("s2", "v1"));
  clock.t = 1100;
  store.sweep();
  assert.equal(store.size, 1);
  assert.equal(store.lookup(old), null);
  assert.notEqual(store.lookup(fresh), null);
});

test("closing a session or a video ends its tokens only", () => {
  const { store } = setup();
  const a = store.open(info("s1", "v1"));
  const b = store.open(info("s1", "v2"));
  const c = store.open(info("s2", "v1"));
  store.closeSession("s1");
  assert.equal(store.lookup(a), null);
  assert.equal(store.lookup(b), null);
  assert.notEqual(store.lookup(c), null);
  store.closeVideo("v1");
  assert.equal(store.lookup(c), null);
  assert.equal(store.size, 0);
});

test("malformed and unknown tokens are not found", () => {
  const { store } = setup();
  store.open(info("s1", "v1"));
  assert.equal(store.lookup(""), null);
  assert.equal(store.lookup("short"), null);
  assert.equal(store.lookup("A".repeat(43)), null);
  assert.equal(store.lookup(`${"A".repeat(42)}/`), null);
});

test("createPreview opens an address of the form /p/<token>/ and stop forgets everything", () => {
  const clock = { now: () => 0 };
  const log = { info() {}, warn() {}, error() {} };
  const fixed = Buffer.alloc(32, 1);
  const preview = createPreview({ clock, log, runtimeFile: "/x", random: () => fixed });
  const { token, url } = preview.open(info("s1", "v1"));
  assert.equal(token, fixed.toString("base64url"));
  assert.equal(url, `/p/${token}/`);
  assert.equal(preview.open(info("s1", "v1")).token, token);
  preview.stop();
  assert.notEqual(preview.open(info("s1", "v1")).token, "");
  assert.equal(preview.routes.length, 1);
  assert.equal(preview.routes[0]?.auth, "none");
  assert.equal(preview.routes[0]?.path, "/p/*");
});

// The timeline RPC functions (docs/SPEC.md section 14): names, access, input checks and how the
// signed-in user and session reach the service. The service itself is tested in `service*.test.js`.

import assert from "node:assert/strict";
import test from "node:test";
import { notFound } from "../../src/errors.js";
import { timelineFunctions } from "../../src/rpc/timeline.js";
import { createTestApp, rejectsWith } from "../rpc/support.js";

const NAMES = [
  "openTimeline",
  "getTimeline",
  "editTimeline",
  "undoTimeline",
  "redoTimeline",
  "listRevisions",
  "restoreRevision",
  "addTimelineNote",
  "deleteTimelineNote",
  "retryTimelineNote",
];

/** A service that records its calls and knows one video, owned by its first caller's id "mine". */
function setup() {
  const app = createTestApp();
  const ann = app.makeUser("ann@example.com");
  const bob = app.makeUser("bob@example.com");
  /** @type {{ method: string, args: unknown[] }[]} */
  const calls = [];
  /** @param {string} method @param {string} userId @param {string} videoId @param {unknown[]} rest */
  const record = (method, userId, videoId, rest) => {
    if (videoId !== "c1/video" || userId !== ann.id) throw notFound("This video does not exist.");
    calls.push({ method, args: [userId, videoId, ...rest] });
    return { method };
  };
  const service = /** @type {never} */ ({
    openTimeline: async (
      /** @type {{ userId: string, sessionId: string }} */ who,
      /** @type {string} */ v,
    ) => record("openTimeline", who.userId, v, [who.sessionId]),
    getTimeline: async (/** @type {string} */ u, /** @type {string} */ v) =>
      record("getTimeline", u, v, []),
    editTimeline: async (
      /** @type {string} */ u,
      /** @type {string} */ v,
      /** @type {number} */ r,
      /** @type {unknown} */ op,
    ) => record("editTimeline", u, v, [r, op]),
    undoTimeline: async (/** @type {string} */ u, /** @type {string} */ v) =>
      record("undoTimeline", u, v, []),
    redoTimeline: async (/** @type {string} */ u, /** @type {string} */ v) =>
      record("redoTimeline", u, v, []),
    listRevisions: async (/** @type {string} */ u, /** @type {string} */ v) =>
      record("listRevisions", u, v, []),
    restoreRevision: async (
      /** @type {string} */ u,
      /** @type {string} */ v,
      /** @type {number} */ n,
    ) => record("restoreRevision", u, v, [n]),
    addNote: async (
      /** @type {string} */ u,
      /** @type {string} */ v,
      /** @type {unknown} */ input,
    ) => record("addNote", u, v, [input]),
    deleteNote: async (
      /** @type {string} */ u,
      /** @type {string} */ v,
      /** @type {string} */ id,
    ) => {
      record("deleteNote", u, v, [id]);
    },
    retryNote: async (/** @type {string} */ u, /** @type {string} */ v, /** @type {string} */ id) =>
      record("retryNote", u, v, [id]),
  });
  const functions = timelineFunctions({ service });
  app.rpc.register(functions);
  return {
    app,
    ann,
    bob,
    calls,
    functions,
    ctx: (/** @type {{ id: string } | null} */ u) => app.contextFor(u),
  };
}

const video = { videoId: "c1/video" };
const inputs = /** @type {Record<string, Record<string, unknown>>} */ ({
  openTimeline: video,
  getTimeline: video,
  editTimeline: { ...video, revision: 3, op: { type: "delete", clipId: "b-3" } },
  undoTimeline: video,
  redoTimeline: video,
  listRevisions: video,
  restoreRevision: { ...video, n: 2 },
  addTimelineNote: { ...video, frame: 5, shape: null, elementId: null, prompt: "Hi" },
  deleteTimelineNote: { ...video, noteId: "n1" },
  retryTimelineNote: { ...video, noteId: "n1" },
});

test("the functions and their access", () => {
  const s = setup();
  assert.deepEqual(
    s.functions.map((f) => f.name),
    NAMES,
  );
  assert.ok(s.functions.every((f) => f.access === "user"));
});

test("a signed-in user's call reaches the service with their id", async () => {
  const s = setup();
  for (const name of NAMES) {
    await s.app.call(name, inputs[name], s.ctx(s.ann));
  }
  assert.deepEqual(
    s.calls.map((c) => c.method),
    [
      "openTimeline",
      "getTimeline",
      "editTimeline",
      "undoTimeline",
      "redoTimeline",
      "listRevisions",
      "restoreRevision",
      "addNote",
      "deleteNote",
      "retryNote",
    ],
  );
  assert.ok(s.calls.every((c) => c.args[0] === s.ann.id && c.args[1] === "c1/video"));
  assert.deepEqual(s.calls[2]?.args.slice(2), [3, { type: "delete", clipId: "b-3" }]);
  assert.deepEqual(s.calls[6]?.args.slice(2), [2]);
  assert.deepEqual(s.calls[7]?.args.slice(2), [
    { frame: 5, shape: null, elementId: null, prompt: "Hi" },
  ]);
  assert.deepEqual(s.calls[8]?.args.slice(2), ["n1"]);
  // openTimeline passes the session that asked, so the preview belongs to it.
  const sessionId = s.calls[0]?.args[2];
  assert.equal(typeof sessionId, "string");
  assert.notEqual(sessionId, "");
  // deleteTimelineNote answers null.
  assert.equal(
    await s.app.call("deleteTimelineNote", inputs.deleteTimelineNote, s.ctx(s.ann)),
    null,
  );
});

test("signed-out calls are refused", async () => {
  const s = setup();
  for (const name of NAMES) {
    await rejectsWith(s.app.call(name, inputs[name], s.ctx(null)), "unauthenticated");
  }
  assert.deepEqual(s.calls, []);
});

test("another user's video is notFound", async () => {
  const s = setup();
  for (const name of NAMES) {
    await rejectsWith(s.app.call(name, inputs[name], s.ctx(s.bob)), "notFound");
  }
  assert.deepEqual(s.calls, []);
});

test("inputs are checked: missing and extra fields, wrong types, numbers out of range", async () => {
  const s = setup();
  const call = (/** @type {string} */ name, /** @type {unknown} */ input) =>
    s.app.call(name, input, s.ctx(s.ann));
  for (const name of NAMES) {
    await rejectsWith(call(name, {}), "invalidInput");
    await rejectsWith(call(name, null), "invalidInput");
    await rejectsWith(call(name, { ...inputs[name], extra: 1 }), "invalidInput");
    await rejectsWith(call(name, { ...inputs[name], videoId: 5 }), "invalidInput");
    await rejectsWith(call(name, { ...inputs[name], videoId: "" }), "invalidInput");
  }
  await rejectsWith(call("restoreRevision", { ...video, n: 0 }), "invalidInput");
  await rejectsWith(call("restoreRevision", { ...video, n: 1.5 }), "invalidInput");
  await rejectsWith(call("restoreRevision", { ...video, n: "2" }), "invalidInput");
  await rejectsWith(call("editTimeline", { ...video, revision: -1, op: {} }), "invalidInput");
  await rejectsWith(call("editTimeline", { ...video, op: {} }), "invalidInput");
  await rejectsWith(call("deleteTimelineNote", { ...video, noteId: "" }), "invalidInput");
  await rejectsWith(
    call("retryTimelineNote", { ...video, noteId: "x".repeat(65) }),
    "invalidInput",
  );
  // The fields of a change request are checked by the service, with sentences about each field.
  assert.deepEqual(s.calls, []);
});

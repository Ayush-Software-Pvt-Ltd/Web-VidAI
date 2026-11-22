import { test } from "node:test";
import assert from "node:assert/strict";
import { adminSystemFunctions } from "../../src/rpc/adminSystem.js";
import { createTestApp, rejectsWith } from "./support.js";

const state = {
  running: true,
  steps: [],
  log: [],
  startedAt: 1,
  finishedAt: null,
  needsPrepare: false,
  reason: null,
  editReady: false,
  renderReady: false,
};

/** @param {{ installError?: string | null }} [options] */
function withSystem({ installError = null } = {}) {
  const app = createTestApp();
  const calls = { view: 0, start: 0 };
  app.rpc.register(
    adminSystemFunctions({
      system: {
        view: async () => {
          calls.view += 1;
          return /** @type {any} */ ({ server: { version: "1.2.3" } });
        },
      },
      toolkit: {
        start: () => {
          calls.start += 1;
          return state;
        },
        installError: () => installError,
      },
    }),
  );
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  return { app, calls, ctx: app.contextFor(admin) };
}

test("signed-out callers and plain users cannot read the System page or start Prepare", async () => {
  const { app, calls } = withSystem();
  const user = app.makeUser("u@example.com");
  for (const name of ["adminGetSystem", "adminPrepareToolkit"]) {
    await rejectsWith(app.call(name, {}, app.contextFor()), "unauthenticated");
    await rejectsWith(app.call(name, {}, app.contextFor(user)), "forbidden");
  }
  assert.deepEqual(calls, { view: 0, start: 0 });
});

test("adminGetSystem answers with the whole page", async () => {
  const { app, ctx, calls } = withSystem();
  const view = /** @type {any} */ (await app.call("adminGetSystem", {}, ctx));
  assert.equal(view.server.version, "1.2.3");
  assert.equal(calls.view, 1);
});

test("adminPrepareToolkit starts Prepare and answers at once with its state", async () => {
  const { app, ctx, calls } = withSystem();
  assert.deepEqual(await app.call("adminPrepareToolkit", {}, ctx), state);
  assert.equal(calls.start, 1);
});

test("adminPrepareToolkit refuses with the reason when the toolkit is not installed", async () => {
  const { app, ctx, calls } = withSystem({ installError: "The disk is full." });
  await rejectsWith(
    app.call("adminPrepareToolkit", {}, ctx),
    "notReady",
    /not installed.*The disk is full\./,
  );
  assert.equal(calls.start, 0);
});

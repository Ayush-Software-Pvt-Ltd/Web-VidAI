import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/db/open.js";
import { createProgressHistory } from "../../src/db/progressHistory.js";
import { HISTORY_RUNS, pacingFromHistory } from "../../src/jobs/progressPacing.js";

function make(options = {}) {
  const db = openDatabase(":memory:");
  return { db, history: createProgressHistory(db, options) };
}

/** @param {"edit" | "reEdit" | "timelineEdit" | "render"} kind @param {"long" | "short"} videoType @param {number} seconds @param {number} finishedAt */
const row = (kind, videoType, seconds, finishedAt) => ({ kind, videoType, seconds, finishedAt });

test("a new history has nothing", () => {
  const { history } = make();
  assert.deepEqual(history.recent("edit", "short", 10), []);
});

test("rows come back newest first, by kind and video type", () => {
  const { history } = make();
  history.add(row("edit", "short", 1500, 100));
  history.add(row("edit", "short", 1600, 300));
  history.add(row("edit", "short", 1700, 200));
  history.add(row("edit", "long", 2500, 400));
  history.add(row("reEdit", "short", 400, 500));
  assert.deepEqual(
    history.recent("edit", "short", 10).map((r) => [r.seconds, r.finishedAt]),
    [
      [1600, 300],
      [1700, 200],
      [1500, 100],
    ],
  );
  assert.deepEqual(history.recent("edit", "short", 2).length, 2);
  assert.deepEqual(history.recent("edit", "long", 10), [row("edit", "long", 2500, 400)]);
  assert.deepEqual(history.recent("reEdit", "short", 10), [row("reEdit", "short", 400, 500)]);
  assert.deepEqual(history.recent("timelineEdit", "short", 10), []);
  assert.deepEqual(history.recent("edit", "short", 0), []);
});

test("equal finish times keep the later insert first", () => {
  const { history } = make();
  history.add(row("edit", "short", 1, 100));
  history.add(row("edit", "short", 2, 100));
  assert.deepEqual(
    history.recent("edit", "short", 10).map((r) => r.seconds),
    [2, 1],
  );
});

test("only the newest rows of a kind and type are kept, the others stay", () => {
  const { db, history } = make();
  for (let i = 0; i < HISTORY_RUNS + 5; i += 1) history.add(row("edit", "short", 1000 + i, i));
  history.add(row("edit", "long", 1, 0));
  history.add(row("reEdit", "short", 1, 0));
  const kept = history.recent("edit", "short", 100);
  assert.equal(kept.length, HISTORY_RUNS);
  assert.equal(kept[0].seconds, 1000 + HISTORY_RUNS + 4);
  assert.equal(kept.at(-1)?.seconds, 1005);
  assert.equal(history.recent("edit", "long", 100).length, 1);
  assert.equal(history.recent("reEdit", "short", 100).length, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM progress_history")?.n, HISTORY_RUNS + 2);
  // An old job finishing late does not displace newer ones past the limit.
  const small = make({ keep: 2 });
  small.history.add(row("edit", "short", 1, 30));
  small.history.add(row("edit", "short", 2, 20));
  small.history.add(row("edit", "short", 3, 10));
  assert.deepEqual(
    small.history.recent("edit", "short", 10).map((r) => r.seconds),
    [1, 2],
  );
});

test("a render has history rows too", () => {
  const { history } = make();
  history.add(row("render", "long", 90, 1));
  assert.equal(history.recent("render", "long", 10)[0].seconds, 90);
});

test("the median rule works on what the table returns", () => {
  const { history } = make();
  history.add(row("edit", "short", 1200, 1));
  history.add(row("edit", "short", 1800, 2));
  assert.equal(
    pacingFromHistory("edit", "short", history.recent("edit", "short", 10)).totalMs,
    25 * 60_000,
  );
  history.add(row("edit", "short", 2400, 3));
  const pacing = pacingFromHistory("edit", "short", history.recent("edit", "short", 10));
  assert.equal(pacing.totalMs, 1_800_000);
});

test("nonsense rows are refused by the table", () => {
  const { history } = make();
  assert.throws(() => history.add(row(/** @type {never} */ ("other"), "short", 1, 1)));
  assert.throws(() => history.add(row("edit", /** @type {never} */ ("wide"), 1, 1)));
  // A negative time is stored as zero.
  history.add(row("edit", "short", -5, 1));
  assert.equal(history.recent("edit", "short", 1)[0].seconds, 0);
});

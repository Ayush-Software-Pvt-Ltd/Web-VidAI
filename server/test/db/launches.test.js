// The `launches` table (docs/SPEC.md section 15): the start delay's memory.

import test from "node:test";
import assert from "node:assert/strict";
import { createLaunchesRepo, KEEP_LAUNCHES } from "../../src/db/launches.js";
import { openDatabase } from "../../src/db/open.js";

test("last is null before any launch, then the newest time of that queue", () => {
  const launches = createLaunchesRepo(openDatabase(":memory:"));
  assert.equal(launches.last("edits"), null);
  launches.record("edits", 100);
  launches.record("edits", 300);
  launches.record("edits", 200);
  launches.record("renders", 900);
  assert.equal(launches.last("edits"), 300);
  assert.equal(launches.last("renders"), 900);
  assert.equal(launches.last("timeline"), null);
});

test("only the newest 100 launches of a queue are kept, other queues are left alone", () => {
  const launches = createLaunchesRepo(openDatabase(":memory:"));
  launches.record("renders", 1);
  for (let at = 1; at <= KEEP_LAUNCHES + 20; at += 1) launches.record("edits", at);
  assert.equal(launches.count("edits"), KEEP_LAUNCHES);
  assert.equal(launches.last("edits"), KEEP_LAUNCHES + 20);
  assert.equal(launches.count("renders"), 1);
});

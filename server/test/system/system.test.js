import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/db/open.js";
import { createSystem, describeOs } from "../../src/system.js";

const toolkitInfo = {
  installedVersion: "1.1.0",
  shippedVersion: "1.1.0",
  upToDate: true,
  installError: null,
  folder: "/data/toolkit/CLAUDE_VE_ALL",
  python: "/data/toolkit/venv/bin/python",
  hasPrevious: false,
};
const prepareState = {
  running: false,
  steps: [],
  log: [],
  startedAt: null,
  finishedAt: null,
  needsPrepare: false,
  reason: null,
  editReady: true,
  renderReady: true,
};

/** A database with two users, two channels and jobs in three states. */
function database() {
  const db = openDatabase(":memory:");
  const user = (
    /** @type {string} */ id,
    /** @type {string} */ role,
    /** @type {number} */ disabled,
  ) =>
    db.run(
      "INSERT INTO users (id, email, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, 1, 1)",
      id,
      `${id}@example.com`,
      role,
      disabled,
    );
  user("u1", "admin", 0);
  user("u2", "user", 0);
  user("u3", "user", 1);
  for (const [id, name] of [
    ["c1", "One"],
    ["c2", "Two"],
  ]) {
    db.run(
      "INSERT INTO channels (id, user_id, name, dir, video_type, profiles, position, created_at) VALUES (?, 'u2', ?, ?, 'auto', '{}', 0, 1)",
      id,
      name,
      `/x/${id}`,
    );
  }
  /** @type {[string, string][]} */
  const jobs = [
    ["j1", "completed"],
    ["j2", "completed"],
    ["j3", "running"],
    ["j4", "failed"],
  ];
  jobs.forEach(([id, state], i) => {
    db.run(
      "INSERT INTO videos (id, channel_id, folder_name, created_at) VALUES (?, 'c1', ?, 1)",
      `v${i}`,
      `f${i}`,
    );
    db.run(
      "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES (?, ?, 'u2', 'edit', 'edits', ?, 1, 'long')",
      id,
      `v${i}`,
      state,
    );
  });
  return db;
}

/** @param {Partial<import("../../src/system.js").SystemDeps>} [overrides] */
function build(overrides = {}) {
  return createSystem({
    db: database(),
    dataDir: "/data",
    version: "0.1.0",
    clock: { now: () => 7_000 },
    addresses: () => ["https://mac.local:14200", "https://192.168.1.5:14200"],
    limits: {
      cpuState: () => ({ processors: 8, running: 1, budget: 2 }),
      gpuState: () => ({ total: 1, perJob: 1, slots: [] }),
    },
    toolkit: () => toolkitInfo,
    prepare: () => prepareState,
    statfs: () => ({ bavail: 1000, bsize: 4096, blocks: 5000 }),
    os: {
      platform: () => "darwin",
      release: () => "25.6.0",
      arch: () => "arm64",
      hostname: () => "mac",
    },
    ...overrides,
  });
}

test("the view has every part, with the shapes the page expects", async () => {
  const view = await build({
    probes: {
      ffmpeg: () => ({
        found: true,
        path: "/b/ffmpeg",
        version: "7.1",
        note: "Hardware encoders found: videotoolbox.",
      }),
      python: async () => ({ found: true, path: "/p", version: "3.12.4" }),
    },
  }).view();
  assert.deepEqual(Object.keys(view), [
    "server",
    "dataDir",
    "addresses",
    "toolkit",
    "prepare",
    "programs",
    "cpu",
    "gpu",
    "counts",
  ]);
  assert.deepEqual(view.server, {
    version: "0.1.0",
    node: process.versions.node,
    os: "macOS 25.6.0 (arm64)",
    hostname: "mac",
    startedAt: 7000,
  });
  assert.deepEqual(view.dataDir, {
    path: "/data",
    freeBytes: 1000 * 4096,
    totalBytes: 5000 * 4096,
  });
  assert.deepEqual(view.addresses, ["https://mac.local:14200", "https://192.168.1.5:14200"]);
  assert.deepEqual(view.toolkit, toolkitInfo);
  assert.deepEqual(view.prepare, prepareState);
  assert.deepEqual(view.cpu, { processors: 8, running: 1, budget: 2 });
  assert.deepEqual(view.gpu, { total: 1, perJob: 1, slots: [] });
  assert.deepEqual(view.counts, {
    users: { total: 3, admins: 1, disabled: 1 },
    channels: 2,
    jobs: {
      queued: 0,
      running: 1,
      pausing: 0,
      paused: 0,
      stopping: 0,
      stopped: 0,
      failed: 1,
      completed: 2,
    },
  });
});

test("programs are listed in a fixed order; one without a probe is 'not checked'; every field is present", async () => {
  const view = await build({
    probes: {
      ffmpeg: () => ({ found: true, path: "/b/ffmpeg", version: "7.1" }),
    },
  }).view();
  assert.deepEqual(
    view.programs.map((p) => p.id),
    ["claude", "opencode", "ffmpeg", "ffprobe", "python", "hyperframes"],
  );
  assert.deepEqual(view.programs[2], {
    id: "ffmpeg",
    label: "ffmpeg",
    found: true,
    path: "/b/ffmpeg",
    version: "7.1",
    note: null,
  });
  assert.deepEqual(view.programs[0], {
    id: "claude",
    label: "Claude Code",
    found: false,
    path: null,
    version: null,
    note: "Not checked.",
  });
});

test("a probe that throws or is too slow becomes a note, not an error of the page", async () => {
  const view = await build({
    probeTimeoutMs: 20,
    probes: {
      claude: () => {
        throw new Error("spawn failed");
      },
      opencode: () => new Promise(() => {}),
      ffmpeg: async () => {
        throw new Error("async failure");
      },
    },
  }).view();
  assert.equal(view.programs[0]?.found, false);
  assert.equal(view.programs[0]?.note, "This check failed: spawn failed");
  assert.equal(view.programs[1]?.note, "This check took too long to answer.");
  assert.equal(view.programs[2]?.note, "This check failed: async failure");
});

test("a disk that cannot be read is null; without addresses the list is empty", async () => {
  const view = await build({
    statfs: () => {
      throw new Error("no such directory");
    },
    addresses: undefined,
  }).view();
  assert.deepEqual(view.dataDir, { path: "/data", freeBytes: null, totalBytes: null });
  assert.deepEqual(view.addresses, []);
});

test("the operating system in words", () => {
  assert.equal(describeOs("darwin", "25.6.0", "arm64"), "macOS 25.6.0 (arm64)");
  assert.equal(describeOs("win32", "10.0.26100", "x64"), "Windows 10.0.26100 (x64)");
  assert.equal(describeOs("linux", "6.1", "x64"), "linux 6.1 (x64)");
});

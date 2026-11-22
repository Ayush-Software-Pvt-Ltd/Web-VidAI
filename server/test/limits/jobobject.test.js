import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createJobObjectClient,
  jobRate,
  parseAnswer,
  requestLine,
} from "../../src/limits/jobobject.js";
import { createCpuLimiter } from "../../src/limits/limiter.js";
import { HELPER_SCRIPT, helperCommand } from "../../src/platform/jobobject.windows.js";
import { createFakeLog, createFakeTime } from "./fakes.js";

/**
 * A helper process the tests drive by hand.
 */
function createFakeHelper() {
  /** @type {string[]} */
  const written = [];
  /** @type {((line: string) => void)[]} */
  const lineListeners = [];
  /** @type {((code: number | null) => void)[]} */
  const exitListeners = [];
  const state = { ended: false, killed: false };
  const helper = {
    write: (/** @type {string} */ line) => {
      written.push(line);
    },
    onLine: (/** @type {(line: string) => void} */ listener) => {
      lineListeners.push(listener);
    },
    onExit: (/** @type {(code: number | null) => void} */ listener) => {
      exitListeners.push(listener);
    },
    end: () => {
      state.ended = true;
    },
    kill: () => {
      state.killed = true;
    },
  };
  return {
    helper,
    written,
    state,
    /** @param {string} line */
    say: (line) => {
      for (const listener of lineListeners) listener(line);
    },
    /** @param {number | null} code */
    exit: (code) => {
      for (const listener of exitListeners) listener(code);
    },
    /** The requests written so far, parsed. */
    requests: () =>
      written.map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line))),
  };
}

/** Answers each request with ok as soon as it is written. */
function createAutoHelper() {
  const fake = createFakeHelper();
  const write = fake.helper.write;
  fake.helper.write = (line) => {
    write(line);
    const request = /** @type {{ id: number }} */ (JSON.parse(line));
    queueMicrotask(() => fake.say(JSON.stringify({ id: request.id, ok: true })));
  };
  // A real helper ends when its stdin ends.
  fake.helper.end = () => {
    fake.state.ended = true;
    queueMicrotask(() => fake.exit(0));
  };
  return fake;
}

describe("jobRate", () => {
  test("is the share of all processors in 1/100 of a percent", () => {
    assert.equal(jobRate(0.5, 8), 625);
    assert.equal(jobRate(4, 8), 5000);
    assert.equal(jobRate(8, 8), 10000);
    assert.equal(jobRate(1, 4), 2500);
    assert.equal(jobRate(2.5, 16), 1563);
    assert.equal(jobRate(1, 3), 3333);
  });

  test("stays within 1 to 10000", () => {
    assert.equal(jobRate(0.0001, 64), 1);
    assert.equal(jobRate(100, 8), 10000);
    assert.equal(jobRate(0, 8), 1);
    assert.equal(jobRate(1, 0), 10000);
  });

  test("every budget the formula can give is in range on 1 to 64 processors", () => {
    for (const processors of [1, 4, 8, 16, 64]) {
      for (let running = 1; running <= 12; running += 1) {
        const budget = Math.min(processors, processors / running);
        const rate = jobRate(budget, processors);
        assert.ok(Number.isInteger(rate) && rate >= 1 && rate <= 10000, `${processors}/${running}`);
      }
    }
  });
});

describe("requestLine and parseAnswer", () => {
  test("a request is one line of JSON", () => {
    const line = requestLine(7, { op: "assign", job: "job-1", pid: 4242 });
    assert.ok(!line.includes("\n"));
    assert.deepEqual(JSON.parse(line), { id: 7, op: "assign", job: "job-1", pid: 4242 });
    assert.deepEqual(JSON.parse(requestLine(8, { op: "setRate", job: "j", rate: 625 })), {
      id: 8,
      op: "setRate",
      job: "j",
      rate: 625,
    });
    assert.deepEqual(JSON.parse(requestLine(9, { op: "close", job: "j" })), {
      id: 9,
      op: "close",
      job: "j",
    });
  });

  test("characters outside ASCII are escaped for the helper's code page", () => {
    const line = requestLine(1, { op: "create", job: 'k\u00fc\u4e2d"\\' });
    assert.ok(/^[\x20-\x7e]*$/.test(line), line);
    assert.equal(/** @type {{ job: string }} */ (JSON.parse(line)).job, 'k\u00fc\u4e2d"\\');
  });

  test("answers", () => {
    assert.deepEqual(parseAnswer('{"ready":true}'), { kind: "ready", ok: true, error: null });
    assert.deepEqual(parseAnswer('{"ready":false,"error":"no Add-Type"}'), {
      kind: "ready",
      ok: false,
      error: "no Add-Type",
    });
    assert.deepEqual(parseAnswer('{"id":3,"ok":true}'), {
      kind: "answer",
      id: 3,
      ok: true,
      error: null,
    });
    assert.deepEqual(
      parseAnswer('{"id":4,"ok":false,"error":"OpenProcess failed (Win32 error 5)"}'),
      {
        kind: "answer",
        id: 4,
        ok: false,
        error: "OpenProcess failed (Win32 error 5)",
      },
    );
  });

  test("anything else is invalid", () => {
    for (const line of [
      "",
      "hello",
      "[1]",
      "null",
      '{"id":"3","ok":true}',
      '{"id":1}',
      '{"ok":true}',
    ]) {
      assert.deepEqual(parseAnswer(line), { kind: "invalid" }, line);
    }
  });
});

describe("the helper script and command line", () => {
  test("PowerShell by its full path, no profile, no prompt, the script encoded", () => {
    const { file, args } = helperCommand({ SystemRoot: "C:\\Windows" });
    assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(args.slice(0, 4), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    assert.equal(args[4], "-EncodedCommand");
    assert.equal(Buffer.from(args[5] ?? "", "base64").toString("utf16le"), HELPER_SCRIPT);
  });

  test("falls back to windir and then C:\\Windows", () => {
    assert.ok(helperCommand({ windir: "D:\\Win" }).file.startsWith("D:\\Win\\"));
    assert.ok(helperCommand({}).file.startsWith("C:\\Windows\\"));
  });

  test("the command line fits CreateProcess (32767 characters)", () => {
    const { file, args } = helperCommand({ SystemRoot: "C:\\Windows" });
    assert.ok([file, ...args].join(" ").length < 30_000);
  });

  test("the script is plain ASCII without backticks, has the five operations and the Win32 facts", () => {
    assert.ok(
      [...HELPER_SCRIPT].every((c) => c === "\n" || c === "\t" || (c >= " " && c <= "~")),
      "ASCII only",
    );
    assert.ok(!HELPER_SCRIPT.includes("`"));
    for (const word of [
      "CreateJobObject",
      "AssignProcessToJobObject",
      "SetInformationJobObject",
      "TerminateJobObject",
      "OpenProcess",
      "0x2000", // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      "0x1", // JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
      "0x4", // JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
      "InfoRate = 15",
      "InfoExtended = 9",
      "'create'",
      "'assign'",
      "'setRate'",
      "'terminate'",
      "'close'",
      '{"ready":true}',
    ]) {
      assert.ok(HELPER_SCRIPT.includes(word), word);
    }
    // The here-string that holds the C# must close at the start of a line.
    assert.ok(/\n'@\n/.test(HELPER_SCRIPT));
    assert.equal(HELPER_SCRIPT.match(/@'/g)?.length, 1);
  });

  test("the C# uses no syntax newer than C# 5 (Windows PowerShell 5.1)", () => {
    for (const forbidden of ["=>", "?.", "nameof(", '$"', "out var", "?? "]) {
      assert.ok(!HELPER_SCRIPT.includes(forbidden), forbidden);
    }
  });
});

describe("the helper client", () => {
  /** @param {{ requestTimeoutMs?: number, startTimeoutMs?: number }} [timeouts] */
  function setup(timeouts = {}) {
    const time = createFakeTime();
    const log = createFakeLog();
    /** @type {ReturnType<typeof createFakeHelper>[]} */
    const helpers = [];
    const client = createJobObjectClient({
      spawnHelper: () => {
        const fake = createFakeHelper();
        helpers.push(fake);
        return fake.helper;
      },
      timers: time.timers,
      log,
      ...timeouts,
    });
    return { time, log, helpers, client };
  }

  test("starts the helper on the first request and queues until it is ready", async () => {
    const { helpers, client } = setup();
    assert.equal(client.state(), "idle");
    const first = client.create("job-1");
    const second = client.assign("job-1", 77);
    assert.equal(client.state(), "starting");
    assert.equal(helpers.length, 1);
    const helper = helpers[0];
    assert.ok(helper);
    assert.deepEqual(helper.written, [], "nothing is written before ready");
    helper.say('{"ready":true}');
    assert.equal(client.state(), "ready");
    assert.deepEqual(
      helper.requests().map((r) => [r.id, r.op, r.job, r.pid]),
      [
        [1, "create", "job-1", undefined],
        [2, "assign", "job-1", 77],
      ],
    );
    helper.say('{"id":1,"ok":true}');
    helper.say('{"id":2,"ok":true}');
    await Promise.all([first, second]);
  });

  test("answers settle the right request, errors reject with the helper's words", async () => {
    const { helpers, client } = setup();
    const ok = client.create("a");
    const bad = client.setRate("a", 5000);
    const helper = helpers[0];
    assert.ok(helper);
    helper.say('{"ready":true}');
    helper.say(
      '{"id":2,"ok":false,"error":"SetInformationJobObject (CPU rate) failed (Win32 error 87)"}',
    );
    helper.say('{"id":1,"ok":true}');
    await ok;
    await assert.rejects(bad, /Win32 error 87/);
    // A late or unknown answer is ignored.
    helper.say('{"id":99,"ok":true}');
  });

  test("lines that are not answers are logged and ignored", () => {
    const { helpers, client, log } = setup();
    void client.create("a").catch(() => {});
    const helper = helpers[0];
    assert.ok(helper);
    helper.say("Add-Type: warning something");
    helper.say('{"ready":true}');
    assert.equal(client.state(), "ready");
    assert.ok(log.lines.some((l) => l.level === "warn"));
  });

  test("a helper that is not ready rejects what waits, and the next request starts a new one", async () => {
    const { helpers, client } = setup();
    const waiting = client.create("a");
    helpers[0]?.say('{"ready":false,"error":"Constrained Language Mode"}');
    await assert.rejects(waiting, /Constrained Language Mode/);
    assert.equal(client.state(), "dead");
    assert.equal(helpers[0]?.state.killed, true);
    const again = client.create("a");
    assert.equal(helpers.length, 2);
    helpers[1]?.say('{"ready":true}');
    helpers[1]?.say('{"id":2,"ok":true}');
    await again;
  });

  test("the helper ending rejects everything unanswered; jobs it held are gone", async () => {
    const { helpers, client } = setup();
    const create = client.create("a");
    helpers[0]?.say('{"ready":true}');
    helpers[0]?.say('{"id":1,"ok":true}');
    await create;
    const pending = client.assign("a", 5);
    helpers[0]?.exit(1);
    await assert.rejects(pending, /ended \(exit code 1\)/);
    assert.equal(client.state(), "dead");
    const next = client.close("a");
    assert.equal(helpers.length, 2, "a new helper for the next request");
    helpers[1]?.say('{"ready":true}');
    helpers[1]?.say('{"id":3,"ok":false,"error":"there is no such job"}');
    await assert.rejects(next, /no such job/);
  });

  test("a helper that does not become ready in time is ended", async () => {
    const { time, helpers, client } = setup({ startTimeoutMs: 30_000 });
    const waiting = client.create("a");
    const settled = assert.rejects(waiting, /did not become ready/);
    await time.advance(30_000);
    await settled;
    assert.equal(helpers[0]?.state.killed, true);
    assert.equal(client.state(), "dead");
  });

  test("an answer that does not come is a rejection, not a hang", async () => {
    const { time, helpers, client } = setup({ requestTimeoutMs: 15_000 });
    const request = client.terminate("a");
    helpers[0]?.say('{"ready":true}');
    const settled = assert.rejects(request, /did not answer "terminate"/);
    await time.advance(15_000);
    await settled;
    // The helper stays; a late answer is ignored.
    helpers[0]?.say('{"id":1,"ok":true}');
    assert.equal(client.state(), "ready");
  });

  test("a helper that cannot be started rejects", async () => {
    const time = createFakeTime();
    const client = createJobObjectClient({
      spawnHelper: () => {
        throw new Error("PowerShell could not be started");
      },
      timers: time.timers,
    });
    await assert.rejects(client.create("a"), /could not be started/);
    assert.equal(client.state(), "dead");
  });

  test("stop closes stdin and resolves when the helper ends; it kills a helper that stays", async () => {
    const { time, helpers, client } = setup();
    const create = client.create("a");
    helpers[0]?.say('{"ready":true}');
    helpers[0]?.say('{"id":1,"ok":true}');
    await create;
    const stopping = client.stop(2000);
    assert.equal(helpers[0]?.state.ended, true);
    helpers[0]?.exit(0);
    await stopping;
    assert.equal(client.state(), "dead");
    assert.equal(time.pending(), 0);

    const second = client.create("b");
    helpers[1]?.say('{"ready":true}');
    helpers[1]?.say('{"id":2,"ok":true}');
    await second;
    const stuck = client.stop(2000);
    await time.advance(2000);
    await stuck;
    assert.equal(helpers[1]?.state.killed, true);
    // Stopping when nothing runs is fine.
    await client.stop();
  });
});

describe("the Windows limiter behind the common interface", () => {
  /** @param {number} [processors] */
  function setup(processors = 8) {
    const time = createFakeTime();
    const log = createFakeLog();
    const fake = createAutoHelper();
    const limiter = createCpuLimiter({
      platform: "win32",
      processors,
      clock: time.clock,
      timers: time.timers,
      log,
      spawnHelper: () => {
        queueMicrotask(() => fake.say('{"ready":true}'));
        return fake.helper;
      },
      listTree: async (pid) => [pid, pid + 1, pid + 2],
    });
    return { time, log, fake, limiter };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test("add creates the job and puts the root and its tree in it, setBudget sets the rate", async () => {
    const { fake, limiter } = setup();
    limiter.add("j1", { rootPid: 500, exempt: true });
    limiter.setBudget("j1", 4);
    await limiter.stop();
    assert.deepEqual(
      fake.requests().map((r) => [r.op, r.job, r.pid, r.rate]),
      [
        ["create", "j1", undefined, undefined],
        ["assign", "j1", 500, undefined],
        ["assign", "j1", 501, undefined],
        ["assign", "j1", 502, undefined],
        ["setRate", "j1", undefined, 5000],
      ],
    );
  });

  test("a fractional budget and a lifted limit", async () => {
    const { fake, limiter } = setup();
    limiter.add("j1", { rootPid: 500, exempt: false });
    limiter.setBudget("j1", 0.5);
    limiter.setBudget("j1", Infinity);
    await limiter.stop();
    const rates = fake
      .requests()
      .filter((r) => r.op === "setRate")
      .map((r) => r.rate);
    assert.deepEqual(rates, [625, 10000]);
  });

  test("remove closes the job, terminate ends it, resumeAll and resumeLeftovers do nothing", async () => {
    const { fake, limiter } = setup();
    limiter.add("j1", { rootPid: 500, exempt: true });
    limiter.resumeAll("j1");
    assert.equal(await limiter.resumeLeftovers([500]), 0);
    assert.equal(await limiter.terminate("j1"), true);
    limiter.remove("j1");
    limiter.remove("j1");
    limiter.setBudget("j1", 2); // after remove: ignored
    assert.equal(await limiter.terminate("j1"), false);
    await limiter.stop();
    const ops = fake.requests().map((r) => r.op);
    assert.deepEqual(
      ops.filter((op) => op === "terminate" || op === "close"),
      ["terminate", "close"],
    );
    assert.equal(ops.includes("setRate"), false);
  });

  test("a failed create is logged and the job's later requests are skipped", async () => {
    const time = createFakeTime();
    const log = createFakeLog();
    const fake = createFakeHelper();
    const write = fake.helper.write;
    fake.helper.write = (line) => {
      write(line);
      const request = /** @type {{ id: number }} */ (JSON.parse(line));
      queueMicrotask(() =>
        fake.say(JSON.stringify({ id: request.id, ok: false, error: "CreateJobObject failed" })),
      );
    };
    fake.helper.end = () => queueMicrotask(() => fake.exit(0));
    const limiter = createCpuLimiter({
      platform: "win32",
      processors: 8,
      clock: time.clock,
      timers: time.timers,
      log,
      spawnHelper: () => {
        queueMicrotask(() => fake.say('{"ready":true}'));
        return fake.helper;
      },
      listTree: async () => [],
    });
    limiter.add("j1", { rootPid: 500, exempt: true });
    limiter.setBudget("j1", 2);
    await flush();
    await limiter.stop();
    assert.deepEqual(
      fake.requests().map((r) => r.op),
      ["create"],
    );
    assert.ok(log.lines.some((l) => l.message.includes("CreateJobObject failed")));
  });

  test("adding a key again closes the old job before creating the new one", async () => {
    const { fake, limiter } = setup();
    limiter.add("j1", { rootPid: 500, exempt: true });
    limiter.add("j1", { rootPid: 600, exempt: true });
    await limiter.stop();
    const ops = fake.requests().map((r) => r.op);
    assert.deepEqual(
      ops.filter((op) => op !== "assign"),
      ["create", "close", "create"],
    );
    assert.ok(ops.indexOf("close") < ops.lastIndexOf("create"));
  });
});

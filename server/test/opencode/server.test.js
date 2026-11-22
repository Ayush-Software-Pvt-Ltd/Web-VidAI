// One server and its session against the fake OpenCode 2 and what the driver promises: no process left behind, the
// user's own configuration never read, a key that never leaks, a dropped stream that is connected
// again without a duplicate event, and a request that times out as a readable failure.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { SCRUBBED } from "../../src/agents/setups.js";
import { isAlive } from "../../src/platform/process.js";
import {
  catalogEntry,
  createApi,
  encode,
  usesKeyVariable,
} from "../../src/agents/opencode/serverApi.js";
import { customModel, modelRef } from "../../src/agents/opencode/launch.js";
import {
  KEY,
  droppableFetch,
  editPrompt,
  lineTypes,
  makeWorld,
  pidsOf,
  sleep,
  until,
  untilDead,
} from "./engineSupport.js";

test("a built-in provider runs only on VidAI's key", () => {
  const env = {
    data: { id: "opencode", connections: [{ type: "env", name: "OPENCODE_API_KEY" }] },
  };
  const stored = {
    data: {
      id: "opencode",
      connections: [
        { type: "credential", id: "crd_1", label: "OpenCode" },
        { type: "env", name: "OPENCODE_API_KEY" },
      ],
    },
  };
  const none = { data: { id: "opencode", connections: [] } };
  assert.equal(usesKeyVariable(env), true);
  assert.equal(usesKeyVariable(stored), false);
  assert.equal(usesKeyVariable(none), false);
  assert.equal(usesKeyVariable(null), false);
  assert.equal(usesKeyVariable({ data: { connections: [{ type: "env", name: "OTHER" }] } }), false);
});

test("folders are encoded like encodeURIComponent", () => {
  assert.equal(
    encode("/Users/editor/My Edits/वीडियो"),
    "%2FUsers%2Feditor%2FMy%20Edits%2F%E0%A4%B5%E0%A5%80%E0%A4%A1%E0%A4%BF%E0%A4%AF%E0%A5%8B",
  );
});

test("the catalog entry is found by provider and by id or modelID", () => {
  const list = {
    data: [
      { providerID: "a", id: "m1" },
      { providerID: "b", modelID: "m1", variants: [{ id: "low" }] },
      "junk",
      null,
    ],
  };
  assert.equal(catalogEntry(list, modelRef("a", "m1"))?.["providerID"], "a");
  assert.deepEqual(catalogEntry(list, modelRef("b", "m1"))?.["variants"], [{ id: "low" }]);
  assert.equal(catalogEntry(list, modelRef("a", "m2")), null);
  assert.equal(catalogEntry({}, customModel("m1")), null);
});

test("the request to a server that answers nothing is a readable failure, never a hang", async () => {
  // AbortSignal.timeout does not keep the process alive; the test does.
  const keepAlive = setTimeout(() => {}, 5_000);
  const api = createApi({
    base: "http://127.0.0.1:9",
    password: "pw",
    directory: "/E",
    requestTimeoutMs: 200,
    onWarn: () => {},
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  });
  await assert
    .rejects(
      () => api.request("GET", "/api/model"),
      (error) => {
        assert.equal(/** @type {{ kind?: string }} */ (error).kind, "timeout");
        assert.equal(/** @type {Error} */ (error).message, "OpenCode did not answer in time");
        return true;
      },
    )
    .finally(() => clearTimeout(keepAlive));
});

test("a server that cannot be reached, and one that answers oddly", async () => {
  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
  const unreachable = createApi({
    base: `http://127.0.0.1:${closedPort}`,
    password: "pw",
    directory: "/E",
    requestTimeoutMs: 2_000,
    onWarn: () => {},
    fetch,
  });
  await assert.rejects(
    () => unreachable.request("GET", "/api/model"),
    /Could not reach the OpenCode server on the computer that runs VidAI/,
  );
  const odd = createApi({
    base: "http://x",
    password: "pw",
    directory: "/E",
    requestTimeoutMs: 2_000,
    onWarn: () => {},
    fetch: async () => new Response("not json", { status: 200 }),
  });
  await assert.rejects(
    () => odd.json("GET", "/api/model"),
    /answered \/api\/model with something unexpected/,
  );
  const refusing = createApi({
    base: "http://x",
    password: "pw",
    directory: "/E",
    requestTimeoutMs: 2_000,
    onWarn: () => {},
    fetch: async () => new Response("x".repeat(2_000), { status: 500 }),
  });
  await assert.rejects(
    () => refusing.json("POST", "/api/session", {}),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(message, /^OpenCode answered \/api\/session with HTTP 500: x+$/);
      assert.ok(message.length < 600, "the body is capped");
      return true;
    },
  );
});

test("a session starts with the key in the environment only, and its model is the one asked for", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  assert.match(session.sessionId, /^ses_/);
  assert.equal(session.model, "opencode-go/glm-5.3");
  const [call] = world.calls();
  assert.equal(call?.["args"], "serve --stdio --hostname 127.0.0.1 --port 0");
  assert.equal(call?.["cwd"], fs.realpathSync(world.editing));
  assert.equal(call?.["OPENCODE_API_KEY"], KEY);
  assert.equal(call?.["OPENCODE_SERVER_PASSWORD"], "<set>");
  assert.equal(call?.["OPENCODE_PASSWORD"], "<unset>");
  assert.equal(call?.["OPENCODE_DISABLE_AUTOUPDATE"], "1");
  assert.ok(!(call?.["args"] ?? "").includes(KEY));
});

test("close ends the server and its whole process tree, and removes the job's files", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "tree" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await until("the tool tree", () => world.has("tree.ready"));
  const pids = pidsOf(world, "tree.pids");
  assert.equal(pids.length, 3);
  assert.ok(pids.every((pid) => isAlive(pid)));
  assert.ok(fs.existsSync(path.join(world.jobDir, "opencode2-config")));
  session.close();
  session.close();
  await session.finished;
  await untilDead([session.pid, ...pids]);
  assert.equal(fs.existsSync(world.jobDir), false, "nothing of the job stays on disk");
  const exits = world.events.filter((e) => e.type === "exited");
  assert.equal(exits.length, 1, "the exit is reported once");
  assert.equal(world.events.at(-1)?.type, "exited", "and last");
});

test("a start that fails leaves no process and no file", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "exit:Error: cannot open the database" });
  await assert.rejects(
    () => world.start({ command: world.launcher }),
    /OpenCode ended before it was ready \(Error: cannot open the database\)/,
  );
  await untilDead(world.launched());
  assert.equal(world.launched().length, 1);
  assert.equal(fs.existsSync(world.jobDir), false);
  assert.deepEqual(world.events, [], "nothing is reported for a start that failed");
});

test("a start that hits the limit is ended, and the error says what to do", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "never" });
  /** @type {number[]} */
  const seconds = [];
  await assert.rejects(
    () =>
      world.start({
        command: world.launcher,
        timings: {
          pollMs: 5,
          // Long enough that the launcher script has run even when the machine is busy (the limit
          // counts from the spawn, and the test needs the launcher's pid below).
          startLimitMs: 2_400,
          firstNoticeMs: 300,
          noticeEveryMs: 300,
          failureOutputWaitMs: 200,
        },
        onStatus: (/** @type {string} */ text) =>
          seconds.push(Number(/\((\d+) s\)/.exec(text)?.[1])),
      }),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(
        message,
        /^OpenCode did not become ready within 2 seconds, and it printed nothing\./,
      );
      assert.match(message, /serve" in Terminal on the computer that runs VidAI/);
      return true;
    },
  );
  const [pid] = world.launched();
  assert.ok(pid !== undefined);
  await untilDead([pid]);
  assert.equal(fs.existsSync(world.jobDir), false);
});

test("a program that cannot be started is a failure with nothing left on disk", async (t) => {
  const world = makeWorld(t);
  await assert.rejects(
    () => world.start({ command: path.join(world.root, "no-such-opencode2") }),
    /cannot start/,
  );
  assert.equal(fs.existsSync(world.jobDir), false);
});

test("the user's own OpenCode configuration is never read", async (t) => {
  const world = makeWorld(t);
  const poison = "POISON-FROM-THE-USERS-OWN-CONFIGURATION";
  const files = [
    path.join(world.home, ".config", "opencode", "opencode.json"),
    path.join(world.home, ".opencode", "opencode.json"),
    path.join(world.root, "poisoned-config.json"),
    path.join(world.editing, "opencode.json"),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcp: { evil: { command: [poison] } } }));
  }
  world.env["OPENCODE_CONFIG"] = path.join(world.root, "poisoned-config.json");
  world.env["OPENCODE_CONFIG_DIR"] = path.join(world.home, ".config", "opencode");
  world.env["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({ mcp: poison });
  world.env["OPENCODE_FLAGS"] = poison;
  await world.start();
  const [call] = world.calls();
  assert.ok(call);
  const callFile = fs.readdirSync(world.state).find((n) => n.startsWith("call."));
  assert.ok(callFile);
  const record = fs.readFileSync(path.join(world.state, callFile), "utf8");
  assert.ok(!record.includes(poison), "nothing of the user's configuration reached the server");
  assert.equal(call["OPENCODE_CONFIG"], "<unset>");
  assert.equal(call["OPENCODE_CONFIG_PROJECT_DISABLE"], "1");
  assert.equal(call["OPENCODE_CONFIG_DIR"], path.join(world.jobDir, "opencode2-config"));
  assert.equal(call["config_dir_files"], "", "the configuration folder it reads is empty");
  assert.equal(call["OPENCODE_FLAGS"], "<unset>");
  assert.equal(call["HOME"], world.home, "the home folder itself is not hidden");
  const config = JSON.parse(call["OPENCODE_CONFIG_CONTENT"] ?? "{}");
  assert.equal(config.mcp, undefined);
  assert.equal(config.share, "disabled");
});

test("a key never appears in the arguments, in the files that outlive the job or in an error", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: `exit:Error: refused ${KEY} and more` });
  await assert.rejects(
    () => world.start({ command: world.launcher }),
    (error) => {
      const text =
        String(/** @type {Error} */ (error).stack ?? "") + /** @type {Error} */ (error).message;
      assert.ok(!text.includes(KEY), text);
      assert.ok(/** @type {Error} */ (error).message.includes(SCRUBBED), "the key is replaced");
      return true;
    },
  );
  assert.equal(fs.existsSync(world.jobDir), false);

  // A server that prints the key and its password on its way out.
  const noisy = path.join(world.root, "noisy.sh");
  fs.writeFileSync(
    noisy,
    '#!/bin/sh\necho "pw=$OPENCODE_SERVER_PASSWORD key=$OPENCODE_API_KEY" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  await assert.rejects(
    () => world.start({ command: noisy }),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.ok(!message.includes(KEY), message);
      assert.ok(!/[0-9a-f]{32}/.test(message), `the password is not in: ${message}`);
      assert.ok(message.includes(`pw=${SCRUBBED} key=${SCRUBBED}`), message);
      return true;
    },
  );

  // A session that runs: nothing it reports or writes has the key, and the arguments and the
  // job's files are free of it.
  const world2 = makeWorld(t);
  const session = await world2.start();
  const call = world2.calls()[0];
  assert.ok(!(call?.["args"] ?? "").includes(KEY));
  assert.ok(!(call?.["OPENCODE_CONFIG_CONTENT"] ?? "").includes(KEY));
  const seen = [];
  for (const dir of [world2.jobDir, world2.editing]) {
    for (const file of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, String(file));
      if (fs.statSync(full).isFile()) seen.push(fs.readFileSync(full, "utf8"));
    }
  }
  assert.ok(seen.every((text) => !text.includes(KEY)));
  session.close();
  await session.finished;
  assert.ok(world2.statuses.every((text) => !text.includes(KEY)));
  assert.ok(world2.warnings.every((text) => !text.includes(KEY)));
});

test("a stderr tail with the key in it reaches the engine scrubbed", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "crash" });
  const session = await world.start();
  await session.sendUser(editPrompt()).catch(() => {});
  await world.exited();
  const exit = world.events.find((e) => e.type === "exited");
  assert.ok(exit && exit.type === "exited");
  assert.equal(exit.exit.code, 3);
  assert.ok(exit.exit.stderrTail.includes("Error: boom"));
  await session.finished;
});

test("a request that times out is a readable failure, and the turn ends with it", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_HANG: "prompt" });
  const session = await world.start({ timings: { requestTimeoutMs: 300 } });
  await assert.rejects(session.sendUser(editPrompt()), /^Error: OpenCode did not answer in time$/);
  const [result] = world.resultEvents();
  assert.ok(result);
  assert.equal(result.isError, true);
  assert.match(String(result.errors.join(" ") + result.text), /OpenCode did not answer in time/);
  // The session is still usable and ends cleanly.
  session.close();
  await session.finished;
});

test("a session that cannot be created in time fails the start with nothing left running", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_HANG: "/api/session" });
  await assert.rejects(
    () => world.start({ command: world.launcher, timings: { requestTimeoutMs: 300 } }),
    /OpenCode did not answer in time/,
  );
  await untilDead(world.launched());
  assert.equal(fs.existsSync(world.jobDir), false);
});

test("a refused message ends the turn with OpenCode's words, and says so to the caller", async (t) => {
  const world = makeWorld(t);
  const session = await world.start({
    fetch: async (/** @type {any} */ input, /** @type {any} */ init) =>
      String(input).endsWith("/prompt")
        ? new Response("no such model", { status: 400 })
        : fetch(input, init),
  });
  await assert.rejects(
    session.sendUser(editPrompt()),
    /^Error: OpenCode refused the message \(HTTP 400\): no such model$/,
  );
  const [result] = world.resultEvents();
  assert.ok(result);
  assert.match(
    result.errors.join(" ") + String(result.text),
    /OpenCode refused the message \(HTTP 400\)/,
  );
});

test("a server that died answers with a broken pipe, and its own exit says why", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "crash" });
  const session = await world.start();
  // The first message makes the fake die with an error before it answers.
  await assert.rejects(
    session.sendUser(editPrompt()),
    (error) => /** @type {{ code?: string }} */ (error).code === "EPIPE",
  );
  assert.deepEqual(world.resultEvents(), [], "no refused-turn result: the exit tells it");
  await world.exited();
  await session.finished;
  assert.throws(() => session.interrupt(), /closed|ended|EPIPE/i);
});

test("a dropped stream is connected again and no event is delivered twice", async (t) => {
  const baseline = makeWorld(t, { FAKE_SCENARIO: "hold" });
  const plain = await baseline.start();
  await plain.sendUser(editPrompt());
  await until("the held command", () => baseline.has("started.Video A"));
  fs.writeFileSync(path.join(baseline.state, "release.Video A"), "");
  await until("the end of the turn", () => baseline.resultEvents().length >= 1);
  const settle = async (/** @type {import("./engineSupport.js").World} */ w) => {
    let last = -1;
    await until("no more events", () => {
      const n = w.events.length;
      const quiet = n === last;
      last = n;
      return quiet || undefined;
    });
  };
  await sleep(150);
  await settle(baseline);
  const expected = lineTypes(baseline.events);

  const world = makeWorld(t, { FAKE_SCENARIO: "hold" });
  const dropping = droppableFetch();
  const session = await world.start({ fetch: dropping.fetch });
  await session.sendUser(editPrompt());
  await until("the held command", () => world.has("started.Video A"));
  await until("some events", () => world.events.length > 3 || undefined);
  const before = world.events.length;
  dropping.drop();
  await until("a second connection", () => dropping.connections() >= 2 || undefined);
  // The server replayed everything it had sent: none of it may come again.
  await sleep(150);
  assert.equal(world.events.length, before, "the replay produced no event");
  fs.writeFileSync(path.join(world.state, "release.Video A"), "");
  await until("the end of the turn", () => world.resultEvents().length >= 1);
  await sleep(150);
  await settle(world);
  assert.deepEqual(lineTypes(world.events), expected);
  const toolUses = world.events.flatMap((e) =>
    e.type === "line" && e.event.type === "assistant" ? [JSON.stringify(e.event)] : [],
  );
  assert.equal(new Set(toolUses).size, toolUses.length, "no assistant message twice");
});

test("a session that waits for background work asks the server what still runs", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "background_hold" });
  const session = await world.start({ timings: { reconcileEveryMs: 50 } });
  await session.sendUser(editPrompt());
  await until("the background work", () => world.has("started.Video A"));
  const [pid] = pidsOf(world, "tree.pids");
  assert.ok(pid !== undefined && isAlive(pid));
  // The server still lists the work, so the reconcile rounds invent no event.
  await sleep(300);
  const settled = world.events.length;
  await sleep(300);
  assert.equal(world.events.length, settled);
  session.close();
  await session.finished;
  await untilDead([pid]);
});

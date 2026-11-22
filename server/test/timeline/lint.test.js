// `hyperframes lint` (docs/SPEC.md section 10): reading the pinned CLI's JSON, and running it.
// The fixtures are the real output of hyperframes 0.9.80, the project folder replaced by `<project>`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createLint,
  findHyperframesCli,
  LINT_TIMEOUT_MS,
  parseLintOutput,
} from "../../src/timeline/lint.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../support/fixtures/hyperframes-lint/", import.meta.url),
);
const PROJECTS = fileURLToPath(new URL("../support/fixtures/projects/", import.meta.url));

/** The recorded JSON with the placeholder replaced. @param {string} name @param {string} dir */
const recorded = (name, dir) =>
  fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8").replaceAll("<project>", dir);

test("the recorded answer for the long fixture gives one sentence per error", () => {
  const dir = "/work/video/output/001.hf";
  const { errors, problem } = parseLintOutput(recorded("long", dir), dir);
  assert.equal(problem, null);
  assert.equal(errors.length, 3);
  assert.match(errors[0] ?? "", /^HyperFrames lint, index\.html: <audio> element references/);
  assert.match(errors[0] ?? "", /Add the missing files to the project directory/);
  assert.equal(
    errors.some((e) => e.includes(dir)),
    false,
  );
  assert.ok(errors.every((e) => e.startsWith("HyperFrames lint, ")));
});

test("only errors count, warnings and infos do not", () => {
  const answer = JSON.stringify({
    findings: [
      { code: "a", severity: "warning", file: "/p/index.html", message: "Soft." },
      { code: "b", severity: "info", file: "/p/index.html", message: "Fyi." },
      {
        code: "c",
        severity: "error",
        file: "/p/compositions/x.html",
        line: 12,
        message: " Hard. ",
        fixHint: "Fix it.",
      },
      { code: "d", severity: "error", message: "No file." },
    ],
  });
  assert.deepEqual(parseLintOutput(answer, "/p"), {
    errors: [
      "HyperFrames lint, compositions/x.html line 12: Hard. Fix it.",
      "HyperFrames lint, No file.",
    ],
    problem: null,
  });
});

test("the recorded answer for a missing folder is a problem, never a violation", () => {
  const { errors, problem } = parseLintOutput(recorded("no-such-dir", "/gone"), "/gone");
  assert.deepEqual(errors, []);
  assert.match(problem ?? "", /Not a directory: \/gone/);
});

test("answers that are not what was expected are problems", () => {
  for (const text of ["", "not json", "null", "42", "{}", '{"findings":"x"}']) {
    const result = parseLintOutput(text, "/p");
    assert.deepEqual(result.errors, [], text);
    assert.equal(typeof result.problem, "string", text);
  }
});

test("createLint runs the CLI in the project with telemetry off and reads its answer", async () => {
  /** @type {any[]} */
  const calls = [];
  const lint = createLint({
    cli: "/cli/hyperframes.mjs",
    node: "/usr/bin/node",
    timeoutMs: 1234,
    env: { PATH: "/bin", HYPERFRAMES_NO_TELEMETRY: "0" },
    run: async (request) => {
      calls.push(request);
      return {
        code: 1,
        signal: null,
        stdout: recorded("short", "/p"),
        stderr: "",
        timedOut: false,
      };
    },
  });
  const result = await lint("/p");
  assert.equal(result.problem, null);
  assert.ok(result.errors.length >= 1);
  assert.deepEqual(calls[0].args, ["/cli/hyperframes.mjs", "lint", "/p", "--json"]);
  assert.equal(calls[0].command, "/usr/bin/node");
  assert.equal(calls[0].cwd, "/p");
  assert.equal(calls[0].timeoutMs, 1234);
  assert.deepEqual(
    [
      calls[0].env.PATH,
      calls[0].env.HYPERFRAMES_NO_TELEMETRY,
      calls[0].env.HYPERFRAMES_NO_UPDATE_CHECK,
    ],
    ["/bin", "1", "1"],
  );
  assert.equal(LINT_TIMEOUT_MS, 60_000);
});

test("a CLI that is missing, cannot start, times out or answers badly is a problem", async () => {
  const none = await createLint({ cli: null })("/p");
  assert.deepEqual([none.errors, /not installed/.test(none.problem ?? "")], [[], true]);

  const cannot = await createLint({
    cli: "/c.mjs",
    run: async () => {
      throw new Error("spawn ENOENT");
    },
  })("/p");
  assert.match(cannot.problem ?? "", /could not be started \(spawn ENOENT\)/);

  const slow = await createLint({
    cli: "/c.mjs",
    run: async () => ({ code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }),
  })("/p");
  assert.match(slow.problem ?? "", /did not finish in time/);

  const junk = await createLint({
    cli: "/c.mjs",
    run: async () => ({ code: 0, signal: null, stdout: "oops", stderr: "", timedOut: false }),
  })("/p");
  assert.match(
    junk.problem ?? "",
    /^The HyperFrames lint did not give an answer: its answer was not JSON\.$/,
  );
  assert.deepEqual(junk.errors, []);
});

test("the pinned CLI is found, and it runs for real on a fixture (skipped without it)", async (t) => {
  const cli = findHyperframesCli();
  if (cli === null || !fs.existsSync(cli)) {
    t.skip("the hyperframes package is not installed");
    return;
  }
  assert.match(cli, /hyperframes[\\/]bin[\\/]hyperframes\.mjs$/);
  const result = await createLint({ cli })(path.join(PROJECTS, "long"));
  assert.equal(result.problem, null);
  // The fixtures have no media files, so the real lint reports them missing.
  assert.ok(result.errors.some((e) => /not found in the project/.test(e)));
  const gone = await createLint({ cli })(path.join(PROJECTS, "no-such-folder"));
  assert.equal(gone.errors.length, 0);
  assert.equal(typeof gone.problem, "string");
});

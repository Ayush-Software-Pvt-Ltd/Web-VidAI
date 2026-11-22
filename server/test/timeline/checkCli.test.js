// The check the editing agent runs (docs/SPEC.md section 10): `node checkCli.js <folder>`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCheckCli } from "../../src/timeline/checkCli.js";
import { FIXTURES } from "./helpers.js";

const CLI = fileURLToPath(new URL("../../src/timeline/checkCli.js", import.meta.url));

/** A temporary folder with a copy of the long fixture and a fake lint script. */
function setup(/** @type {{ lintJson: unknown, exit?: number }} */ { lintJson, exit = 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-check-"));
  const project = path.join(root, "p.hf");
  fs.cpSync(path.join(FIXTURES, "long"), project, { recursive: true });
  const lint = path.join(root, "fake-lint.mjs");
  fs.writeFileSync(
    lint,
    `process.stdout.write(${JSON.stringify(JSON.stringify(lintJson))}); process.exit(${exit});\n`,
  );
  return { root, project, lint, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Runs the program from an unrelated working directory. */
function run(/** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const clean = { ok: true, findings: [] };

test("a fine project exits 0 and says so", () => {
  const s = setup({ lintJson: clean });
  try {
    const r = run([s.project], { VIDAI_HYPERFRAMES_BIN: s.lint });
    assert.deepEqual([r.code, r.out.trim()], [0, "The project is fine."]);
  } finally {
    s.cleanup();
  }
});

test("violations exit 1, one per line: profile first, then lint", () => {
  const s = setup({
    lintJson: {
      findings: [
        {
          code: "x",
          severity: "error",
          file: "index.html",
          line: 4,
          message: "Broken.",
          fixHint: "Mend it.",
        },
      ],
    },
    exit: 1,
  });
  try {
    fs.writeFileSync(
      path.join(s.project, "index.html"),
      fs
        .readFileSync(path.join(s.project, "index.html"), "utf8")
        .replace('data-duration="45"', 'data-duration="46"'),
    );
    const r = run([s.project], { VIDAI_HYPERFRAMES_BIN: s.lint });
    assert.equal(r.code, 1);
    const lines = r.out.trim().split("\n");
    assert.ok(lines.length >= 2);
    assert.equal(lines.at(-1), "HyperFrames lint, index.html line 4: Broken. Mend it.");
    assert.ok(lines.slice(0, -1).every((l) => !l.startsWith("HyperFrames lint")));
    assert.equal(r.err, "");
  } finally {
    s.cleanup();
  }
});

test("a wrong call exits 2", () => {
  const s = setup({ lintJson: clean });
  try {
    for (const args of [
      [],
      [s.project, "extra"],
      [path.join(s.root, "missing")],
      [path.join(s.project, "index.html")],
    ]) {
      const r = run(args, { VIDAI_HYPERFRAMES_BIN: s.lint });
      assert.equal(r.code, 2, JSON.stringify(args));
      assert.equal(r.out, "");
      assert.notEqual(r.err.trim(), "");
    }
  } finally {
    s.cleanup();
  }
});

test("a lint that cannot run leaves the profile verdict and a note on stderr", () => {
  const s = setup({
    lintJson: { error: { code: "runtime_error", message: "Broke." }, findings: [] },
  });
  try {
    const r = run([s.project], { VIDAI_HYPERFRAMES_BIN: s.lint });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), "The project is fine.");
    assert.match(r.err, /^Note: .*Broke\./);
  } finally {
    s.cleanup();
  }
});

test("runCheckCli takes its output and lint as arguments", async () => {
  const s = setup({ lintJson: clean });
  try {
    /** @type {string[]} */
    const out = [];
    const code = await runCheckCli([s.project], {
      write: (l) => void out.push(l),
      lint: async () => ({ errors: ["HyperFrames lint, a\nb"], problem: null }),
    });
    assert.deepEqual([code, out], [1, ["HyperFrames lint, a b"]]);
  } finally {
    s.cleanup();
  }
});

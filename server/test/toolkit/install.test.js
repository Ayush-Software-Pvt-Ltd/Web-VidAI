import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  installToolkit,
  isShipped,
  readVersion,
  realFs,
  requirementsHash,
  treeDigest,
} from "../../src/toolkit/install.js";
import { listFiles, tempDir, writeShippedToolkit } from "../support/fake-python.js";

/** A source and a target folder, both temporary. */
function setup() {
  const base = tempDir();
  const source = path.join(base.dir, "toolkit");
  const target = path.join(base.dir, "data", "toolkit");
  fs.mkdirSync(source, { recursive: true });
  return { ...base, source, target };
}

/** @param {string} file */
const read = (file) => fs.readFileSync(file, "utf8");

/**
 * File operations that throw on the n-th mutating call (a crash at that moment).
 * @param {number} failAt 1-based; Infinity never fails.
 * @param {string[]} [calls] Receives the names of the mutating calls made.
 * @returns {Partial<import("../../src/toolkit/install.js").InstallFs>}
 */
function crashAt(failAt, calls = []) {
  let n = 0;
  /** @param {string} name */
  const tick = (name, /** @type {string} */ detail) => {
    n += 1;
    if (n >= failAt) throw new Error(`crash at call ${n}: ${name} ${detail}`);
    calls.push(`${name} ${path.basename(detail)}`);
  };
  return {
    copyTree: (from, to, filter) => {
      tick("copyTree", to);
      realFs.copyTree(from, to, filter);
    },
    rename: (from, to) => {
      tick("rename", `${from}->${to}`);
      realFs.rename(from, to);
    },
    remove: (target) => {
      tick("remove", target);
      realFs.remove(target);
    },
    writeText: (file, text) => {
      tick("writeText", file);
      realFs.writeText(file, text);
    },
  };
}

test("a fresh install copies the programs, the rules, the lessons and the version, nothing else", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source, { version: "1.0.0" });
    const result = installToolkit({ source: t.source, target: t.target });
    assert.deepEqual(result, {
      action: "installed",
      from: null,
      to: "1.0.0",
      swapped: true,
      keptPrevious: false,
    });
    assert.deepEqual(listFiles(t.target), [
      "CLAUDE.md",
      "CLAUDE_VE_ALL/requirements.txt",
      "CLAUDE_VE_ALL/ve.py",
      "CLAUDE_VE_ALL/vekit/marker.py",
      "MEMORY.md",
      "VERSION",
    ]);
    assert.equal(read(path.join(t.target, "MEMORY.md")), "# shipped lessons\n");
    assert.equal(readVersion(path.join(t.target, "VERSION")), "1.0.0");
  } finally {
    t.cleanup();
  }
});

test("the version marker is written last", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source);
    /** @type {string[]} */
    const calls = [];
    installToolkit({ source: t.source, target: t.target, fs: crashAt(Infinity, calls) });
    // The last thing done is moving the finished version file into place.
    assert.equal(calls.at(-1), "rename VERSION");
    const writes = calls.filter((c) => c.startsWith("writeText"));
    assert.match(writes.at(-1) ?? "", /VERSION\.new/);
    assert.ok(calls.indexOf("rename CLAUDE_VE_ALL") < calls.indexOf(/** @type {string} */ (writes.at(-1))));
  } finally {
    t.cleanup();
  }
});

test("an installed toolkit of the same version is left alone", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source);
    installToolkit({ source: t.source, target: t.target });
    /** @type {string[]} */
    const calls = [];
    const result = installToolkit({ source: t.source, target: t.target, fs: crashAt(Infinity, calls) });
    assert.equal(result.action, "current");
    assert.deepEqual(calls, []);
  } finally {
    t.cleanup();
  }
});

test("an upgrade keeps the old programs once as .previous, replacing an older .previous", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source, { version: "1.0.0", marker: "one" });
    installToolkit({ source: t.source, target: t.target });
    fs.rmSync(t.source, { recursive: true });
    writeShippedToolkit(t.source, { version: "2.0.0", marker: "two" });
    const second = installToolkit({ source: t.source, target: t.target });
    assert.equal(second.action, "upgraded");
    assert.equal(second.from, "1.0.0");
    assert.equal(second.keptPrevious, true);
    const marker = (/** @type {string} */ dir) => read(path.join(t.target, dir, "vekit", "marker.py"));
    assert.match(marker("CLAUDE_VE_ALL"), /two/);
    assert.match(marker("CLAUDE_VE_ALL.previous"), /one/);
    assert.match(read(path.join(t.target, "CLAUDE.md")), /rules two/);

    fs.rmSync(t.source, { recursive: true });
    writeShippedToolkit(t.source, { version: "3.0.0", marker: "three" });
    installToolkit({ source: t.source, target: t.target });
    assert.match(marker("CLAUDE_VE_ALL"), /three/);
    assert.match(marker("CLAUDE_VE_ALL.previous"), /two/);
    assert.equal(readVersion(path.join(t.target, "VERSION")), "3.0.0");
  } finally {
    t.cleanup();
  }
});

test("MEMORY.md is created only when missing and never overwritten", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source, { version: "1.0.0", memory: "# shipped one\n" });
    installToolkit({ source: t.source, target: t.target });
    const memory = path.join(t.target, "MEMORY.md");
    fs.appendFileSync(memory, "- lesson learned by an agent\n");
    fs.rmSync(t.source, { recursive: true });
    writeShippedToolkit(t.source, { version: "2.0.0", memory: "# shipped two\n" });
    installToolkit({ source: t.source, target: t.target });
    assert.equal(read(memory), "# shipped one\n- lesson learned by an agent\n");
    fs.rmSync(memory);
    // Missing again (version unchanged): created from the shipped one.
    installToolkit({ source: t.source, target: t.target });
    assert.equal(read(memory), "# shipped two\n");
  } finally {
    t.cleanup();
  }
});

test("a shipped toolkit without MEMORY.md gets an empty lessons heading", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source, { memory: null });
    installToolkit({ source: t.source, target: t.target });
    assert.equal(read(path.join(t.target, "MEMORY.md")), "# Lessons\n");
  } finally {
    t.cleanup();
  }
});

test("a crash at any point of a first install is finished by the next start", () => {
  let crashes = 0;
  for (let n = 1; n < 40; n++) {
    const t = setup();
    try {
      writeShippedToolkit(t.source, { version: "1.0.0", marker: "one" });
      let crashed = false;
      try {
        installToolkit({ source: t.source, target: t.target, fs: crashAt(n) });
      } catch (error) {
        crashed = true;
        assert.match(String(error), /crash at call/);
      }
      if (!crashed) {
        assert.ok(crashes > 3, "the install made too few steps to test");
        return;
      }
      crashes += 1;
      installToolkit({ source: t.source, target: t.target });
      assert.equal(readVersion(path.join(t.target, "VERSION")), "1.0.0", `crash ${n}`);
      assert.match(read(path.join(t.target, "CLAUDE_VE_ALL", "vekit", "marker.py")), /one/);
      assert.ok(fs.existsSync(path.join(t.target, "CLAUDE.md")), `crash ${n}`);
      assert.ok(fs.existsSync(path.join(t.target, "MEMORY.md")), `crash ${n}`);
      assert.deepEqual(
        fs.readdirSync(t.target).filter((name) => name.includes(".new-")),
        [],
        `crash ${n}: temporary names are cleaned up`,
      );
    } finally {
      t.cleanup();
    }
  }
  assert.fail("the install never finished without a crash");
});

test("a crash at any point of an upgrade leaves a usable toolkit and the next start finishes", () => {
  let crashes = 0;
  for (let n = 1; n < 60; n++) {
    const t = setup();
    try {
      writeShippedToolkit(t.source, { version: "1.0.0", marker: "one" });
      installToolkit({ source: t.source, target: t.target });
      fs.appendFileSync(path.join(t.target, "MEMORY.md"), "- kept\n");
      fs.rmSync(t.source, { recursive: true });
      writeShippedToolkit(t.source, { version: "2.0.0", marker: "two" });
      const folder = path.join(t.target, "CLAUDE_VE_ALL");
      const previous = path.join(t.target, "CLAUDE_VE_ALL.previous");
      let crashed = false;
      try {
        installToolkit({ source: t.source, target: t.target, fs: crashAt(n) });
      } catch {
        crashed = true;
      }
      if (!crashed) {
        assert.ok(crashes > 5, "the upgrade made too few steps to test");
        return;
      }
      crashes += 1;
      // Either toolkit is complete: in place, or (between the two renames) as .previous, which the
      // next start puts back first.
      assert.ok(
        fs.existsSync(path.join(folder, "ve.py")) || fs.existsSync(path.join(previous, "ve.py")),
        `crash ${n}: a complete toolkit exists`,
      );
      // A second crash during the recovery changes nothing either.
      try {
        installToolkit({ source: t.source, target: t.target, fs: crashAt(2) });
      } catch {
        // expected, or it simply finished
      }
      installToolkit({ source: t.source, target: t.target });
      assert.equal(readVersion(path.join(t.target, "VERSION")), "2.0.0", `crash ${n}`);
      assert.match(read(path.join(folder, "vekit", "marker.py")), /two/, `crash ${n}`);
      assert.match(read(path.join(t.target, "CLAUDE.md")), /rules two/, `crash ${n}`);
      assert.match(read(path.join(t.target, "MEMORY.md")), /- kept/, `crash ${n}`);
      assert.match(
        read(path.join(previous, "vekit", "marker.py")),
        /one/,
        `crash ${n}: the old programs are still the previous ones`,
      );
    } finally {
      t.cleanup();
    }
  }
  assert.fail("the upgrade never finished without a crash");
});

test("temporary leftovers of a crash are removed on the next start", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source);
    installToolkit({ source: t.source, target: t.target });
    fs.mkdirSync(path.join(t.target, ".CLAUDE_VE_ALL.new-dead"));
    fs.writeFileSync(path.join(t.target, ".CLAUDE.md.new-dead"), "x");
    installToolkit({ source: t.source, target: t.target });
    assert.deepEqual(fs.readdirSync(t.target).filter((n) => n.includes(".new-")), []);
  } finally {
    t.cleanup();
  }
});

test("a missing CLAUDE_VE_ALL with the right version is installed again", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source);
    installToolkit({ source: t.source, target: t.target });
    fs.rmSync(path.join(t.target, "CLAUDE_VE_ALL"), { recursive: true });
    const result = installToolkit({ source: t.source, target: t.target });
    assert.equal(result.action, "repaired");
    assert.ok(fs.existsSync(path.join(t.target, "CLAUDE_VE_ALL", "ve.py")));
  } finally {
    t.cleanup();
  }
});

test("a toolkit that is missing from the repository is a plain sentence, and nothing is touched", () => {
  const t = setup();
  try {
    assert.throws(
      () => installToolkit({ source: t.source, target: t.target }),
      /missing or incomplete/,
    );
    assert.equal(fs.existsSync(t.target), false);
  } finally {
    t.cleanup();
  }
});

test("pycache, bytecode and editor leftovers are never shipped", () => {
  assert.equal(isShipped("/x/__pycache__"), false);
  assert.equal(isShipped("/x/a.pyc"), false);
  assert.equal(isShipped("/x/.DS_Store"), false);
  assert.equal(isShipped("/x/ve.py"), true);
});

test("the tree digest sees names and contents but not bytecode", () => {
  const t = setup();
  try {
    writeShippedToolkit(t.source);
    const folder = path.join(t.source, "CLAUDE_VE_ALL");
    const before = treeDigest(folder);
    fs.writeFileSync(path.join(folder, "vekit", "__pycache__", "other.pyc"), "more bytecode");
    assert.equal(treeDigest(folder), before);
    fs.writeFileSync(path.join(folder, "vekit", "marker.py"), "changed\n");
    assert.notEqual(treeDigest(folder), before);
    assert.equal(treeDigest(path.join(t.source, "nothing")), null);
  } finally {
    t.cleanup();
  }
});

test("the requirements hash ignores the line ending style", () => {
  const t = setup();
  try {
    const unix = path.join(t.dir, "unix.txt");
    const windows = path.join(t.dir, "windows.txt");
    fs.writeFileSync(unix, "numpy>=1\npillow\n");
    fs.writeFileSync(windows, "numpy>=1\r\npillow\r\n");
    assert.equal(requirementsHash(unix), requirementsHash(windows));
    assert.equal(requirementsHash(path.join(t.dir, "missing.txt")), null);
  } finally {
    t.cleanup();
  }
});

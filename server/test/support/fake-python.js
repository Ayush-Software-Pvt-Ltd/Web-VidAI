// Helpers for the toolkit tests: a stand-in `toolkit/` folder to install from and the stand-in
// Python (`fake-python.sh`, POSIX only: the tests that use it are skipped on Windows).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The stand-in Python script. */
export const FAKE_PYTHON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-python.sh",
);

/** Whether the stand-in Python can run here. */
export const CAN_RUN_FAKE_PYTHON = process.platform !== "win32";

/**
 * A fresh temporary directory, removed by the returned `cleanup`.
 * @param {string} [prefix]
 * @returns {{ dir: string, cleanup(): void }}
 */
export function tempDir(prefix = "vidai-toolkit-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Writes a stand-in repository `toolkit/` folder.
 * @param {string} dir
 * @param {{ version?: string, requirements?: string, marker?: string, memory?: string | null }} [options]
 *   `marker` is written into `vekit/marker.py` so two builds can be told apart.
 */
export function writeShippedToolkit(
  dir,
  {
    version = "1.0.0",
    requirements = "numpy>=1\n",
    marker = "one",
    memory = "# shipped lessons\n",
  } = {},
) {
  const all = path.join(dir, "CLAUDE_VE_ALL");
  fs.mkdirSync(path.join(all, "vekit", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(all, "ve.py"), "# the driver\n");
  fs.writeFileSync(path.join(all, "requirements.txt"), requirements);
  fs.writeFileSync(path.join(all, "vekit", "marker.py"), `MARKER = "${marker}"\n`);
  fs.writeFileSync(path.join(all, "vekit", "__pycache__", "marker.cpython-312.pyc"), "bytecode");
  fs.writeFileSync(path.join(all, "vekit", "stale.pyc"), "bytecode");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), `# rules ${marker}\n`);
  if (memory !== null) fs.writeFileSync(path.join(dir, "MEMORY.md"), memory);
  fs.writeFileSync(path.join(dir, "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(dir, "default_prompt.md"), "prompt\n");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "test_x.py"), "# tests\n");
}

/**
 * Every file of a folder as sorted relative paths with `/`.
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} current @param {string} rel */
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const here = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), here);
      else out.push(here);
    }
  };
  walk(dir, "");
  return out.sort();
}

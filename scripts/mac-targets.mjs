// The Mac build targets of VidAI, shared by scripts/bundle-mac.mjs and scripts/e2e.mjs.
//
// Tauri builds for one target triple at a time. `universal-apple-darwin` is Tauri's own name for
// a bundle whose binaries hold both architectures: it runs cargo for both triples and joins the
// results with lipo. With `--target`, cargo and Tauri put everything under
// src-tauri/target/<triple>/<profile>/ instead of src-tauri/target/<profile>/.
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * @typedef {object} MacTarget
 * @property {string} triple Tauri / cargo target triple.
 * @property {string} label What people call it.
 * @property {string[]} archs The architectures `lipo -archs` reports for its binaries, sorted.
 * @property {string[]} rustTargets The Rust standard libraries it needs (`rustup target add`).
 * @property {string} dmgSuffix The architecture part of the .dmg name Tauri writes.
 */

/** @type {Record<string, MacTarget>} */
export const MAC_TARGETS = {
  universal: {
    triple: "universal-apple-darwin",
    label: "Apple Silicon and Intel (universal)",
    archs: ["arm64", "x86_64"],
    rustTargets: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
    dmgSuffix: "universal",
  },
  arm64: {
    triple: "aarch64-apple-darwin",
    label: "Apple Silicon",
    archs: ["arm64"],
    rustTargets: ["aarch64-apple-darwin"],
    dmgSuffix: "aarch64",
  },
  x64: {
    triple: "x86_64-apple-darwin",
    label: "Intel",
    archs: ["x86_64"],
    rustTargets: ["x86_64-apple-darwin"],
    dmgSuffix: "x64",
  },
};

/**
 * The target for a name (`universal`, `arm64`, `x64`) or a triple, or `null`.
 * @param {string} name
 */
export function macTarget(name) {
  return MAC_TARGETS[name] ?? Object.values(MAC_TARGETS).find((t) => t.triple === name) ?? null;
}

/**
 * The folder Tauri writes bundles to for this target and profile.
 * @param {MacTarget} target
 * @param {"debug" | "release"} profile
 */
export function bundleDir(target, profile) {
  return path.join(root, "src-tauri", "target", target.triple, profile, "bundle");
}

/**
 * The architectures of a Mach-O file, sorted (for example `["arm64", "x86_64"]`).
 * @param {string} file
 */
export async function archsOf(file) {
  const { stdout } = await execFile("lipo", ["-archs", file]);
  return stdout.trim().split(/\s+/).sort();
}

/**
 * Throws with the command to run when a Rust standard library the target needs is missing.
 * Without rustup (Rust from another source) there is nothing to check; cargo reports it then.
 * @param {MacTarget} target
 */
export async function checkRustTargets(target) {
  let installed;
  try {
    installed = (await execFile("rustup", ["target", "list", "--installed"])).stdout.split("\n");
  } catch {
    return;
  }
  const missing = target.rustTargets.filter((t) => !installed.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `the Rust target ${missing.join(" and ")} is not installed; run: rustup target add ${missing.join(" ")}`,
    );
  }
}

/** Whether this Mac can run Intel (x86_64) programs: an Intel Mac, or Rosetta 2 installed. */
export async function canRunIntel() {
  try {
    await execFile("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    return true;
  } catch {
    return false;
  }
}

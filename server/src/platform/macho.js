// Whether a program file can run on this Mac's processor (docs/SPEC.md section 5,
// "Harness, program and model").
//
// A Mac can hold programs built for the other processor: a home folder or `/usr/local` copied
// from an Intel Mac to an Apple Silicon Mac (Migration Assistant), or the other way round, or a
// download of the wrong build. An Intel Mac cannot run an `arm64`-only program at all ("Bad CPU
// type in executable"), and an Apple Silicon Mac runs an `x86_64`-only program only when Rosetta
// 2 is installed (otherwise macOS offers to install it in a dialog). Program lookups skip such a
// file and go on to the next candidate, as `which` would if the file were not there.
//
// Only the Mach-O header is read (the first bytes of the file). Anything that is not a Mach-O
// file (a `#!` script, an npm shim) or cannot be read counts as runnable: the kernel decides.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** `CPU_TYPE_X86_64` of `<mach/machine.h>`. */
export const CPU_X86_64 = 0x0100_0007;
/** `CPU_TYPE_ARM64` (arm64 and arm64e) of `<mach/machine.h>`. */
export const CPU_ARM64 = 0x0100_000c;

/** Where Rosetta 2 keeps its runtime once it is installed. */
const ROSETTA_RUNTIME = "/Library/Apple/usr/libexec/oah/libRosettaRuntime";

/** How many header bytes are read: enough for the slice list of a universal file. */
const HEADER_BYTES = 4096;

/**
 * The CPU types of the slices of a Mach-O file from its first bytes, or `null` when the bytes
 * are not the start of a Mach-O file (or are cut off before the slice list ends). A thin file
 * has one slice, a universal ("fat") file one per architecture.
 * @param {Uint8Array} header
 * @returns {number[] | null}
 */
export function cpuTypes(header) {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  /**
   * @param {number} at
   * @param {boolean} bigEndian
   * @returns {number | null}
   */
  const word = (at, bigEndian) => (at + 4 <= header.length ? view.getUint32(at, !bigEndian) : null);
  const magic = word(0, true);
  switch (magic) {
    // A thin file in the byte order of the machine it was built for (every Mac is little
    // endian): the CPU type follows the magic.
    case 0xcffa_edfe:
    case 0xcefa_edfe: {
      const cpu = word(4, false);
      return cpu === null ? null : [cpu];
    }
    // A universal file: big-endian header, then `fat_arch` (20 bytes) or `fat_arch_64`
    // (32 bytes) entries that start with the CPU type. Java class files share 0xCAFEBABE;
    // their next word is a version number far above any real slice count.
    case 0xcafe_babe:
    case 0xcafe_babf: {
      const count = word(4, true);
      if (count === null || count === 0 || count > 30) return null;
      const size = magic === 0xcafe_babe ? 20 : 32;
      /** @type {number[]} */
      const cpus = [];
      for (let i = 0; i < count; i += 1) {
        const cpu = word(8 + i * size, true);
        if (cpu === null) return null;
        cpus.push(cpu);
      }
      return cpus;
    }
    default:
      return null;
  }
}

/**
 * Whether a program with slices for `cpus` runs on this hardware: Apple Silicon runs `arm64`
 * natively and `x86_64` only with Rosetta 2; an Intel Mac runs `x86_64` only.
 * @param {readonly number[]} cpus
 * @param {boolean} appleSilicon
 * @param {boolean} rosetta
 * @returns {boolean}
 */
export function runsOn(cpus, appleSilicon, rosetta) {
  const has = (/** @type {number} */ cpu) => cpus.includes(cpu);
  if (appleSilicon) return has(CPU_ARM64) || (rosetta && has(CPU_X86_64));
  return has(CPU_X86_64);
}

/**
 * Whether the program file `file` can run on a Mac of the given kind; `rosetta` is asked only
 * when it matters. True for anything that is not a Mach-O file and for a file that cannot be
 * read.
 * @param {string} file
 * @param {boolean} appleSilicon
 * @param {() => boolean} rosetta
 * @returns {boolean}
 */
export function fileRunsOn(file, appleSilicon, rosetta) {
  /** @type {Buffer} */
  let header;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      let filled = 0;
      while (filled < HEADER_BYTES) {
        const read = fs.readSync(fd, buffer, filled, HEADER_BYTES - filled, filled);
        if (read === 0) break;
        filled += read;
      }
      header = buffer.subarray(0, filled);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
  const cpus = cpuTypes(header);
  if (cpus === null) return true;
  // Rosetta 2 matters only for an x86_64 program that has no arm64 slice on Apple Silicon.
  const needsRosetta = appleSilicon && cpus.includes(CPU_X86_64) && !cpus.includes(CPU_ARM64);
  return runsOn(cpus, appleSilicon, needsRosetta && rosetta());
}

/**
 * Whether Rosetta 2 is installed (only asked on Apple Silicon).
 * @returns {boolean}
 */
export function rosettaInstalled() {
  return fs.existsSync(ROSETTA_RUNTIME);
}

/**
 * Whether the hardware is an Apple Silicon Mac. A Node.js built for Intel can run on Apple
 * Silicon under Rosetta 2 and then reports `x64`, so the hardware is asked as well.
 * @param {{ platform: NodeJS.Platform, arch: string }} machine What `process.platform` and
 *   `process.arch` say.
 * @returns {boolean}
 */
export function isAppleSilicon({ platform, arch }) {
  if (platform !== "darwin") return false;
  if (arch === "arm64") return true;
  try {
    const answer = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return answer.trim() === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the program file `file` can run on this computer. True for anything that is not a
 * Mach-O file, for a file that cannot be read, and on every system but macOS.
 * @param {string} file
 * @param {{ platform?: NodeJS.Platform, appleSilicon?: boolean }} [machine] The computer, for
 *   tests (default: this one).
 * @returns {boolean}
 */
export function runsHere(file, machine = {}) {
  const platform = machine.platform ?? process.platform;
  if (platform !== "darwin") return true;
  const appleSilicon = machine.appleSilicon ?? isAppleSilicon({ platform, arch: process.arch });
  return fileRunsOn(file, appleSilicon, rosettaInstalled);
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  CPU_ARM64,
  CPU_X86_64,
  cpuTypes,
  fileRunsOn,
  isAppleSilicon,
  runsHere,
  runsOn,
} from "../../src/platform/macho.js";

/** A thin little-endian 64-bit Mach-O header. @param {number} cpu */
function thin(cpu) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeed_facf, 0);
  buffer.writeUInt32LE(cpu, 4);
  return buffer;
}

/**
 * A universal file header with the given slices.
 * @param {number[]} cpus
 * @param {boolean} [wide] fat_arch_64
 */
function fat(cpus, wide = false) {
  const size = wide ? 32 : 20;
  const buffer = Buffer.alloc(8 + cpus.length * size);
  buffer.writeUInt32BE(wide ? 0xcafe_babf : 0xcafe_babe, 0);
  buffer.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, i) => buffer.writeUInt32BE(cpu, 8 + i * size));
  return buffer;
}

/** @type {string[]} */
const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-macho-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("cpuTypes", () => {
  test("reads thin files of both processors, 32 and 64 bit", () => {
    assert.deepEqual(cpuTypes(thin(CPU_X86_64)), [CPU_X86_64]);
    assert.deepEqual(cpuTypes(thin(CPU_ARM64)), [CPU_ARM64]);
    const small = Buffer.alloc(8);
    small.writeUInt32LE(0xfeed_face, 0);
    small.writeUInt32LE(7, 4);
    assert.deepEqual(cpuTypes(small), [7]);
  });

  test("reads the slices of universal files", () => {
    assert.deepEqual(cpuTypes(fat([CPU_X86_64, CPU_ARM64])), [CPU_X86_64, CPU_ARM64]);
    assert.deepEqual(cpuTypes(fat([CPU_ARM64], true)), [CPU_ARM64]);
    assert.deepEqual(cpuTypes(fat([CPU_X86_64, CPU_ARM64], true)), [CPU_X86_64, CPU_ARM64]);
  });

  test("anything else is not a Mach-O file", () => {
    assert.equal(cpuTypes(Buffer.from("#!/bin/sh\necho\n")), null);
    assert.equal(cpuTypes(Buffer.alloc(0)), null);
    assert.equal(cpuTypes(Buffer.from([0xcf, 0xfa])), null);
    // A thin header cut off before the CPU type.
    assert.equal(cpuTypes(thin(CPU_ARM64).subarray(0, 6)), null);
    // A universal header cut off in the slice list.
    assert.equal(cpuTypes(fat([CPU_X86_64, CPU_ARM64]).subarray(0, 30)), null);
    // A Java class file shares the universal magic; its "slice count" is a version number.
    const java = Buffer.alloc(16);
    java.writeUInt32BE(0xcafe_babe, 0);
    java.writeUInt32BE(52, 4);
    assert.equal(cpuTypes(java), null);
    const empty = Buffer.alloc(16);
    empty.writeUInt32BE(0xcafe_babe, 0);
    assert.equal(cpuTypes(empty), null);
  });

  test("works on a view into a bigger buffer", () => {
    const big = Buffer.concat([Buffer.alloc(10, 1), thin(CPU_ARM64)]);
    assert.deepEqual(cpuTypes(big.subarray(10)), [CPU_ARM64]);
  });
});

describe("runsOn", () => {
  test("Apple Silicon runs arm64, and x86_64 only with Rosetta 2", () => {
    assert.equal(runsOn([CPU_ARM64], true, false), true);
    assert.equal(runsOn([CPU_X86_64], true, false), false);
    assert.equal(runsOn([CPU_X86_64], true, true), true);
    assert.equal(runsOn([CPU_X86_64, CPU_ARM64], true, false), true);
  });

  test("an Intel Mac runs x86_64 only", () => {
    assert.equal(runsOn([CPU_X86_64], false, false), true);
    assert.equal(runsOn([CPU_ARM64], false, false), false);
    assert.equal(runsOn([CPU_ARM64], false, true), false);
    assert.equal(runsOn([CPU_X86_64, CPU_ARM64], false, false), true);
  });
});

describe("fileRunsOn", () => {
  /** @param {string} name @param {Buffer | string} content */
  function write(name, content) {
    const file = path.join(tempDir(), name);
    fs.writeFileSync(file, content);
    return file;
  }

  test("reads the header of real files", () => {
    const x86 = write("x86", thin(CPU_X86_64));
    const arm = write("arm", thin(CPU_ARM64));
    assert.equal(
      fileRunsOn(x86, true, () => false),
      false,
    );
    assert.equal(
      fileRunsOn(x86, true, () => true),
      true,
    );
    assert.equal(
      fileRunsOn(x86, false, () => false),
      true,
    );
    assert.equal(
      fileRunsOn(arm, true, () => false),
      true,
    );
    assert.equal(
      fileRunsOn(arm, false, () => true),
      false,
    );
  });

  test("scripts, unreadable files and missing files count as runnable", () => {
    const script = write("script", "#!/bin/sh\necho hi\n");
    assert.equal(
      fileRunsOn(script, false, () => false),
      true,
    );
    assert.equal(
      fileRunsOn(path.join(tempDir(), "missing"), true, () => false),
      true,
    );
    assert.equal(
      fileRunsOn(tempDir(), true, () => false),
      true,
    );
  });

  test("asks about Rosetta only when it matters", () => {
    let asked = 0;
    const rosetta = () => {
      asked += 1;
      return true;
    };
    fileRunsOn(write("arm", thin(CPU_ARM64)), true, rosetta);
    fileRunsOn(write("x86", thin(CPU_X86_64)), false, rosetta);
    fileRunsOn(write("script", "#!/bin/sh\n"), true, rosetta);
    assert.equal(asked, 0);
    fileRunsOn(write("x86b", thin(CPU_X86_64)), true, rosetta);
    assert.equal(asked, 1);
  });
});

describe("the machine", () => {
  test("runsHere is true everywhere but on macOS", () => {
    const arm = path.join(tempDir(), "arm");
    fs.writeFileSync(arm, thin(CPU_ARM64));
    assert.equal(runsHere(arm, { platform: "linux" }), true);
    assert.equal(runsHere(arm, { platform: "win32" }), true);
  });

  test("runsHere on a Mac depends on the processor", () => {
    const arm = path.join(tempDir(), "arm");
    fs.writeFileSync(arm, thin(CPU_ARM64));
    assert.equal(runsHere(arm, { platform: "darwin", appleSilicon: true }), true);
    assert.equal(runsHere(arm, { platform: "darwin", appleSilicon: false }), false);
  });

  test("isAppleSilicon trusts arm64 and is false off macOS", () => {
    assert.equal(isAppleSilicon({ platform: "darwin", arch: "arm64" }), true);
    assert.equal(isAppleSilicon({ platform: "linux", arch: "arm64" }), false);
    assert.equal(isAppleSilicon({ platform: "win32", arch: "x64" }), false);
  });
});

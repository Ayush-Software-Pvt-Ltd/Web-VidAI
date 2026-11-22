import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  existingFolder,
  freeBytes,
  parseDf,
  parsePowerShellFree,
  windowsFreeCommand,
} from "../../src/platform/disk.js";

describe("df output", () => {
  it("reads the Available column in 1024-byte blocks", () => {
    const out =
      "Filesystem 1024-blocks      Used Available Capacity Mounted on\n" +
      "/dev/disk3s5   971350180 800000000 123456 88% /System/Volumes/Data\n";
    assert.equal(parseDf(out), 123456 * 1024);
  });
  it("copes with a file system name that holds spaces", () => {
    const out =
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
      "//user@nas/My Share 1000 400 600 40% /Volumes/My Share\n";
    assert.equal(parseDf(out), 600 * 1024);
  });
  it("gives null for anything else", () => {
    assert.equal(parseDf(""), null);
    assert.equal(parseDf("Filesystem only\n"), null);
    assert.equal(parseDf("Header\nno percent here 1 2 3\n"), null);
  });
});

describe("Windows free space", () => {
  it("asks PowerShell about the drive letter", () => {
    const plan = windowsFreeCommand("D:\\VidAI\\cache\\render");
    assert.equal(plan?.command, "powershell.exe");
    assert.equal(plan?.args.at(-1), "(Get-PSDrive -Name D -PSProvider FileSystem).Free");
    assert.ok(plan?.args.includes("-NoProfile"));
  });
  it("has no plan for a network path", () => {
    assert.equal(windowsFreeCommand("\\\\server\\share\\cache"), null);
  });
  it("reads the number it prints", () => {
    assert.equal(parsePowerShellFree("123456789012\r\n"), 123456789012);
    assert.equal(parsePowerShellFree("\r\n"), null);
    assert.equal(parsePowerShellFree("1.5E+11"), null);
  });
});

describe("freeBytes", () => {
  it("answers for a folder that does not exist yet by asking its parent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-disk-"));
    try {
      const missing = path.join(dir, "cache", "render");
      assert.equal(existingFolder(missing), path.resolve(dir));
      const bytes = await freeBytes(missing);
      assert.ok(Number.isFinite(bytes) && bytes > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

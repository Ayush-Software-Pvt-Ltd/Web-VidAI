import { test } from "node:test";
import assert from "node:assert/strict";
import { SMI_ARGS, detectNvidia, parseGpuNames, smiCandidates } from "../../src/platform/nvidia.js";

test("nvidia-smi's list is one GPU name per line, noise dropped", () => {
  assert.deepEqual(parseGpuNames("NVIDIA GeForce RTX 5060 Ti\r\nNVIDIA T400  4GB\r\n\r\n"), [
    "NVIDIA GeForce RTX 5060 Ti",
    "NVIDIA T400 4GB",
  ]);
  assert.deepEqual(
    parseGpuNames("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."),
    [],
  );
  assert.deepEqual(parseGpuNames("No devices were found"), []);
  assert.deepEqual(parseGpuNames(null), []);
});

test("where nvidia-smi is looked for, by platform", () => {
  const win = smiCandidates({ SystemRoot: "D:\\Win", ProgramFiles: "D:\\PF" }, "win32");
  assert.equal(win[0], "D:\\Win\\System32\\nvidia-smi.exe");
  assert.equal(win[1], "D:\\PF\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe");
  assert.equal(win.at(-1), "nvidia-smi.exe");
  assert.equal(smiCandidates({}, "linux")[0], "nvidia-smi");
  assert.deepEqual(smiCandidates({}, "darwin"), []);
});

test("a GPU is present when nvidia-smi names one; an absent or failing program means none", async () => {
  /** @type {string[]} */
  const asked = [];
  const found = await detectNvidia({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    exists: (file) => file === "C:\\Windows\\System32\\nvidia-smi.exe",
    run: async (command, args) => {
      asked.push(command);
      assert.deepEqual([...args], [...SMI_ARGS]);
      return "NVIDIA GeForce RTX 5060 Ti\r\n";
    },
  });
  assert.deepEqual(found, { present: true, name: "NVIDIA GeForce RTX 5060 Ti" });
  assert.deepEqual(asked, ["C:\\Windows\\System32\\nvidia-smi.exe"]);

  const none = await detectNvidia({
    platform: "linux",
    env: {},
    exists: () => false,
    run: async () => null,
  });
  assert.deepEqual(none, { present: false, name: null });
});

test("macOS never runs anything", async () => {
  const none = await detectNvidia({
    platform: "darwin",
    env: {},
    run: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(none.present, false);
});

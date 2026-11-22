// The machine facts for the MACHINE line of the prompt (docs/SPEC.md section 8, "Prompt"). The
// Windows half is tested on sample output of PowerShell only; the probe runs on fake programs.

import assert from "node:assert/strict";
import test from "node:test";
import { createMachineProbe, osName, tidyCpuName } from "../../src/platform/machine.js";
import * as macos from "../../src/platform/machine.macos.js";
import * as windows from "../../src/platform/machine.windows.js";

test("a macOS version is read from sw_vers and anything else is dropped", () => {
  assert.equal(macos.parseVersion("15.4.1\n"), "15.4.1");
  assert.equal(macos.parseVersion("26.0"), "26.0");
  assert.equal(macos.parseVersion("command not found"), null);
  assert.equal(macos.parseVersion(null), null);
});

test("the graphics adapters are read from system_profiler JSON", () => {
  const json = JSON.stringify({
    SPDisplaysDataType: [
      { sppci_model: "Intel UHD Graphics 630" },
      { sppci_model: "AMD Radeon Pro 5500M" },
      { sppci_model: "AMD Radeon Pro 5500M" },
      { _name: "no model" },
    ],
  });
  assert.deepEqual(macos.parseGpuNames(json), ["Intel UHD Graphics 630", "AMD Radeon Pro 5500M"]);
  assert.deepEqual(macos.parseGpuNames('{"SPDisplaysDataType":[{"sppci_model":"Apple M3 Max"}]}'), [
    "Apple M3 Max",
  ]);
  assert.deepEqual(macos.parseGpuNames("not json"), []);
  assert.deepEqual(macos.parseGpuNames("{}"), []);
  assert.deepEqual(macos.parseGpuNames(null), []);
});

test("Windows: the PowerShell program, its arguments and a sample answer", () => {
  assert.equal(
    windows.powershellPath({ SystemRoot: "D:\\Windows" }),
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(
    windows.powershellPath({}),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(windows.ARGS.slice(0, 5), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.ok(
    windows.SCRIPT.includes("Win32_OperatingSystem") &&
      windows.SCRIPT.includes("Win32_VideoController"),
  );
  assert.ok(!windows.SCRIPT.includes("\n"));

  const sample =
    '{"caption":"Microsoft Windows 11 Pro","version":"10.0.26100","gpus":["NVIDIA GeForce RTX 3060","Intel(R) UHD Graphics 770"]}';
  assert.deepEqual(windows.parseWindowsFacts(sample), {
    osVersion: "11 Pro (10.0.26100)",
    gpus: ["NVIDIA GeForce RTX 3060", "Intel(R) UHD Graphics 770"],
  });
});

test("Windows: one adapter as a plain string, a byte order mark, virtual adapters and bad answers", () => {
  assert.deepEqual(
    windows.parseWindowsFacts(
      '\uFEFF{"caption":"Microsoft Windows 10 Pro","version":"10.0.19045","gpus":"AMD Radeon RX 580 Series"}',
    ),
    { osVersion: "10 Pro (10.0.19045)", gpus: ["AMD Radeon RX 580 Series"] },
  );
  assert.deepEqual(
    windows.parseWindowsFacts(
      '{"caption":"Microsoft Windows Server 2022 Standard","version":"10.0.20348","gpus":["Microsoft Basic Display Adapter","NVIDIA A10"]}',
    ),
    { osVersion: "Server 2022 Standard (10.0.20348)", gpus: ["NVIDIA A10"] },
  );
  // When only virtual adapters exist, they are kept (better than nothing).
  assert.deepEqual(
    windows.parseWindowsFacts(
      '{"caption":null,"version":"10.0.22631","gpus":["Microsoft Basic Display Adapter"]}',
    ),
    { osVersion: "10.0.22631", gpus: ["Microsoft Basic Display Adapter"] },
  );
  const none = { osVersion: null, gpus: [] };
  assert.deepEqual(windows.parseWindowsFacts(""), none);
  assert.deepEqual(windows.parseWindowsFacts(null), none);
  assert.deepEqual(windows.parseWindowsFacts("Get-CimInstance : access denied"), none);
  assert.deepEqual(windows.parseWindowsFacts("[1,2]"), none);
  assert.deepEqual(windows.parseWindowsFacts('{"gpus":[1,null,"  "]}'), none);
});

test("processor names are tidied and platforms named", () => {
  assert.equal(tidyCpuName("12th Gen Intel(R) Core(TM) i7-12700"), "12th Gen Intel Core i7-12700");
  assert.equal(tidyCpuName("  Apple   M3 Max "), "Apple M3 Max");
  assert.equal(tidyCpuName(""), null);
  assert.equal(tidyCpuName(undefined), null);
  assert.equal(osName("darwin"), "macOS");
  assert.equal(osName("win32"), "Windows");
  assert.equal(osName("linux"), "Linux");
  assert.equal(osName("freebsd"), "freebsd");
});

const FAKE_OS = {
  cpus: () => [{ model: "Intel(R) Core(TM) i9-9880H" }, { model: "Intel(R) Core(TM) i9-9880H" }],
  totalmem: () => 17_179_869_184,
  release: () => "6.8.0",
};

test("the probe on macOS asks sw_vers and system_profiler once and caches the answer", async () => {
  /** @type {string[]} */
  const calls = [];
  const probe = createMachineProbe({
    platform: "darwin",
    os: FAKE_OS,
    run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return command === macos.SW_VERS
        ? "15.4.1\n"
        : '{"SPDisplaysDataType":[{"sppci_model":"Intel UHD Graphics 630"},{"sppci_model":"AMD Radeon Pro 5500M"}]}';
    },
  });
  const facts = await probe.facts();
  assert.deepEqual(facts, {
    os: "macOS",
    osVersion: "15.4.1",
    cpu: "Intel Core i9-9880H",
    logicalCores: 2,
    memoryGb: 16,
    gpu: "Intel UHD Graphics 630; AMD Radeon Pro 5500M",
  });
  assert.equal(await probe.facts(), facts);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.startsWith("/usr/bin/sw_vers"));
  assert.ok(calls[1]?.startsWith("/usr/sbin/system_profiler SPDisplaysDataType -json"));
});

test("the probe on Windows runs one PowerShell and reads the processor from the system", async () => {
  /** @type {string[]} */
  const commands = [];
  const probe = createMachineProbe({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    os: FAKE_OS,
    run: async (command) => {
      commands.push(command);
      return '{"caption":"Microsoft Windows 11 Home","version":"10.0.22631","gpus":["NVIDIA GeForce GTX 1650"]}';
    },
  });
  const facts = await probe.facts();
  assert.deepEqual(commands, ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
  assert.equal(facts.os, "Windows");
  assert.equal(facts.osVersion, "11 Home (10.0.22631)");
  assert.equal(facts.gpu, "NVIDIA GeForce GTX 1650");
  assert.equal(facts.cpu, "Intel Core i9-9880H");
});

test("programs that fail leave their parts out and never reject", async () => {
  const failing = createMachineProbe({ platform: "darwin", os: FAKE_OS, run: async () => null });
  assert.deepEqual(await failing.facts(), {
    os: "macOS",
    osVersion: null,
    cpu: "Intel Core i9-9880H",
    logicalCores: 2,
    memoryGb: 16,
    gpu: null,
  });
  const throwing = createMachineProbe({
    platform: "win32",
    os: FAKE_OS,
    run: async () => {
      throw new Error("boom");
    },
  });
  assert.equal((await throwing.facts()).gpu, null);
  const brokenOs = createMachineProbe({
    platform: "linux",
    os: {
      cpus: () => {
        throw new Error("no cpus");
      },
      totalmem: () => 0,
      release: () => "6.8.0",
    },
    run: async () => null,
  });
  assert.deepEqual(await brokenOs.facts(), {
    os: "Linux",
    osVersion: "6.8.0",
    cpu: null,
    logicalCores: null,
    memoryGb: null,
    gpu: null,
  });
});

test("the real probe answers something on this computer without failing", async () => {
  const facts = await createMachineProbe({ timeoutMs: 15_000 }).facts();
  assert.ok(facts.os.length > 0);
  assert.ok(facts.logicalCores === null || facts.logicalCores > 0);
});

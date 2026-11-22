// The Windows helper of the CPU limit (docs/SPEC.md section 9, CPU, Windows way): one long-lived
// PowerShell process that owns the Job Objects. It is started by the server without a window,
// compiles a small C# type with `Add-Type` (no extra program to install) and then answers one
// JSON line per request on stdin and stdout (the protocol is in `limits/jobobject.js`).
//
// NEVER EXECUTED: this was written from the Win32 documentation on a Mac and has never run
// on Windows. The pure parts (the argument list, the script's size) are tested; the script
// itself and the C# have not been compiled by anything.
//
// Facts it relies on:
//  - `JobObjectCpuRateControlInformation` is information class 15. `JOBOBJECT_CPU_RATE_CONTROL_
//    INFORMATION` is two DWORDs: `ControlFlags` and a union whose `CpuRate` member is a DWORD in
//    1/100 of a percent of ALL processors (1 to 10000). Flags: ENABLE (0x1) | HARD_CAP (0x4);
//    the hard cap needs Windows 8 or later.
//  - `JobObjectExtendedLimitInformation` is class 9; `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is
//    0x2000: when the last handle of the job closes (the helper ends, or the server dies and
//    stdin reaches its end), every process still in the job is terminated. This is why the tree
//    cannot outlive the server on Windows.
//  - A process is assigned with `AssignProcessToJobObject` after `OpenProcess` with
//    PROCESS_SET_QUOTA (0x0100) | PROCESS_TERMINATE (0x0001). Children created afterwards join
//    the job (breakaway is not allowed). Windows 8 and later allow nested jobs, so a server that
//    itself runs in a job is fine.
//  - Windows PowerShell 5.1 compiles `Add-Type` with C# 5: the C# below uses no newer syntax.
//  - The script is passed as `-EncodedCommand` (UTF-16LE base64), so there is no file to leave
//    behind; the stdin of the process stays free for requests.
//  - A machine in Constrained Language Mode forbids `Add-Type`: the helper then answers
//    `{"ready":false,...}` and the limit is not enforced (the budget is still told to the tools).

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

/** The C# type that wraps the Win32 calls. Methods return "" on success, else an error text. */
const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VidaiJob {
  const int InfoExtended = 9;
  const int InfoRate = 15;
  const uint RateEnable = 0x1;
  const uint RateHardCap = 0x4;
  const uint KillOnClose = 0x2000;
  const uint ProcessAccess = 0x0101;
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct RateInfo { public uint ControlFlags; public uint CpuRate; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  static Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  static string Fail(string what) {
    return what + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
  }
  static bool SetInfo<T>(IntPtr job, int infoClass, T info) where T : struct {
    int size = Marshal.SizeOf(typeof(T));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, memory, false);
      return SetInformationJobObject(job, infoClass, memory, (uint)size);
    } finally {
      Marshal.FreeHGlobal(memory);
    }
  }
  public static string Create(string key) {
    if (jobs.ContainsKey(key)) return "the job exists already";
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return Fail("CreateJobObject");
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.LimitFlags = KillOnClose;
    if (!SetInfo(job, InfoExtended, limits)) {
      string error = Fail("SetInformationJobObject (kill on close)");
      CloseHandle(job);
      return error;
    }
    jobs[key] = job;
    return "";
  }
  public static string Assign(string key, uint pid) {
    IntPtr job;
    if (!jobs.TryGetValue(key, out job)) return "there is no such job";
    IntPtr process = OpenProcess(ProcessAccess, false, pid);
    if (process == IntPtr.Zero) return Fail("OpenProcess");
    string error = AssignProcessToJobObject(job, process) ? "" : Fail("AssignProcessToJobObject");
    CloseHandle(process);
    return error;
  }
  public static string SetRate(string key, uint rate) {
    IntPtr job;
    if (!jobs.TryGetValue(key, out job)) return "there is no such job";
    if (rate < 1 || rate > 10000) return "the rate must be from 1 to 10000";
    RateInfo info = new RateInfo();
    info.ControlFlags = RateEnable | RateHardCap;
    info.CpuRate = rate;
    return SetInfo(job, InfoRate, info) ? "" : Fail("SetInformationJobObject (CPU rate)");
  }
  public static string Terminate(string key) {
    IntPtr job;
    if (!jobs.TryGetValue(key, out job)) return "there is no such job";
    return TerminateJobObject(job, 1) ? "" : Fail("TerminateJobObject");
  }
  public static string Close(string key) {
    IntPtr job;
    if (!jobs.TryGetValue(key, out job)) return "there is no such job";
    jobs.Remove(key);
    return CloseHandle(job) ? "" : Fail("CloseHandle");
  }
  public static void CloseAll() {
    foreach (KeyValuePair<string, IntPtr> pair in jobs) CloseHandle(pair.Value);
    jobs.Clear();
  }
}
`;

/**
 * The whole script of the helper. One JSON object per line in, one per line out:
 * `{"ready":true}` once (after the compile), then `{"id":n,"ok":true}` or
 * `{"id":n,"ok":false,"error":"..."}` per request. It ends when stdin ends.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$out = [Console]::Out
function Q([string]$s) {
  if ($null -eq $s) { return 'null' }
  $t = $s.Replace('\', '\\').Replace('"', '\"')
  $t = $t.Replace([string][char]13, ' ').Replace([string][char]10, ' ').Replace([string][char]9, ' ')
  return '"' + $t + '"'
}
try {
  Add-Type -TypeDefinition @'
${CSHARP}
'@
} catch {
  $out.WriteLine('{"ready":false,"error":' + (Q ([string]$_.Exception.Message)) + '}')
  $out.Flush()
  exit 1
}
$out.WriteLine('{"ready":true}')
$out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  $err = ''
  try {
    $r = $line | ConvertFrom-Json
    $id = [int]$r.id
    switch ([string]$r.op) {
      'create' { $err = [VidaiJob]::Create([string]$r.job) }
      'assign' { $err = [VidaiJob]::Assign([string]$r.job, [uint32]$r.pid) }
      'setRate' { $err = [VidaiJob]::SetRate([string]$r.job, [uint32]$r.rate) }
      'terminate' { $err = [VidaiJob]::Terminate([string]$r.job) }
      'close' { $err = [VidaiJob]::Close([string]$r.job) }
      default { $err = 'unknown request' }
    }
  } catch {
    $err = [string]$_.Exception.Message
  }
  if ([string]::IsNullOrEmpty($err)) {
    $out.WriteLine('{"id":' + $id + ',"ok":true}')
  } else {
    $out.WriteLine('{"id":' + $id + ',"ok":false,"error":' + (Q $err) + '}')
  }
  $out.Flush()
}
[VidaiJob]::CloseAll()
`;

/**
 * The program and arguments that start the helper: Windows PowerShell by its full path (the
 * `PATH` of a service may lack it), no profile, no prompt, the script encoded in the command line.
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {{ file: string, args: string[] }}
 */
export function helperCommand(env = process.env) {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return {
    file: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64"),
    ],
  };
}

/**
 * The ends of a running helper that the client of `limits/jobobject.js` uses.
 * @typedef {object} HelperProcess
 * @property {(line: string) => void} write Sends one line (the newline is added).
 * @property {(listener: (line: string) => void) => void} onLine One call per line of stdout.
 * @property {(listener: (code: number | null) => void) => void} onExit
 * @property {() => void} end Closes stdin: the helper closes its jobs and ends.
 * @property {() => void} kill Ends the helper at once.
 */

/**
 * Starts the helper without a console window. Throws when PowerShell cannot be started.
 * @param {{ env?: Readonly<Record<string, string | undefined>>, spawnFn?: typeof spawn }} [options]
 * @returns {HelperProcess}
 */
export function spawnJobHelper({ env = process.env, spawnFn = spawn } = {}) {
  const { file, args } = helperCommand(env);
  const child = spawnFn(file, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  if (child.pid === undefined) throw new Error("PowerShell could not be started");
  const stdin = /** @type {NonNullable<typeof child.stdin>} */ (child.stdin);
  const stdout = /** @type {NonNullable<typeof child.stdout>} */ (child.stdout);
  // A helper that ended arrives later as an exit event; a write to it must not crash the server.
  stdin.on("error", () => {});
  child.on("error", () => {});
  const lines = readline.createInterface({ input: stdout });
  return {
    write: (line) => {
      stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      lines.on("line", listener);
    },
    onExit: (listener) => {
      child.on("exit", (code) => listener(code));
      // A process that could not even start (no exit event) is reported through `error`.
      child.on("error", () => listener(null));
    },
    end: () => {
      stdin.end();
    },
    kill: () => {
      child.kill();
    },
  };
}

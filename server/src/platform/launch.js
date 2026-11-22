// Turning the path of a program (for example the `claude` that `agents/claude/locate.js` found)
// into a command that starts it.
//
// macOS and other Unix systems: the program is started directly (the kernel reads `#!` lines).
//
// Windows can only start `.exe` files directly, and Claude Code may be installed in several
// shapes (docs/SPEC-desktop.md section 11):
//
// - `claude.exe` (native installer, WinGet, or the binary of the npm package): started directly.
// - An npm `.cmd` shim (`%APPDATA%\npm\claude.cmd`): never run through `cmd.exe`, whose quoting
//   rules make arguments such as JSON unsafe. The shim is read and its target is started
//   instead: the `.exe` it points to, or `node <script>` for a JavaScript target.
// - A JavaScript file: `node <file>`.
// - A script whose `#!` line names Python (`#!/usr/bin/env -S python3 -I`, the fake OpenCode 2
//   of the tests): run with the machine's Python, with the flags of the line, because Git Bash
//   would look for a `python3` of its own.
// - Any other script with a `#!` line (the fake `claude` of the tests, or a user's own
//   wrapper): run with Git Bash. Git Bash is an MSYS2 program, which splits its command line by
//   its own rules (and expands `{}`, `*`, `~` and `@file` in words that are not quoted), so
//   every argument is passed fully quoted in the form MSYS2 reads back literally (`msysQuote`).
// - A batch file that is not an npm shim: refused. Node cannot start batch files without
//   `cmd.exe` (and the Rust core's cmd.exe quoting is exactly what is not safe for JSON).
// - Anything else is handed to Windows as is.
//
// The decisions are pure (`resolveWindowsLaunch` takes the file system and the lookups as
// parameters) and written with `path.win32`, so they are unit tested on every platform.

import fs from "node:fs";
import path from "node:path";
import { getVar, gitBash, whichInWindows, whichToolWindows } from "./launchLookup.js";

const win = path.win32;

/**
 * A program and the arguments that go before the caller's own arguments.
 * @typedef {object} Launch
 * @property {string} program
 * @property {string[]} args
 * @property {boolean} msys The program is an MSYS2 program (Git Bash): arguments are quoted with
 *   `msysQuote`.
 */

/**
 * What the Windows decisions need from the machine.
 * @typedef {object} WindowsLaunchDeps
 * @property {(file: string, maxBytes: number) => Buffer | null} readHead The first bytes of a
 *   file, or `null` when it cannot be read.
 * @property {() => string | null} gitBash
 * @property {(shimDir: string | null) => string | null} node `node.exe` next to an npm shim
 *   (`shimDir`), else the first one on `PATH`.
 * @property {() => string | null} python
 */

/** The most of an npm shim that is read. */
const SHIM_BYTES = 64 * 1024;

/**
 * `arg` quoted for the command line of an MSYS2 program started from a Windows program: inside
 * double quotes, with `\` and `"` escaped by a backslash, every character is literal (no brace,
 * wildcard, `~` or `@file` expansion).
 * @param {string} arg
 * @returns {string}
 */
export function msysQuote(arg) {
  return `"${arg.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * A launch error: the program cannot be started because something it needs is missing.
 * @param {string} message
 * @returns {Error}
 */
function launchError(message) {
  return Object.assign(new Error(message), { code: "ENOENT" });
}

/**
 * The lowercase extension of `file` without the dot.
 * @param {string} file
 * @returns {string}
 */
function extensionOf(file) {
  return win.extname(file).slice(1).toLowerCase();
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isJavascript(file) {
  return ["js", "mjs", "cjs"].includes(extensionOf(file));
}

/**
 * The program an npm `.cmd` shim starts: the last quoted `%dp0%\...` (or `%~dp0\...`) path in
 * it, resolved against the shim's folder `dir`; `null` when there is none.
 *
 * npm writes shims like `"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`
 * (a Node.js script) or `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`.
 * @param {string} text
 * @param {string} dir
 * @returns {string | null}
 */
export function npmShimTarget(text, dir) {
  /** @type {string | null} */
  let target = null;
  let rest = text;
  for (;;) {
    const start = rest.indexOf('"');
    if (start < 0) break;
    const after = rest.slice(start + 1);
    const end = after.indexOf('"');
    if (end < 0) break;
    const quoted = after.slice(0, end);
    const relative = quoted.startsWith("%dp0%\\")
      ? quoted.slice(6)
      : quoted.startsWith("%~dp0\\")
        ? quoted.slice(6)
        : null;
    if (relative !== null && relative !== "" && !relative.includes("%")) {
      let resolved = dir;
      for (const part of relative.split("\\")) {
        if (part === "" || part === ".") continue;
        resolved = part === ".." ? win.dirname(resolved) : win.join(resolved, part);
      }
      target = resolved;
    }
    rest = after.slice(end + 1);
  }
  // `node.exe` next to the shim is the interpreter, not the target.
  if (target !== null && win.basename(target).toLowerCase() === "node.exe") return null;
  return target;
}

/**
 * The flags of a `#!` line that starts Python (`#!/usr/bin/env -S python3 -I` gives `["-I"]`,
 * `#!/usr/bin/python3` gives none), or `null` when the text has no such line.
 * @param {string} head The first bytes of the file as text.
 * @returns {string[] | null}
 */
export function pythonShebang(head) {
  const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return null;
  const words = firstLine.slice(2).split(/\s+/).filter(Boolean);
  /** @param {string} word */
  const nameOf = (word) => word.slice(word.lastIndexOf("/") + 1);
  if (words[0] !== undefined && nameOf(words[0]) === "env") {
    words.shift();
    while (words[0] !== undefined && words[0].startsWith("-")) words.shift();
  }
  const interpreter = words.shift();
  if (interpreter === undefined || !nameOf(interpreter).startsWith("python")) return null;
  return words;
}

/**
 * `C:\a\b.sh` as `C:/a/b.sh`, which Git Bash reads without any escaping question.
 * @param {string} file
 * @returns {string}
 */
export function posixStyle(file) {
  return file.replaceAll("\\", "/");
}

/**
 * The Windows rules of the module comment, with the file system and the interpreters given as
 * `deps`. Throws when a needed interpreter is missing.
 * @param {string} program
 * @param {WindowsLaunchDeps} deps
 * @returns {Launch}
 */
export function resolveWindowsLaunch(program, deps) {
  /** @type {Launch} */
  const direct = { program, args: [], msys: false };
  const ext = extensionOf(program);
  if (ext === "exe" || ext === "com") return direct;
  if (ext === "cmd" || ext === "bat") {
    const shim = deps.readHead(program, SHIM_BYTES);
    const dir = win.dirname(program);
    const target = shim === null ? null : npmShimTarget(shim.toString("utf8"), dir);
    if (target !== null && ["exe", "com"].includes(extensionOf(target))) {
      return { program: target, args: [], msys: false };
    }
    if (target !== null && isJavascript(target)) return withNode(deps.node(dir), target);
    throw launchError(
      `${program} is a batch file, which cannot be started safely. Use the claude.exe of Claude Code or its npm shim.`,
    );
  }
  if (isJavascript(program)) return withNode(deps.node(null), program);
  const head = deps.readHead(program, 256);
  const flags = head === null ? null : pythonShebang(head.toString("utf8"));
  if (flags !== null) {
    const python = deps.python();
    if (python === null) throw launchError(`${program} needs Python, which was not found`);
    return { program: python, args: [...flags, program], msys: false };
  }
  if (head !== null && head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
    const bash = deps.gitBash();
    if (bash === null) {
      throw launchError(`${program} is a shell script, which needs Git for Windows (Git Bash)`);
    }
    return { program: bash, args: [posixStyle(program)], msys: true };
  }
  return direct;
}

/**
 * @param {string | null} node
 * @param {string} script
 * @returns {Launch}
 */
function withNode(node, script) {
  if (node === null) throw launchError(`${script} needs Node.js, which was not found`);
  return { program: node, args: [script], msys: false };
}

/**
 * The first bytes of a file, or `null` when it cannot be read.
 * @param {string} file
 * @param {number} maxBytes
 * @returns {Buffer | null}
 */
function readHead(file, maxBytes) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * How to start `program` with the child environment `env` (used to find Git Bash and Node.js on
 * Windows). Throws when a needed interpreter is missing.
 * @param {string} program
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {Launch}
 */
export function resolveLaunch(program, env, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { program, args: [], msys: false };
  return resolveWindowsLaunch(program, {
    readHead,
    gitBash: () => gitBash(env),
    node: (shimDir) => {
      if (shimDir !== null) {
        const next = win.join(shimDir, "node.exe");
        if (fs.existsSync(next)) return next;
      }
      return whichInWindows("node", getVar(env, "PATH"), getVar(env, "PATHEXT"));
    },
    python: () => whichToolWindows("python3", env),
  });
}

/**
 * The arguments of `child_process.spawn` for a launch with the caller's `args` after the
 * launch's own.
 *
 * An MSYS2 program gets every argument quoted with `msysQuote` and the command line verbatim.
 * Node puts the program path first on a verbatim command line without quoting it, so its own
 * quoted form is given as `argv0` (a path with spaces, `C:\Program Files\Git\bin\bash.exe`,
 * would otherwise split into two arguments).
 * @param {Launch} launch
 * @param {readonly string[]} args
 * @returns {{ file: string, args: string[], argv0: string | undefined, windowsVerbatimArguments: boolean }}
 */
export function spawnPlan(launch, args) {
  const all = [...launch.args, ...args];
  if (!launch.msys) {
    return { file: launch.program, args: all, argv0: undefined, windowsVerbatimArguments: false };
  }
  return {
    file: launch.program,
    args: all.map(msysQuote),
    argv0: `"${launch.program}"`,
    windowsVerbatimArguments: true,
  };
}

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  msysQuote,
  npmShimTarget,
  posixStyle,
  pythonShebang,
  resolveLaunch,
  resolveWindowsLaunch,
  spawnPlan,
} from "../../src/platform/launch.js";

const NPM = "C:\\Users\\u\\AppData\\Roaming\\npm";

// What npm writes for a package whose bin is a Node.js script.
const NODE_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r
`;

// What npm writes when the package's bin is a native executable.
const EXE_SHIM = `@ECHO off\r
SETLOCAL\r
SET dp0=%~dp0\r
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r
`;

describe("npmShimTarget", () => {
  test("finds the script of a Node.js shim", () => {
    assert.equal(
      npmShimTarget(NODE_SHIM, NPM),
      `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
    );
  });

  test("finds the executable of a native shim", () => {
    assert.equal(
      npmShimTarget(EXE_SHIM, NPM),
      `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    );
  });

  test("understands %~dp0 and parent folders", () => {
    assert.equal(
      npmShimTarget('"%~dp0\\..\\lib\\tool.exe" %*', "C:\\tools\\bin"),
      "C:\\tools\\lib\\tool.exe",
    );
  });

  test("the OpenCode 2 installer's shim has no backslash after %~dp0", () => {
    const shim = '@echo off\r\n"%~dp0opencode.exe" %*\r\nexit /b %errorlevel%\r\n';
    assert.equal(
      npmShimTarget(shim, "C:\\Users\\Ed\\.opencode\\bin"),
      "C:\\Users\\Ed\\.opencode\\bin\\opencode.exe",
    );
    assert.equal(npmShimTarget('"%dp0%opencode.exe" %*', NPM), `${NPM}\\opencode.exe`);
    assert.equal(
      npmShimTarget('"%~DP0..\\lib\\tool.exe" %*', "C:\\tools\\bin"),
      "C:\\tools\\lib\\tool.exe",
    );
  });

  test("a path that only looks like the shim's folder has no target", () => {
    assert.equal(npmShimTarget('"%~dp0" %*', NPM), null);
    assert.equal(npmShimTarget('"%dp0%" %*', NPM), null);
    assert.equal(npmShimTarget('"%~dp1opencode.exe" %*', NPM), null);
    assert.equal(npmShimTarget('"C:\\other\\opencode.exe" %*', NPM), null);
    assert.equal(npmShimTarget('"%~dp0%NAME%.exe" %*', NPM), null);
  });

  test("the node.exe next to the shim is the interpreter, not the target", () => {
    assert.equal(npmShimTarget('"%dp0%\\node.exe" %*', NPM), null);
  });

  test("a batch file that is not a shim has no target", () => {
    assert.equal(npmShimTarget("@echo off\r\necho hello\r\n", NPM), null);
    assert.equal(npmShimTarget('"%dp0%\\%NAME%.exe"', NPM), null);
    assert.equal(npmShimTarget('"unterminated', NPM), null);
    assert.equal(npmShimTarget("", NPM), null);
  });
});

describe("pythonShebang", () => {
  test("reads the flags of the line", () => {
    assert.deepEqual(pythonShebang("#!/usr/bin/env -S python3 -I\nprint()\n"), ["-I"]);
    assert.deepEqual(pythonShebang("#!/usr/bin/python3\r\nx"), []);
    assert.deepEqual(pythonShebang("#!/usr/bin/env python3.12\n"), []);
    assert.deepEqual(pythonShebang("#!python -u -B\n"), ["-u", "-B"]);
  });

  test("other scripts are not Python", () => {
    assert.equal(pythonShebang("#!/bin/sh\necho\n"), null);
    assert.equal(pythonShebang("#!/usr/bin/env bash\n"), null);
    assert.equal(pythonShebang("print('hi')\n"), null);
    assert.equal(pythonShebang(""), null);
    assert.equal(pythonShebang("#!\n"), null);
  });
});

describe("quoting", () => {
  test("msysQuote makes every character literal", () => {
    assert.equal(msysQuote("plain"), '"plain"');
    assert.equal(msysQuote('say "hi"'), '"say \\"hi\\""');
    assert.equal(msysQuote("C:\\dir\\file"), '"C:\\\\dir\\\\file"');
    assert.equal(msysQuote('{"a":[1,*,~]}'), '"{\\"a\\":[1,*,~]}"');
    assert.equal(msysQuote(""), '""');
  });

  test("posixStyle", () => {
    assert.equal(posixStyle("C:\\a\\b.sh"), "C:/a/b.sh");
    assert.equal(posixStyle("/already/posix"), "/already/posix");
  });
});

describe("resolveWindowsLaunch", () => {
  /**
   * @param {Record<string, string>} files
   * @param {Partial<import("../../src/platform/launch.js").WindowsLaunchDeps>} [over]
   */
  const deps = (files, over = {}) => ({
    readHead: (/** @type {string} */ file, /** @type {number} */ max) => {
      const content = files[file];
      return content === undefined ? null : Buffer.from(content).subarray(0, max);
    },
    gitBash: () => "C:\\Program Files\\Git\\bin\\bash.exe",
    node: (/** @type {string | null} */ shimDir) =>
      shimDir === null ? "C:\\node\\node.exe" : `${shimDir}\\node.exe`,
    python: () => "C:\\Python\\python.exe",
    ...over,
  });
  const plain = (/** @type {import("../../src/platform/launch.js").Launch} */ l) => l;

  test("the installer's opencode2.cmd starts the opencode.exe next to it", () => {
    const dir = "C:\\Users\\Ed\\.opencode\\bin";
    const shim = '@echo off\r\n"%~dp0opencode.exe" %*\r\nexit /b %errorlevel%\r\n';
    assert.deepEqual(
      plain(
        resolveWindowsLaunch(`${dir}\\opencode2.cmd`, deps({ [`${dir}\\opencode2.cmd`]: shim })),
      ),
      { program: `${dir}\\opencode.exe`, args: [], msys: false },
    );
  });

  test("an exe or com runs directly", () => {
    for (const program of ["C:\\a\\claude.exe", "C:\\a\\CLAUDE.EXE", "C:\\a\\x.com"]) {
      assert.deepEqual(plain(resolveWindowsLaunch(program, deps({}))), {
        program,
        args: [],
        msys: false,
      });
    }
  });

  test("an npm shim starts its target", () => {
    const files = { [`${NPM}\\claude.cmd`]: EXE_SHIM, [`${NPM}\\other.cmd`]: NODE_SHIM };
    assert.deepEqual(resolveWindowsLaunch(`${NPM}\\claude.cmd`, deps(files)), {
      program: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
      args: [],
      msys: false,
    });
    assert.deepEqual(resolveWindowsLaunch(`${NPM}\\other.cmd`, deps(files)), {
      program: `${NPM}\\node.exe`,
      args: [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`],
      msys: false,
    });
  });

  test("a shim with a script target needs Node.js", () => {
    const files = { [`${NPM}\\other.cmd`]: NODE_SHIM };
    assert.throws(
      () => resolveWindowsLaunch(`${NPM}\\other.cmd`, deps(files, { node: () => null })),
      { code: "ENOENT", message: /needs Node\.js/ },
    );
  });

  test("a batch file that is not an npm shim is refused", () => {
    const files = { "C:\\a\\run.bat": "@echo off\r\necho hi\r\n" };
    assert.throws(() => resolveWindowsLaunch("C:\\a\\run.bat", deps(files)), /batch file/);
    assert.throws(() => resolveWindowsLaunch("C:\\a\\unreadable.cmd", deps({})), /batch file/);
  });

  test("a JavaScript file runs with Node.js", () => {
    for (const ext of ["js", "mjs", "cjs"]) {
      assert.deepEqual(resolveWindowsLaunch(`C:\\a\\cli.${ext}`, deps({})), {
        program: "C:\\node\\node.exe",
        args: [`C:\\a\\cli.${ext}`],
        msys: false,
      });
    }
    assert.throws(
      () => resolveWindowsLaunch("C:\\a\\cli.js", deps({}, { node: () => null })),
      /needs Node\.js/,
    );
  });

  test("a Python script runs with Python and the flags of its line", () => {
    const files = { "C:\\a\\fake": "#!/usr/bin/env -S python3 -I\nprint('x')\n" };
    assert.deepEqual(resolveWindowsLaunch("C:\\a\\fake", deps(files)), {
      program: "C:\\Python\\python.exe",
      args: ["-I", "C:\\a\\fake"],
      msys: false,
    });
    assert.throws(() => resolveWindowsLaunch("C:\\a\\fake", deps(files, { python: () => null })), {
      code: "ENOENT",
      message: /needs Python/,
    });
  });

  test("another script runs with Git Bash, with a posix-style path", () => {
    const files = { "C:\\a\\fake-claude.sh": "#!/bin/sh\necho\n" };
    assert.deepEqual(resolveWindowsLaunch("C:\\a\\fake-claude.sh", deps(files)), {
      program: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["C:/a/fake-claude.sh"],
      msys: true,
    });
    assert.throws(
      () => resolveWindowsLaunch("C:\\a\\fake-claude.sh", deps(files, { gitBash: () => null })),
      { code: "ENOENT", message: /Git for Windows/ },
    );
  });

  test("anything else is handed to Windows as it is", () => {
    const files = { "C:\\a\\tool": "MZ binary" };
    assert.deepEqual(resolveWindowsLaunch("C:\\a\\tool", deps(files)), {
      program: "C:\\a\\tool",
      args: [],
      msys: false,
    });
    assert.deepEqual(resolveWindowsLaunch("C:\\a\\missing", deps({})), {
      program: "C:\\a\\missing",
      args: [],
      msys: false,
    });
  });
});

describe("spawnPlan", () => {
  test("a plain program gets the launch arguments before the caller's", () => {
    assert.deepEqual(
      spawnPlan({ program: "C:\\node.exe", args: ["cli.js"], msys: false }, ["--version"]),
      {
        file: "C:\\node.exe",
        args: ["cli.js", "--version"],
        argv0: undefined,
        windowsVerbatimArguments: false,
      },
    );
  });

  test("an MSYS2 program gets every argument quoted and a verbatim command line", () => {
    const plan = spawnPlan(
      { program: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["C:/a/fake.sh"], msys: true },
      ["-p", '{"a":"b"}'],
    );
    assert.deepEqual(plan, {
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ['"C:/a/fake.sh"', '"-p"', '"{\\"a\\":\\"b\\"}"'],
      argv0: '"C:\\Program Files\\Git\\bin\\bash.exe"',
      windowsVerbatimArguments: true,
    });
  });

  test("resolveLaunch starts programs directly outside Windows", () => {
    assert.deepEqual(resolveLaunch("/x/claude", {}, { platform: "darwin" }), {
      program: "/x/claude",
      args: [],
      msys: false,
    });
    assert.deepEqual(resolveLaunch("/x/claude", {}, { platform: "linux" }), {
      program: "/x/claude",
      args: [],
      msys: false,
    });
  });
});

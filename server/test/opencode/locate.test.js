import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  candidates,
  cliStatus,
  findOpencode2,
  firstSupported,
  INSTALL_COMMAND_MAC,
  INSTALL_COMMAND_WINDOWS,
  installCommand,
  opencodeStatus,
  parseVersion,
  OVERRIDE_VAR,
  problem,
  supported,
  version,
  wellKnownDirs,
  windowsDirs,
  windowsExtensions,
} from "../../src/agents/opencode/locate.js";

/** A file system of exactly these files. @param {string[]} files */
const filesOf = (files) => {
  const set = new Set(files);
  return {
    isFile: (/** @type {string} */ f) => set.has(f),
    realpath: (/** @type {string} */ f) => f,
  };
};

/** Answers `--version` from a table. @param {Record<string, string | null>} table */
const versions = (table) => {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    versionOf: async (/** @type {string} */ file) => {
      asked.push(file);
      return table[file] ?? null;
    },
  };
};

describe("which versions VidAI drives", () => {
  test("2.x is supported", () => {
    for (const v of ["2.0.0", "2.2.6", "2.3.1", "v2.1.0", "2.10.0-beta.1", " 2.0.0\n", "2.0"]) {
      assert.equal(supported(v), true, v);
    }
  });

  test("1.x, 3.x and non-versions are not", () => {
    for (const v of ["1.18.0", "1.18.31", "1.40.2", "3.0.0", "", "opencode", "2", "2.x", "v"]) {
      assert.equal(supported(v), false, v);
    }
  });

  test("the version is the number in the output", () => {
    assert.equal(parseVersion("opencode v2.2.6\n"), "2.2.6");
    assert.equal(parseVersion("1.18.31\n"), "1.18.31");
    assert.equal(parseVersion("nothing"), null);
    assert.equal(parseVersion("opencode 2.10.0-beta.1 (build x)"), "2.10.0-beta.1");
    assert.equal(parseVersion("xv2.2.6"), null);
  });

  test("the install command depends on the platform", () => {
    assert.equal(installCommand("darwin"), INSTALL_COMMAND_MAC);
    assert.equal(installCommand("linux"), INSTALL_COMMAND_MAC);
    assert.equal(installCommand("win32"), INSTALL_COMMAND_WINDOWS);
    assert.match(INSTALL_COMMAND_MAC, /opencode\.ai\/v2\/install/);
    assert.match(INSTALL_COMMAND_WINDOWS, /Anomaly\.OpenCode/);
  });
});

describe("where it is looked for", () => {
  test("the folders of a Mac, this processor's Homebrew first", () => {
    assert.deepEqual(wellKnownDirs("arm64"), [
      "~/.opencode/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "~/.local/bin",
    ]);
    assert.deepEqual(wellKnownDirs("x64"), [
      "~/.opencode/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "~/.local/bin",
    ]);
  });

  test("the folders of Windows", () => {
    assert.deepEqual(
      windowsDirs({
        USERPROFILE: "C:\\Users\\Ed",
        LOCALAPPDATA: "C:\\Users\\Ed\\AppData\\Local",
        APPDATA: "C:\\Users\\Ed\\AppData\\Roaming",
      }),
      [
        "C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet\\Links",
        "C:\\Users\\Ed\\.opencode\\bin",
        "C:\\Users\\Ed\\AppData\\Roaming\\npm",
        "C:\\Users\\Ed\\scoop\\shims",
        "C:\\Users\\Ed\\.local\\bin",
      ],
    );
  });

  test("WinGet's package folders of OpenCode follow its links, per user and per machine", () => {
    const local = "C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet";
    const machine = "C:\\Program Files\\WinGet";
    /** @type {Record<string, string[]>} */
    const tree = {
      [`${local}\\Packages`]: [
        "Other.Tool_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "anomaly.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "Anomaly.OpenCodeNot_x",
      ],
      [`${machine}\\Packages`]: ["Anomaly.OpenCode_Microsoft.Winget.Source_8wekyb3d8bbwe"],
    };
    const listed = /** @type {string[]} */ ([]);
    const dirs = windowsDirs(
      {
        USERPROFILE: "C:\\Users\\Ed",
        LOCALAPPDATA: "C:\\Users\\Ed\\AppData\\Local",
        APPDATA: "C:\\Users\\Ed\\AppData\\Roaming",
        ProgramFiles: "C:\\Program Files",
      },
      (dir) => {
        listed.push(dir);
        return tree[dir] ?? [];
      },
    );
    assert.deepEqual(dirs, [
      `${local}\\Links`,
      `${local}\\Packages\\anomaly.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe`,
      `${machine}\\Links`,
      `${machine}\\Packages\\Anomaly.OpenCode_Microsoft.Winget.Source_8wekyb3d8bbwe`,
      "C:\\Users\\Ed\\.opencode\\bin",
      "C:\\Users\\Ed\\AppData\\Roaming\\npm",
      "C:\\Users\\Ed\\scoop\\shims",
      "C:\\Users\\Ed\\.local\\bin",
    ]);
    assert.deepEqual(listed, [`${local}\\Packages`, `${machine}\\Packages`]);
  });

  test("missing app-data variables fall back into the profile; names ignore letter case", () => {
    assert.deepEqual(windowsDirs({ UserProfile: "C:\\Users\\Ed" }), [
      "C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet\\Links",
      "C:\\Users\\Ed\\.opencode\\bin",
      "C:\\Users\\Ed\\AppData\\Roaming\\npm",
      "C:\\Users\\Ed\\scoop\\shims",
      "C:\\Users\\Ed\\.local\\bin",
    ]);
    const moved = windowsDirs({ USERPROFILE: "C:\\Users\\Ed", APPDATA: "D:\\Roam" });
    assert.ok(moved.includes("D:\\Roam\\npm"));
    assert.equal(windowsDirs({}).length, 0);
  });

  test("extensions: PATHEXT plus .exe and .cmd", () => {
    assert.deepEqual(windowsExtensions(".COM;.EXE;.BAT"), [".com", ".exe", ".bat", ".cmd"]);
    for (const list of [windowsExtensions(null), windowsExtensions(".BAT")]) {
      assert.ok(list.includes(".exe") && list.includes(".cmd"));
    }
  });

  test("candidates: opencode2 before opencode, PATH before the folders, links once", () => {
    const folders = {
      platform: /** @type {NodeJS.Platform} */ ("darwin"),
      path: "/bin1:/bin2",
      home: "/h",
      dirs: ["~/.opencode/bin", "/opt/homebrew/bin"],
    };
    const files = filesOf([
      "/bin1/opencode",
      "/bin2/opencode2",
      "/h/.opencode/bin/opencode",
      "/h/.opencode/bin/opencode2",
      "/opt/homebrew/bin/opencode",
    ]);
    assert.deepEqual(candidates(["opencode2", "opencode"], folders, files), [
      "/bin2/opencode2",
      "/h/.opencode/bin/opencode2",
      "/bin1/opencode",
      "/h/.opencode/bin/opencode",
      "/opt/homebrew/bin/opencode",
    ]);
    // `opencode2` linked to `opencode` (npm): one file, listed once at its first place.
    const linked = {
      isFile: files.isFile,
      realpath: (/** @type {string} */ f) =>
        f.endsWith("opencode2") ? f.replace("opencode2", "opencode") : f,
    };
    assert.deepEqual(candidates(["opencode2", "opencode"], folders, linked), [
      "/bin2/opencode2",
      "/h/.opencode/bin/opencode2",
      "/bin1/opencode",
      "/opt/homebrew/bin/opencode",
    ]);
  });

  test("without a home the ~ folders are skipped; relative and empty PATH entries too", () => {
    const folders = {
      platform: /** @type {NodeJS.Platform} */ ("darwin"),
      path: ":rel/bin:/ok",
      home: null,
      dirs: ["~/.opencode/bin", "/opt/homebrew/bin"],
    };
    const files = filesOf(["/ok/opencode", "rel/bin/opencode", "/opt/homebrew/bin/opencode"]);
    assert.deepEqual(candidates(["opencode"], folders, files), [
      "/ok/opencode",
      "/opt/homebrew/bin/opencode",
    ]);
  });
});

describe("Windows lookups", () => {
  const env = {
    USERPROFILE: "C:\\Users\\Ed",
    LOCALAPPDATA: "C:\\Users\\Ed\\AppData\\Local",
    APPDATA: "C:\\Users\\Ed\\AppData\\Roaming",
    PATH: "",
  };
  /** @param {string[]} files @param {Record<string, string>} [extra] */
  const win = (files, extra = {}) => {
    const e = { ...env, ...extra };
    const folders = {
      platform: /** @type {NodeJS.Platform} */ ("win32"),
      path: e.PATH,
      home: "C:\\Users\\Ed",
      dirs: windowsDirs(e),
      pathext: /** @type {string | undefined} */ (extra["PATHEXT"]) ?? ".COM;.EXE;.BAT;.CMD",
    };
    return candidates(["opencode2", "opencode"], folders, filesOf(files));
  };

  test("WinGet's link, a manual install, npm's shim and scoop's shim are all found", () => {
    const winget = "C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.exe";
    const manual = "C:\\Users\\Ed\\.opencode\\bin\\opencode.exe";
    const npm = "C:\\Users\\Ed\\AppData\\Roaming\\npm\\opencode2.cmd";
    const scoop = "C:\\Users\\Ed\\scoop\\shims\\opencode.exe";
    const local = "C:\\Users\\Ed\\.local\\bin\\opencode.exe";
    assert.deepEqual(win([winget]), [winget]);
    assert.deepEqual(win([manual]), [manual]);
    assert.deepEqual(win([npm]), [npm]);
    assert.deepEqual(win([scoop]), [scoop]);
    assert.deepEqual(win([local]), [local]);
  });

  /** @param {Record<string, string[]>} tree @returns {(dir: string) => string[]} */
  const listing = (tree) => (dir) => tree[dir] ?? [];
  const wingetPackage = "Anomaly.OpenCode_Microsoft.Winget.Source_8wekyb3d8bbwe";

  test("a WinGet install without links (only the package folder) is found", async () => {
    const exe = `C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet\\Packages\\${wingetPackage}\\opencode.exe`;
    const { versionOf } = versions({ [exe]: "2.2.6" });
    const found = await findOpencode2(env, {
      platform: "win32",
      home: "C:\\Users\\Ed",
      ...filesOf([exe]),
      listDir: listing({
        "C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet\\Packages": [wingetPackage],
      }),
      versionOf,
    });
    assert.deepEqual(found, { path: exe, version: "2.2.6" });
  });

  test("a machine-scope WinGet link and package folder are found", async () => {
    const link = "C:\\Program Files\\WinGet\\Links\\opencode.exe";
    const pkg = `C:\\Program Files\\WinGet\\Packages\\${wingetPackage}\\opencode.exe`;
    const machine = {
      platform: /** @type {NodeJS.Platform} */ ("win32"),
      home: "C:\\Users\\Ed",
      listDir: listing({ "C:\\Program Files\\WinGet\\Packages": [wingetPackage] }),
    };
    const machineEnv = { ...env, ProgramFiles: "C:\\Program Files" };
    const viaLink = await findOpencode2(machineEnv, {
      ...machine,
      ...filesOf([link]),
      ...versions({ [link]: "2.2.6" }),
    });
    assert.deepEqual(viaLink, { path: link, version: "2.2.6" });
    const viaPackage = await findOpencode2(machineEnv, {
      ...machine,
      ...filesOf([pkg]),
      ...versions({ [pkg]: "2.2.6" }),
    });
    assert.deepEqual(viaPackage, { path: pkg, version: "2.2.6" });
  });

  test("the installer's opencode2.cmd and opencode.exe are one program, asked once", async () => {
    const bin = "C:\\Users\\Ed\\.opencode\\bin";
    const real = (/** @type {string} */ f) =>
      f.toLowerCase().endsWith("opencode2.cmd") ? `${bin}\\opencode.exe` : f;
    const { versionOf, asked } = versions({ [`${bin}\\opencode2.cmd`]: "2.2.6" });
    const found = await findOpencode2(env, {
      platform: "win32",
      home: "C:\\Users\\Ed",
      isFile: filesOf([`${bin}\\opencode2.cmd`, `${bin}\\opencode.exe`]).isFile,
      realpath: real,
      versionOf,
    });
    assert.deepEqual(found, { path: `${bin}\\opencode2.cmd`, version: "2.2.6" });
    assert.deepEqual(asked, [`${bin}\\opencode2.cmd`]);
  });

  test("PATH comes first, with quoted, spaced and relative entries handled", () => {
    const tools = "C:\\Program Files\\OpenCode\\opencode.exe";
    const found = win([tools, "C:\\Users\\Ed\\.opencode\\bin\\opencode.exe", "rel\\opencode.exe"], {
      PATH: '"C:\\Program Files\\OpenCode";rel;;',
    });
    assert.deepEqual(found, [tools, "C:\\Users\\Ed\\.opencode\\bin\\opencode.exe"]);
  });

  test(".exe before .cmd, and the extensionless npm file is never a program", () => {
    const dir = "C:\\Users\\Ed\\AppData\\Roaming\\npm";
    assert.deepEqual(win([`${dir}\\opencode`, `${dir}\\opencode.cmd`, `${dir}\\opencode.exe`]), [
      `${dir}\\opencode.exe`,
    ]);
    assert.deepEqual(win([`${dir}\\opencode`]), []);
  });

  test("a PATHEXT that lacks .exe and .cmd still finds both", () => {
    const dir = "C:\\Users\\Ed\\AppData\\Roaming\\npm";
    assert.deepEqual(win([`${dir}\\opencode.cmd`], { PATHEXT: ".BAT" }), [`${dir}\\opencode.cmd`]);
    assert.deepEqual(win([`${dir}\\opencode.exe`], { PATHEXT: ".BAT" }), [`${dir}\\opencode.exe`]);
  });

  test("the same file under a different letter case is one candidate", () => {
    const folders = {
      platform: /** @type {NodeJS.Platform} */ ("win32"),
      path: "C:\\A;C:\\a",
      home: null,
      dirs: [],
      pathext: ".EXE",
    };
    const real = (/** @type {string} */ f) => f;
    assert.deepEqual(
      candidates(["opencode"], folders, {
        isFile: (f) => f.toLowerCase() === "c:\\a\\opencode.exe",
        realpath: real,
      }),
      ["C:\\A\\opencode.exe"],
    );
  });

  test("a 1.x opencode on the PATH does not hide a 2.x one in WinGet's folder", async () => {
    const old = "C:\\Old\\opencode.exe";
    const winget = "C:\\Users\\Ed\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.exe";
    const { versionOf } = versions({ [old]: "1.18.31", [winget]: "2.2.6" });
    const found = await findOpencode2(
      { ...env, PATH: "C:\\Old", PATHEXT: ".EXE" },
      { platform: "win32", home: "C:\\Users\\Ed", ...filesOf([old, winget]), versionOf },
    );
    assert.deepEqual(found, { path: winget, version: "2.2.6" });
  });

  test("a stale opencode2.cmd of 1.x is found but not supported", async () => {
    const stale = "C:\\Users\\Ed\\AppData\\Roaming\\npm\\opencode2.cmd";
    const { versionOf } = versions({ [stale]: "1.18.31" });
    const found = await findOpencode2(env, {
      platform: "win32",
      home: "C:\\Users\\Ed",
      ...filesOf([stale]),
      versionOf,
    });
    assert.deepEqual(found, { path: stale, version: "1.18.31" });
  });

  test("the override is the only candidate on Windows too, and installCommand is winget", async () => {
    const other = "C:\\Users\\Ed\\.opencode\\bin\\opencode.exe";
    const fake = "C:\\fake\\opencode.cmd";
    const { versionOf, asked } = versions({ [other]: "2.2.6", [fake]: "2.0.0" });
    const status = await opencodeStatus(
      { ...env, [OVERRIDE_VAR]: fake },
      { platform: "win32", home: "C:\\Users\\Ed", ...filesOf([other, fake]), versionOf },
    );
    assert.deepEqual(asked, [fake]);
    assert.deepEqual(status, {
      found: true,
      path: fake,
      version: "2.0.0",
      supported: true,
      installCommand: INSTALL_COMMAND_WINDOWS,
    });
  });
});

describe("choosing among candidates", () => {
  const base = { platform: /** @type {NodeJS.Platform} */ ("darwin"), arch: "arm64", home: "/h" };
  const env = { HOME: "/h", PATH: "/p" };

  test("the first 2.x wins and later ones are not asked", async () => {
    const { versionOf, asked } = versions({ "/p/opencode2": "1.18.31", "/p/opencode": "2.3.0" });
    const found = await findOpencode2(env, {
      ...base,
      ...filesOf(["/p/opencode2", "/p/opencode"]),
      versionOf,
    });
    assert.deepEqual(found, { path: "/p/opencode", version: "2.3.0" });
    assert.deepEqual(asked, ["/p/opencode2", "/p/opencode"]);
    const both = versions({ "/p/opencode2": "2.2.6", "/p/opencode": "2.3.0" });
    const first = await findOpencode2(env, {
      ...base,
      ...filesOf(["/p/opencode2", "/p/opencode"]),
      versionOf: both.versionOf,
    });
    assert.equal(first?.path, "/p/opencode2");
    assert.deepEqual(both.asked, ["/p/opencode2"]);
  });

  test("a 1.x opencode alone means not installed; neither means not installed", async () => {
    const one = versions({ "/p/opencode": "1.18.31" });
    assert.equal(
      await findOpencode2(env, { ...base, ...filesOf(["/p/opencode"]), versionOf: one.versionOf }),
      null,
    );
    assert.equal(
      await findOpencode2(env, { ...base, ...filesOf([]), versionOf: one.versionOf }),
      null,
    );
  });

  test("a stale opencode2 shim of 1.x is found but unsupported when nothing is 2.x", async () => {
    const { versionOf } = versions({ "/p/opencode2": "1.18.31", "/p/opencode": "1.18.31" });
    const status = await opencodeStatus(env, {
      ...base,
      ...filesOf(["/p/opencode2", "/p/opencode"]),
      versionOf,
    });
    assert.equal(status.found, true);
    assert.equal(status.supported, false);
    assert.equal(status.version, "1.18.31");
    assert.equal(status.path, "/p/opencode2");
  });

  test("an opencode2 that does not answer is found without a version", async () => {
    const { versionOf } = versions({});
    const status = await opencodeStatus(env, { ...base, ...filesOf(["/p/opencode2"]), versionOf });
    assert.deepEqual(
      { found: status.found, version: status.version, supported: status.supported },
      { found: true, version: null, supported: false },
    );
  });

  test("an opencode that does not say its version is found, but not supported", async () => {
    const { versionOf } = versions({});
    const status = await opencodeStatus(env, { ...base, ...filesOf(["/p/opencode"]), versionOf });
    assert.deepEqual(
      {
        found: status.found,
        path: status.path,
        version: status.version,
        supported: status.supported,
      },
      { found: true, path: "/p/opencode", version: null, supported: false },
    );
    assert.equal(problem(status), "OpenCode 2 is installed but did not say which version it is.");
  });

  test("a silent opencode counts even behind a 1.x one; a 2.x one still wins", async () => {
    const two = ["/p/opencode", "/h/.opencode/bin/opencode"];
    const mixed = versions({ "/p/opencode": "1.18.31" });
    assert.deepEqual(
      await findOpencode2(env, { ...base, ...filesOf(two), versionOf: mixed.versionOf }),
      { path: "/h/.opencode/bin/opencode", version: null },
    );
    const better = versions({ "/h/.opencode/bin/opencode": "2.2.6" });
    assert.deepEqual(
      await findOpencode2(env, { ...base, ...filesOf(two), versionOf: better.versionOf }),
      { path: "/h/.opencode/bin/opencode", version: "2.2.6" },
    );
  });

  test("the well-known folders are used after PATH", async () => {
    const file = "/h/.opencode/bin/opencode";
    const { versionOf } = versions({ [file]: "2.2.6" });
    const found = await findOpencode2(
      { HOME: "/h", PATH: "/nowhere" },
      { ...base, ...filesOf([file]), versionOf },
    );
    assert.equal(found?.path, file);
  });

  test("the override is the only candidate, with ~ expanded; a missing file is null", async () => {
    const fake = "/h/fake/opencode";
    const other = "/p/opencode2";
    const { versionOf, asked } = versions({ [fake]: "1.0.0", [other]: "2.2.6" });
    const files = filesOf([fake, other]);
    const found = await findOpencode2(
      { ...env, [OVERRIDE_VAR]: " ~/fake/opencode " },
      { ...base, ...files, versionOf },
    );
    // Whatever version the override reports, even one that is not 2.x.
    assert.deepEqual(found, { path: fake, version: "1.0.0" });
    assert.deepEqual(asked, [fake]);
    assert.equal(
      await findOpencode2(
        { ...env, [OVERRIDE_VAR]: "/missing/opencode" },
        { ...base, ...files, versionOf },
      ),
      null,
    );
  });

  test("firstSupported asks in order and only as far as needed", async () => {
    const { versionOf, asked } = versions({ a: "1.0.0", b: "2.0.0", c: "2.1.0" });
    assert.deepEqual(await firstSupported(["a", "b", "c"], versionOf), {
      path: "b",
      version: "2.0.0",
    });
    assert.deepEqual(asked, ["a", "b"]);
    assert.deepEqual(await firstSupported(["a"], versionOf), { path: "a", version: "1.0.0" });
    assert.equal(await firstSupported([], versionOf), null);
  });
});

describe("status and problem sentences", () => {
  test("cliStatus", () => {
    assert.deepEqual(cliStatus(null, "darwin"), {
      found: false,
      path: null,
      version: null,
      supported: false,
      installCommand: INSTALL_COMMAND_MAC,
    });
    assert.deepEqual(cliStatus({ path: "/x", version: "2.2.6" }, "linux"), {
      found: true,
      path: "/x",
      version: "2.2.6",
      supported: true,
      installCommand: INSTALL_COMMAND_MAC,
    });
  });

  test("problem", () => {
    assert.equal(
      problem(cliStatus(null, "darwin")),
      "OpenCode 2 is not installed on the computer that runs VidAI.",
    );
    assert.equal(problem(cliStatus({ path: "/x", version: "2.2.6" })), null);
    assert.equal(
      problem(cliStatus({ path: "/x", version: "1.18.31" })),
      "OpenCode 1.18.31 is installed; VidAI needs OpenCode 2.0 or later.",
    );
    assert.equal(
      problem(cliStatus({ path: "/x", version: null })),
      "OpenCode 2 is installed but did not say which version it is.",
    );
  });
});

describe("real programs", { skip: process.platform === "win32" }, () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-oc-locate-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A script in `dir`.
   * @param {string} name
   * @param {string} body
   * @param {string} [where]
   * @returns {string}
   */
  const script = (name, body, where = dir) => {
    fs.mkdirSync(where, { recursive: true });
    const file = path.join(where, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  /** @param {string} number */
  const says = (number) => `echo "opencode v${number}"`;
  const machine = () => ({ platform: process.platform, arch: process.arch, home: dir });
  const envOf = (/** @type {Record<string, string>} */ extra = {}) => ({
    HOME: dir,
    PATH: `${dir}:/usr/bin:/bin`,
    ...extra,
  });

  test("version() parses what --version prints and switches auto-update off", async () => {
    const file = script("opencode", `echo "opencode v2.2.6 $OPENCODE_DISABLE_AUTOUPDATE"`);
    assert.equal(await version(file, envOf()), "2.2.6");
  });

  test("version() reads standard error when standard output has no version", async () => {
    const file = script("loud", 'echo "starting" ; echo "opencode v2.4.1" >&2');
    assert.equal(await version(file, envOf()), "2.4.1");
    const quiet = script("quiet", 'echo "opencode v2.5.0" >&2 ; echo "done"');
    assert.equal(await version(quiet, envOf()), "2.5.0");
  });

  test("version() is null for a failure, a missing file and no version", async () => {
    assert.equal(await version(script("bad", "exit 3"), envOf()), null);
    assert.equal(await version(path.join(dir, "missing"), envOf()), null);
    assert.equal(await version(script("silent", "echo hello"), envOf()), null);
  });

  test("version() is null when it takes longer than the limit", async () => {
    const file = script("slow", "sleep 5");
    assert.equal(await version(file, envOf(), { timeoutMs: 50 }), null);
  });

  test("2.x wins, also an opencode of 2.x alone", async () => {
    script("opencode2", says("2.2.6"));
    const found = await findOpencode2(envOf(), machine());
    assert.equal(found?.version, "2.2.6");
    assert.equal(found?.path, path.join(dir, "opencode2"));
    fs.rmSync(path.join(dir, "opencode2"));
    script("opencode", says("2.3.0"));
    assert.deepEqual(await findOpencode2(envOf(), machine()), {
      path: path.join(dir, "opencode"),
      version: "2.3.0",
    });
  });

  test("1.x alone is not installed, neither is nothing", async () => {
    assert.equal(await findOpencode2(envOf(), machine()), null);
    script("opencode", says("1.18.31"));
    assert.equal(await findOpencode2(envOf(), machine()), null);
  });

  test("1.x is unsupported when it is an opencode2 shim, and a 2.x opencode elsewhere wins", async () => {
    script("opencode2", says("1.18.31"));
    const status = await opencodeStatus(envOf(), machine());
    assert.equal(status.found, true);
    assert.equal(status.supported, false);
    assert.equal(status.version, "1.18.31");
    const elsewhere = path.join(dir, "other");
    script("opencode", says("2.0.1"), elsewhere);
    const found = await findOpencode2(envOf({ PATH: `${dir}:${elsewhere}:/usr/bin` }), machine());
    assert.deepEqual(found, { path: path.join(elsewhere, "opencode"), version: "2.0.1" });
  });

  test("the override is the only candidate", async () => {
    script("opencode2", says("2.2.6"));
    const fake = script("fake-opencode", says("2.9.9"), path.join(dir, "fakes"));
    const found = await findOpencode2(envOf({ [OVERRIDE_VAR]: fake }), machine());
    assert.deepEqual(found, { path: fake, version: "2.9.9" });
    const missing = await findOpencode2(
      envOf({ [OVERRIDE_VAR]: path.join(dir, "nope") }),
      machine(),
    );
    assert.equal(missing, null);
  });

  test("npm's links to one binary are asked once", async () => {
    const real = script("real-opencode", says("2.2.6"), path.join(dir, "lib"));
    fs.symlinkSync(real, path.join(dir, "opencode2"));
    fs.symlinkSync(real, path.join(dir, "opencode"));
    /** @type {string[]} */
    const asked = [];
    const found = await findOpencode2(envOf(), {
      ...machine(),
      versionOf: async (file) => {
        asked.push(file);
        return version(file, envOf());
      },
    });
    assert.equal(found?.version, "2.2.6");
    assert.deepEqual(asked, [path.join(dir, "opencode2")]);
    const low = script("low", says("1.1.1"), path.join(dir, "lib2"));
    fs.rmSync(path.join(dir, "opencode2"));
    fs.rmSync(path.join(dir, "opencode"));
    fs.symlinkSync(low, path.join(dir, "opencode2"));
    fs.symlinkSync(low, path.join(dir, "opencode"));
    asked.length = 0;
    const stale = await findOpencode2(envOf(), {
      ...machine(),
      versionOf: async (file) => {
        asked.push(file);
        return version(file, envOf());
      },
    });
    assert.equal(stale?.version, "1.1.1");
    assert.equal(asked.length, 1);
  });

  test("a program that hangs counts as one that did not answer", async () => {
    script("opencode2", "sleep 5");
    const status = await opencodeStatus(envOf(), { ...machine(), timeoutMs: 50 });
    assert.deepEqual(
      { found: status.found, version: status.version, supported: status.supported },
      { found: true, version: null, supported: false },
    );
  });
});

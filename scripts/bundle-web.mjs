// Builds the self-contained VidAI Web folder and zip for one target (SPEC section 12).
//
//   npm run web:bundle                                       the computer this runs on
//   npm run web:bundle -- --target aarch64-apple-darwin      Apple Silicon
//   npm run web:bundle -- --target x86_64-apple-darwin       Intel
//   npm run web:bundle -- --target universal-apple-darwin    both, one binary (lipo)
//   npm run web:bundle -- --target x86_64-pc-windows-msvc    Windows (on a Mac: cargo-xwin)
//
// Always builds the UI first, then the release server, and writes
// artifacts/web/VidAI-Web-<version>-<mac-universal|mac-arm64|mac-x64|windows-x64>/ and the same
// name with .zip. The folder is laid out so the server finds everything without environment
// variables, by the rule Tauri uses to find the resource folder of a program that is not inside a
// .app (tauri-utils, platform::resource_dir):
// - Windows: "Windows also includes the resources in the executable folder", so
//   vidai-web.exe sits next to resources/.
// - macOS: `exe_dir.join("../Resources")`, so the binary goes into bin/ and the files into
//   Resources/resources/. The picture-check helper vidai-orient is looked up next to the running
//   binary (platform::orientation::helper), so it goes into bin/ too.
//   (A folder called "target" two levels above would switch Tauri to its development rule; the
//   zip never creates one.)
import { execFile as execFileCb } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MAC_TARGETS, archsOf, checkRustTargets, macTarget } from "./mac-targets.mjs";
import {
  buildUi,
  cargoBuild,
  fail as failWith,
  root,
  run,
  targetDirectory,
} from "./web/common.mjs";

const execFile = promisify(execFileCb);
const name = "bundle-web";

/** @param {string} message @returns {never} */
const fail = (message) => failWith(name, message);

const WINDOWS_TRIPLE = "x86_64-pc-windows-msvc";
const HOST_TRIPLES = /** @type {Record<string, string>} */ ({
  "darwin arm64": "aarch64-apple-darwin",
  "darwin x64": "x86_64-apple-darwin",
  "win32 x64": WINDOWS_TRIPLE,
});

const argv = process.argv.slice(2);
/** @type {string | undefined} */
let requested;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? "";
  if (arg === "--target") requested = argv[++i];
  else if (arg.startsWith("--target=")) requested = arg.slice("--target=".length);
  else fail(`unknown argument "${arg}" (usage: node scripts/bundle-web.mjs [--target <triple>])`);
}
const host = HOST_TRIPLES[`${process.platform} ${process.arch}`];
const triple = requested ?? host;
if (!triple) fail(`this computer (${process.platform} ${process.arch}) is not supported`);

const mac = macTarget(triple);
const windows = triple === WINDOWS_TRIPLE;
if (!mac && !windows) {
  fail(
    `unknown target "${triple}" (use ${[...Object.values(MAC_TARGETS).map((t) => t.triple), WINDOWS_TRIPLE].join(", ")})`,
  );
}
if (mac && process.platform !== "darwin") fail("the Mac bundles can only be built on a Mac");
if (windows && process.platform !== "darwin" && process.platform !== "win32") {
  fail("the Windows bundle can only be built on a Mac (cargo-xwin) or on Windows");
}

const version = /** @type {{ version: string }} */ (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
).version;
const MAC_LABELS = /** @type {Record<string, string>} */ ({
  "universal-apple-darwin": "mac-universal",
  "aarch64-apple-darwin": "mac-arm64",
  "x86_64-apple-darwin": "mac-x64",
});
const label = MAC_LABELS[triple] ?? "windows-x64";
const folderName = `VidAI-Web-${version}-${label}`;
const outRoot = path.join(root, "artifacts", "web");
const folder = path.join(outRoot, folderName);
const zip = `${folder}.zip`;

if (mac) {
  try {
    await checkRustTargets(mac);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

await buildUi(name, true);

/**
 * Builds the release server for one triple (`undefined` is the host, built exactly as
 * `npm run web` does) and returns the folder holding its binaries.
 * @param {string | undefined} buildTriple
 */
async function build(buildTriple) {
  const shown = buildTriple ?? "this computer";
  console.log(`${name}: building vidai-web (release) for ${shown} ...`);
  const step = cargoBuild({ release: true, triple: buildTriple });
  const code = await run(step.command, step.args, step.env);
  if (code !== 0) fail(`cargo build for ${shown} failed (exit ${String(code)})`);
  const base = await targetDirectory();
  return path.join(base, ...(buildTriple ? [buildTriple] : []), "release");
}

/** The binaries to ship as `[name in the folder, built file]` pairs. @type {Array<[string, string]>} */
const binaries = [];
if (windows) {
  const dir = await build(triple === host ? undefined : triple);
  binaries.push(["vidai-web.exe", path.join(dir, "vidai-web.exe")]);
} else if (mac && mac.triple !== "universal-apple-darwin") {
  const dir = await build(triple === host ? undefined : triple);
  binaries.push(["vidai-web", path.join(dir, "vidai-web")]);
  binaries.push(["vidai-orient", path.join(dir, "vidai-orient")]);
} else if (mac) {
  /** @type {string[]} */
  const slices = [];
  for (const rustTarget of mac.rustTargets) slices.push(await build(rustTarget));
  const joined = path.join(root, "src-web", "target", "web-bundle-universal");
  await mkdir(joined, { recursive: true });
  for (const file of ["vidai-web", "vidai-orient"]) {
    const output = path.join(joined, file);
    await rm(output, { force: true });
    await execFile("lipo", [
      "-create",
      "-output",
      output,
      ...slices.map((dir) => path.join(dir, file)),
    ]);
    binaries.push([file, output]);
  }
}
for (const [file, source] of binaries) {
  if (!existsSync(source)) fail(`the build did not produce ${source} (needed as ${file})`);
}

// ---- Assemble the folder --------------------------------------------------------------------
await rm(folder, { recursive: true, force: true });
await rm(zip, { force: true });
const binDir = windows ? folder : path.join(folder, "bin");
const resourceDir = windows
  ? path.join(folder, "resources")
  : path.join(folder, "Resources", "resources");
await mkdir(binDir, { recursive: true });
await mkdir(resourceDir, { recursive: true });
for (const [file, source] of binaries) {
  const destination = path.join(binDir, file);
  await copyFile(source, destination);
  chmodSync(destination, 0o755);
}
for (const file of ["default_prompt.md", "toolkit.tar.gz"]) {
  await copyFile(path.join(root, "src-tauri", "resources", file), path.join(resourceDir, file));
}

const address = "http://127.0.0.1:14200";
const readmeLines = windows
  ? [
      "VidAI Web",
      "",
      "VidAI Web is VidAI in your web browser.",
      "It runs on this computer, and only this computer can open it.",
      "",
      "To start it, double-click vidai-web.exe.",
      "A console window opens and stays open while VidAI Web runs, and your browser opens VidAI.",
      "If the browser does not open, copy the address shown in that window into your browser.",
      `It starts with ${address} and ends with a long secret code, which keeps other programs and web pages from using VidAI.`,
      "To open VidAI again later, double-click vidai-web.exe again.",
      "",
      "To stop it, press Ctrl+C in the console window, or close that window after Ctrl+C.",
      "Running edits are paused first, and they continue when you start VidAI Web or the VidAI desktop app again.",
      "Press Ctrl+C a second time to stop at once.",
      "",
      "Like the VidAI desktop app, it needs Claude Code or OpenCode 2 installed on this computer.",
      "It uses the same settings and saved keys as the VidAI desktop app, so close the desktop app first.",
      "",
      "If Windows SmartScreen says it protected your PC, choose More info, then Run anyway.",
      "",
      "Keep the folder together: vidai-web.exe needs the resources folder next to it.",
    ]
  : [
      "VidAI Web",
      "",
      "VidAI Web is VidAI in your web browser.",
      "It runs on this Mac, and only this Mac can open it.",
      "",
      'To start it, double-click "Start VidAI Web.command".',
      "Terminal opens and stays open while VidAI Web runs, and your browser opens VidAI.",
      "If the browser does not open, copy the address shown in that window into your browser.",
      `It starts with ${address} and ends with a long secret code, which keeps other programs and web pages from using VidAI.`,
      'To open VidAI again later, double-click "Start VidAI Web.command" again.',
      "",
      "To stop it, press Ctrl+C in that Terminal window.",
      "Running edits are paused first, and they continue when you start VidAI Web or the VidAI desktop app again.",
      "Press Ctrl+C a second time to stop at once.",
      "",
      "Like the VidAI desktop app, it needs Claude Code or OpenCode 2 installed on this Mac.",
      "It uses the same settings and saved keys as the VidAI desktop app, so quit the desktop app first.",
      "",
      "The first time, macOS may say it cannot open the file because it is from an unidentified developer.",
      "This happens because the program is not signed by Apple, and the folder came from a download.",
      'Either right-click (or Control-click) "Start VidAI Web.command" and choose Open, then Open again,',
      "or open System Settings, Privacy & Security, scroll down and choose Open Anyway,",
      "or run this once in Terminal, with the folder path after it:",
      "    xattr -dr com.apple.quarantine <drag the VidAI Web folder here>",
      "",
      "Keep the folder together: the program in bin needs the Resources folder next to it.",
    ];
await writeFile(
  path.join(folder, "README.txt"),
  readmeLines.join(windows ? "\r\n" : "\n") + (windows ? "\r\n" : "\n"),
);

if (mac) {
  const launcher = path.join(folder, "Start VidAI Web.command");
  await writeFile(
    launcher,
    [
      "#!/bin/bash",
      "# Starts VidAI Web in this Terminal window. Press Ctrl+C to stop it.",
      'cd "$(dirname "$0")" || exit 1',
      'exec ./bin/vidai-web "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  // The same ad-hoc signature as the desktop app (see the README); it is made last on the final
  // files, because lipo and copying drop or invalidate it.
  for (const file of ["vidai-web", "vidai-orient"]) {
    await execFile("codesign", ["--force", "--sign", "-", path.join(binDir, file)]);
  }
  for (const file of ["vidai-web", "vidai-orient"]) {
    const archs = await archsOf(path.join(binDir, file));
    if (archs.join(" ") !== mac.archs.join(" ")) {
      fail(`${file} is ${archs.join(" + ")}, expected ${mac.archs.join(" + ")}`);
    }
    try {
      await execFile("codesign", ["--verify", "--strict", path.join(binDir, file)]);
    } catch (error) {
      fail(`codesign --verify failed for ${file}: ${String(error)}`);
    }
  }
}

// ---- Zip ------------------------------------------------------------------------------------
// zip keeps the executable bits and symlinks; Windows 10 and later ship a tar that writes zips.
if (process.platform === "win32") {
  await execFile("tar", ["-a", "-c", "-f", zip, "-C", outRoot, folderName]);
} else {
  await execFile("zip", ["-q", "-r", "-y", "-X", zip, folderName], { cwd: outRoot });
}

const size = (/** @type {string} */ file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)}M`;
console.log(`
${name}: VidAI Web ${version} for ${mac ? mac.label : "Windows (x64)"}
  folder  ${folder}
  zip     ${zip} (${size(zip)})
  start   ${windows ? "vidai-web.exe" : "Start VidAI Web.command"}`);

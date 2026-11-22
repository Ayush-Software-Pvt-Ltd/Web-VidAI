// Builds the Mac release of VidAI for one target, then checks what it produced.
//
//   npm run bundle:mac           universal: one .app / .dmg for Apple Silicon and Intel (recommended)
//   npm run bundle:mac:arm64     Apple Silicon only
//   npm run bundle:mac:x64       Intel only
//
// Equivalent to `npx tauri build --target <triple>` plus these checks, any of which fails the run:
// - the app binary and the vidai-orient helper inside VidAI.app hold exactly the target's
//   architectures (`lipo -archs`), and every slice is built for the minimum macOS version;
// - the app passes `codesign --verify --deep --strict` (ad-hoc signed, see the README);
// - the .dmg verifies (`hdiutil verify`) and the app inside it passes the same checks.
// It ends with the paths, sizes and architectures of the .app and the .dmg.
//
// Needs: macOS, Xcode command line tools, and the Rust targets (`rustup target add
// aarch64-apple-darwin x86_64-apple-darwin`). Set CI=true to skip the Finder window layout of
// the .dmg (Tauri then does not open the mounted image in Finder while it builds).
import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  MAC_TARGETS,
  archsOf,
  bundleDir,
  checkRustTargets,
  macTarget,
  root,
} from "./mac-targets.mjs";

const execFile = promisify(execFileCb);

/** @param {string} message */
function fail(message) {
  console.error(`bundle-mac: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 1) {
  fail(`usage: node scripts/bundle-mac.mjs <${Object.keys(MAC_TARGETS).join(" | ")}>`);
}
const target = macTarget(args[0] ?? "");
if (!target) fail(`unknown target "${args[0] ?? ""}" (use ${Object.keys(MAC_TARGETS).join(", ")})`);
if (process.platform !== "darwin") fail("the Mac bundles can only be built on a Mac");

const config =
  /** @type {{ productName: string, version: string, bundle: { macOS: { minimumSystemVersion: string } } }} */ (
    JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  );
const minimumMacos = config.bundle.macOS.minimumSystemVersion;

try {
  await checkRustTargets(target);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`bundle-mac: building VidAI for ${target.label} (${target.triple}) ...`);
const code = await new Promise((resolve) => {
  const child = spawn("npx", ["tauri", "build", "--target", target.triple], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("exit", resolve);
});
if (code !== 0) fail(`tauri build failed (exit ${String(code)})`);

const bundles = bundleDir(target, "release");
const app = path.join(bundles, "macos", `${config.productName}.app`);
const dmg = path.join(
  bundles,
  "dmg",
  `${config.productName}_${config.version}_${target.dmgSuffix}.dmg`,
);
for (const file of [app, dmg]) {
  if (!existsSync(file)) fail(`tauri build did not produce ${file}`);
}

/** @type {string[]} */
const problems = [];
await checkApp(app, "");
await checkDmg(dmg);
if (problems.length > 0) fail(`the bundles are not right:\n- ${problems.join("\n- ")}`);

const appSize = (await execFile("du", ["-sh", app])).stdout.split("\t")[0];
const dmgSize = `${(statSync(dmg).size / 1024 / 1024).toFixed(1)}M`;
console.log(`
bundle-mac: VidAI for ${target.label}, ${target.archs.join(" + ")}, macOS ${minimumMacos} or newer, ad-hoc signed
  app  ${path.relative(root, app)}  (${appSize ?? "?"})
  dmg  ${path.relative(root, dmg)}  (${dmgSize})`);

/**
 * Checks the architectures, minimum macOS version and signature of an .app.
 * @param {string} bundle
 * @param {string} where Prefix for problems ("" or "in the .dmg: ").
 */
async function checkApp(bundle, where) {
  const macos = path.join(bundle, "Contents", "MacOS");
  for (const name of [config.productName, "vidai-orient"]) {
    const file = path.join(macos, name);
    if (!existsSync(file)) {
      problems.push(`${where}${name} is missing from Contents/MacOS`);
      continue;
    }
    const archs = await archsOf(file);
    if (archs.join(" ") !== target.archs.join(" ")) {
      problems.push(
        `${where}${name} is ${archs.join(" + ")}, expected ${target.archs.join(" + ")}`,
      );
    }
    // `vtool -show-build` prints one "minos <version>" per architecture.
    const build = (await execFile("xcrun", ["vtool", "-show-build", file])).stdout;
    const minos = [...build.matchAll(/^\s*minos\s+(\S+)/gm)].map((m) => m[1]);
    if (minos.length !== target.archs.length || minos.some((v) => v !== minimumMacos)) {
      problems.push(
        `${where}${name} is built for macOS ${minos.join(", ")}, expected ${minimumMacos}`,
      );
    }
  }
  try {
    await execFile("codesign", ["--verify", "--deep", "--strict", bundle]);
  } catch (error) {
    const stderr = /** @type {{ stderr?: string }} */ (error).stderr ?? String(error);
    problems.push(`${where}codesign --verify --deep --strict failed: ${stderr.trim()}`);
  }
}

/**
 * Verifies the disk image and checks the app inside it, mounted read-only and hidden from
 * Finder.
 * @param {string} image
 */
async function checkDmg(image) {
  try {
    await execFile("hdiutil", ["verify", "-quiet", image]);
  } catch (error) {
    problems.push(`hdiutil verify failed: ${String(error)}`);
    return;
  }
  const mountPoint = await mkdtemp(path.join(tmpdir(), "vidai-dmg-"));
  try {
    await execFile("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      image,
    ]);
    try {
      const inside = path.join(mountPoint, `${config.productName}.app`);
      if (existsSync(inside)) await checkApp(inside, "in the .dmg: ");
      else problems.push(`the .dmg has no ${config.productName}.app`);
      if (!existsSync(path.join(mountPoint, "Applications"))) {
        problems.push("the .dmg has no Applications link to drag the app onto");
      }
    } finally {
      await execFile("hdiutil", ["detach", "-quiet", mountPoint]);
    }
  } finally {
    await rm(mountPoint, { recursive: true, force: true });
  }
}

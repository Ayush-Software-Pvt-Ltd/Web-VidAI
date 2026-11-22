// Builds and starts VidAI Web (SPEC section 12).
//
//   npm run web                      release server (UI built when out of date)
//   npm run web:dev                  debug server (faster build, reads dist/ from disk)
//   npm run web -- --port 15000 --no-open     every further argument goes to vidai-web
//
// The server is started directly (not through `cargo run`, not through a shell) and its output
// and input stay on this terminal. Ctrl+C: the terminal sends SIGINT to every process of the
// foreground process group (on Windows the console sends the Ctrl+C event to every process
// attached to it), so the server receives it by itself. This wrapper only has to stay alive, wait
// for the server, and end with the server's status. It must not pass Ctrl+C on again: the server
// treats a second Ctrl+C as "end now", and one key press would count twice. A second real press
// reaches the server the same way as the first. SIGTERM (macOS) is not delivered by a terminal,
// so it is passed on to the server.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUi, cargoBuild, fail, root, run, targetDirectory } from "./web/common.mjs";

const name = "web";
const argv = process.argv.slice(2);
const dev = argv[0] === "--dev";
const serverArgs = dev ? argv.slice(1) : argv;
const profile = dev ? "debug" : "release";

await buildUi(name);

const build = cargoBuild({ release: !dev });
console.log(`${name}: building vidai-web (${profile}) ...`);
const buildCode = await run(build.command, build.args, build.env);
if (buildCode !== 0) fail(name, `cargo build failed (exit ${String(buildCode)})`);

const binary = path.join(
  await targetDirectory(),
  profile,
  process.platform === "win32" ? "vidai-web.exe" : "vidai-web",
);
if (!existsSync(binary)) fail(name, `cargo did not produce ${binary}`);

const child = spawn(binary, serverArgs, { cwd: root, stdio: "inherit" });
child.on("error", (error) => fail(name, `could not start ${binary}: ${error.message}`));

// A handler is what keeps Node from ending itself on Ctrl+C; it does nothing on purpose.
process.on("SIGINT", () => {});
if (process.platform === "win32") {
  process.on("SIGBREAK", () => {});
} else {
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

child.on("exit", (code, signal) => {
  if (code !== null) process.exit(code);
  const number = signal ? os.constants.signals[signal] : undefined;
  process.exit(number === undefined ? 1 : 128 + number);
});

// Starts and ends the debug `vidai-web` for the scenarios (SPEC section 12, Server).
//
// The server prints its tokenized address at start; with `VIDAI_WEB_NO_BROWSER` (debug builds
// only) it prints `Open VidAI Web in your browser: <address>` instead of starting a browser.
// Every server started here is remembered, so the runner can end all of them, also on failure
// and on Ctrl+C.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Every server that has not ended yet. @type {Set<import("./types.mjs").Server>} */
export const running = new Set();

const OPEN = "Open VidAI Web in your browser: ";
const START_PATIENCE = 60_000;

/**
 * The environment of every server: the scenario's own folders, keys in memory, the fake Claude
 * Code, no browser. The desktop suite's `VIDAI_E2E_SCRIPT` and `VIDAI_E2E_REPORT` belong to the
 * desktop hook (`src-tauri/src/e2e.rs`, compiled into the desktop app only) and are not set; the
 * start delay of every scenario is seeded as 0 minutes. A scenario that tests the delay passes
 * `VIDAI_E2E_DELAY_MINUTE_MS` in `env`, which the core itself reads in debug builds.
 * @param {{ data: string, claude: string, fake: string, fixtures: string, env?: Record<string, string> }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function serverEnv({ data, claude, fake, fixtures, env = {} }) {
  /** @type {NodeJS.ProcessEnv} */
  const base = { ...process.env };
  for (const name of Object.keys(base)) {
    if (name.startsWith("VIDAI_") || name.startsWith("FAKE_")) delete base[name];
  }
  return {
    ...base,
    VIDAI_DATA_DIR: data,
    VIDAI_SECRETS: "memory",
    VIDAI_CLAUDE_BIN: claude,
    // The OpenCode 2 program of this computer must never run an end-to-end edit.
    VIDAI_OPENCODE2_BIN: "/nonexistent/e2e-web-no-opencode2",
    VIDAI_WEB_NO_BROWSER: "1",
    FAKE_STATE: fake,
    FAKE_CLAUDE_FIXTURES: fixtures,
    // A quick, predictable login-shell capture that does not run the developer's shell setup.
    SHELL: "/bin/sh",
    ...env,
  };
}

/**
 * Starts the server and waits until it has printed its address.
 * @param {string} binary @param {NodeJS.ProcessEnv} env @param {string} cwd
 * @param {number} [port] 0: any free port
 * @returns {Promise<import("./types.mjs").Server>}
 */
export async function startServer(binary, env, cwd, port = 0) {
  const child = spawn(binary, ["--port", String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @type {string[]} */
  const output = [];
  /** @type {string[]} */
  const errors = [];
  createInterface({ input: /** @type {NonNullable<typeof child.stdout>} */ (child.stdout) }).on(
    "line",
    (line) => output.push(line),
  );
  createInterface({ input: /** @type {NonNullable<typeof child.stderr>} */ (child.stderr) }).on(
    "line",
    (line) => errors.push(line),
  );
  /** @type {{ code: number | null, signal: string | null } | null} */
  let ended = null;
  /** @type {Array<(r: { code: number | null, signal: string | null }) => void>} */
  const waiting = [];
  child.on("exit", (code, signal) => {
    ended = { code, signal };
    for (const resume of waiting.splice(0)) resume(ended);
  });
  const exited = () =>
    new Promise((resolve) => {
      if (ended) resolve(ended);
      else waiting.push(resolve);
    });

  const started = Date.now();
  /** @type {string | null} */
  let address = null;
  while (address === null) {
    const line = output.find((l) => l.startsWith(OPEN));
    if (line) address = line.slice(OPEN.length).trim();
    else if (ended) {
      const done = /** @type {{ code: number | null, signal: string | null }} */ (ended);
      throw new Error(
        `vidai-web ended with ${String(done.code ?? done.signal)} before it said where it is:\n${[...output, ...errors].slice(-15).join("\n")}`,
      );
    } else if (Date.now() - started > START_PATIENCE) {
      child.kill("SIGKILL");
      throw new Error(
        `vidai-web did not say where it is within ${START_PATIENCE / 1000} s:\n${[...output, ...errors].slice(-15).join("\n")}`,
      );
    } else await new Promise((r) => setTimeout(r, 50));
  }
  const url = new URL(address);
  /** @type {import("./types.mjs").Server} */
  const server = {
    port: Number(url.port),
    origin: url.origin,
    address,
    token: url.searchParams.get("token") ?? "",
    child,
    output,
    errors,
    exited,
    isRunning: () => ended === null,
    async interrupt() {
      child.kill("SIGINT");
      return exited();
    },
    async kill() {
      if (ended === null) child.kill("SIGKILL");
      await exited();
    },
  };
  running.add(server);
  void exited().then(() => running.delete(server));
  return server;
}

/**
 * Ends every server still running: Ctrl+C first (it pauses edits and lets go of the data folder),
 * then at once when one does not end within `patience` ms.
 * @param {number} [patience]
 */
export async function stopAll(patience = 20_000) {
  const servers = [...running];
  await Promise.all(
    servers.map(async (server) => {
      server.child.kill("SIGINT");
      const timer = setTimeout(() => server.child.kill("SIGKILL"), patience);
      await server.exited();
      clearTimeout(timer);
    }),
  );
}

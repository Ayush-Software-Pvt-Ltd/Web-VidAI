import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createPrepare, parseBrowserPath, TEST_PROJECT_DIR } from "../../src/render/prepare.js";
import { findHyperframesCli } from "../../src/timeline/lint.js";

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const dataDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-prepare-"));
  dirs.push(d);
  return d;
};

/** @param {Partial<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>} r */
const result = (r) => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...r });

const BROWSER_OUTPUT =
  "\nBrowser ready\n   Source:  cache\n   Path:    /home/u/.cache/hyperframes/chrome/chrome-headless-shell\n";

describe("parseBrowserPath", () => {
  it("reads the Path line, also with colour codes", () => {
    assert.equal(
      parseBrowserPath(BROWSER_OUTPUT),
      "/home/u/.cache/hyperframes/chrome/chrome-headless-shell",
    );
    assert.equal(
      parseBrowserPath("  \u001b[2mPath:\u001b[0m   /x/y z/chrome  \n"),
      "/x/y z/chrome",
    );
    assert.equal(parseBrowserPath("nothing"), null);
  });
});

describe("ensureBrowser", () => {
  it("runs `browser ensure` with the pinned script and returns the path", async () => {
    /** @type {{ args: readonly string[], env: Record<string, string | undefined> }[]} */
    const calls = [];
    const prepare = createPrepare({
      hyperframesBin: "/pkg/bin/hyperframes.mjs",
      dataDir: dataDir(),
      env: { PATH: "/bin" },
      run: async (spec) => {
        calls.push({ args: spec.args ?? [], env: spec.env ?? {} });
        return result({ stdout: BROWSER_OUTPUT });
      },
    });
    assert.equal(prepare.browserPath(), null);
    const out = await prepare.ensureBrowser();
    assert.equal(prepare.browserPath(), out.path);
    assert.equal(out.ok, true);
    assert.equal(out.path, "/home/u/.cache/hyperframes/chrome/chrome-headless-shell");
    assert.deepEqual(calls[0]?.args, ["/pkg/bin/hyperframes.mjs", "browser", "ensure"]);
    assert.equal(calls[0]?.env.HYPERFRAMES_NO_TELEMETRY, "1");
  });

  it("says why it failed and never throws", async () => {
    const failing = createPrepare({
      hyperframesBin: "/b",
      dataDir: dataDir(),
      run: async () => result({ code: 1, stderr: "download failed\nno network\n" }),
    });
    const a = await failing.ensureBrowser();
    assert.equal(a.ok, false);
    assert.equal(a.message, "The renderer's browser could not be installed: no network.");
    const slow = createPrepare({
      hyperframesBin: "/b",
      dataDir: dataDir(),
      run: async () => result({ code: null, timedOut: true }),
    });
    assert.match((await slow.ensureBrowser()).message, /it took too long/u);
    const throwing = createPrepare({
      hyperframesBin: "/b",
      dataDir: dataDir(),
      run: async () => {
        throw new Error("spawn failed");
      },
    });
    assert.match((await throwing.ensureBrowser()).message, /spawn failed/u);
    const noPath = createPrepare({
      hyperframesBin: "/b",
      dataDir: dataDir(),
      run: async () => result({ stdout: "hello" }),
    });
    assert.equal((await noPath.ensureBrowser()).ok, false);
  });
});

describe("testRender", () => {
  const bin = findHyperframesCli();

  it("renders the built-in project at one worker without the GPU and cleans up", async (t) => {
    if (bin === null) return t.skip("the hyperframes package is not installed");
    const data = dataDir();
    /** @type {{ args: readonly string[], cwd?: string, env: Record<string, string | undefined> }[]} */
    const calls = [];
    const prepare = createPrepare({
      hyperframesBin: bin,
      dataDir: data,
      browserPath: () => "/fake/browser",
      run: async (spec) => {
        calls.push({
          args: spec.args ?? [],
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
          env: spec.env ?? {},
        });
        const args = spec.args ?? [];
        const out = args[args.indexOf("-o") + 1] ?? "";
        const project = args[2] ?? "";
        assert.ok(fs.existsSync(path.join(project, "index.html")));
        assert.ok(fs.existsSync(path.join(project, "shared", "gsap.min.js")));
        fs.writeFileSync(out, "mp4");
        return result({});
      },
    });
    const out = await prepare.testRender();
    assert.deepEqual(out, { ok: true, message: "A test render works." });
    const args = calls[0]?.args.join(" ") ?? "";
    assert.ok(args.includes("--workers 1"));
    assert.ok(!args.includes("--gpu"));
    assert.equal(calls[0]?.env.HYPERFRAMES_BROWSER_PATH, "/fake/browser");
    assert.deepEqual(fs.readdirSync(path.join(data, "cache", "render")), []);
  });

  it("explains a failed test render with the diagnostic sentence", async (t) => {
    if (bin === null) return t.skip("the hyperframes package is not installed");
    const prepare = createPrepare({
      hyperframesBin: bin,
      dataDir: dataDir(),
      run: async () =>
        result({
          code: 1,
          stdout: '@hf-diagnostic {"code":"PAGE_NEVER_READY"}\n✗  Render failed\n   x\n',
        }),
    });
    const out = await prepare.testRender();
    assert.equal(out.ok, false);
    assert.match(out.message, /^The test render failed\. The project's page never became ready/u);
  });

  it("reports a timeout, an empty file and a thrown error", async (t) => {
    if (bin === null) return t.skip("the hyperframes package is not installed");
    const mk = (/** @type {() => Promise<ReturnType<typeof result>>} */ run) =>
      createPrepare({ hyperframesBin: bin, dataDir: dataDir(), run });
    assert.match(
      (await mk(async () => result({ code: null, timedOut: true })).testRender()).message,
      /took too long/u,
    );
    assert.match(
      (
        await mk(async () => {
          throw new Error("boom");
        }).testRender()
      ).message,
      /could not be run: boom/u,
    );
    const empty = mk(async () => result({}));
    assert.match((await empty.testRender()).message, /could not be run/u);
  });

  it("has a built-in project of two seconds at 30 fps", () => {
    const html = fs.readFileSync(path.join(TEST_PROJECT_DIR, "index.html"), "utf8");
    assert.match(html, /data-duration="2"/u);
    assert.match(html, /data-fps="30"/u);
  });
});

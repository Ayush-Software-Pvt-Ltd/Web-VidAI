// The preview in a real browser (headless Chromium through Playwright): the HyperFrames player
// element on a host page, the project behind `/p/<token>/` in the sandboxed opaque origin, the
// message bridge, isolation from the VidAI origin and lazy media loading (docs/SPEC.md section 11).
// Skipped when Chromium or ffmpeg is not there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { sessionCookieHeader } from "../../src/http/cookies.js";
import { createPreview } from "../../src/timeline/preview.js";
import { ROOT_SCRIPT } from "../../src/timeline/rootScript.js";
import { makePreviewProject, startRouteServer } from "../support/previewHarness.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const PLAYER_JS = path.join(REPO, "node_modules/hyperframes/dist/hyperframes-player.global.js");
const GSAP_JS = path.join(REPO, "toolkit/CLAUDE_VE_ALL/gfx/_shared/js/gsap.min.js");
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "ffmpeg"].find((candidate) => {
  try {
    execFileSync(candidate, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

/** @returns {Promise<import("playwright").Browser | null>} */
async function launchChromium() {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  } catch {
    return null;
  }
}

const CLIPS = 12;
const CUT = 0.5;
const FPS = 25;

/** A 6 second clip, 99 kB: a key frame every second, sound on. */
/** @param {string} file */
function makeMedia(file) {
  execFileSync(FFMPEG ?? "ffmpeg", [
    ..."-v error -y -f lavfi -i testsrc2=size=320x180:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100".split(
      " ",
    ),
    ..."-t 6 -c:v libx264 -preset veryfast -b:v 80k -g 25 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart".split(
      " ",
    ),
    file,
  ]);
}

/** The project of the test: twelve cuts of one linked file, a motion graphic, and a probe page. */
/** @param {ReturnType<typeof makePreviewProject>} project @param {string} otherOrigin */
function writeProject(project, otherOrigin) {
  const dir = project.projectDir;
  fs.copyFileSync(GSAP_JS, path.join(dir, "shared", "gsap.min.js"));
  makeMedia(path.join(project.videoDir, "aroll", "a.mp4"));
  let clips = "";
  for (let i = 0; i < CLIPS; i += 1) {
    clips += `<video id="a-${i}" class="clip" src="assets/media/aroll.mp4" playsinline data-has-audio="true" data-start="${i * CUT}" data-duration="${CUT}" data-media-start="${i * CUT}" data-track-index="0" style="z-index:0"></video>\n`;
  }
  const total = CLIPS * CUT;
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <script src="shared/gsap.min.js"></script>
    <style>html, body { margin: 0; width: 640px; height: 360px; overflow: hidden; background: #000; } .clip { position: absolute; inset: 0; width: 640px; height: 360px; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="640" data-height="360" data-fps="${FPS}" data-duration="${total}">
${clips}      <div id="g-1" class="clip" data-composition-id="g-1" data-composition-src="compositions/g-1.html" data-start="1" data-duration="2" data-track-index="1" style="z-index:1"></div>
    </div>
    <script>${ROOT_SCRIPT}</script>
  </body>
</html>
`,
  );
  fs.writeFileSync(
    path.join(dir, "compositions", "g-1.html"),
    `<template>
  <div id="g-1-root" data-composition-id="g-1" data-width="640" data-height="360">
    <div id="g-1-card" style="position:absolute;left:20px;bottom:20px;color:#fff;font:32px sans-serif">Card</div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#g-1-card", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0);
    window.__timelines["g-1"] = tl;
  </script>
</template>
`,
  );
  // What a hostile project script could try. Results go to `window.__probe` and to the parent.
  fs.writeFileSync(
    path.join(dir, "probe.html"),
    `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(async () => {
  const out = { origin: window.origin, href: location.href };
  const run = async (name, fn) => {
    try { out[name] = await fn(); } catch (error) { out[name] = "ERROR:" + (error && error.name); }
  };
  const violations = [];
  document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
  await run("cookie", () => document.cookie);
  await run("localStorage", () => localStorage.getItem("x"));
  await run("parentCookie", () => parent.document.cookie);
  await run("whoami", async () => { const r = await fetch("/api/whoami"); return r.status + ":" + (await r.text()); });
  await run("whoamiCredentials", async () => { const r = await fetch("/api/whoami", { credentials: "include" }); return r.status; });
  await run("whoamiNoCors", async () => { const r = await fetch("/api/whoami", { mode: "no-cors", credentials: "include" }); return r.type; });
  await run("other", async () => { const r = await fetch(${JSON.stringify(otherOrigin)} + "/x"); return r.status; });
  await run("otherImage", () => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => resolve("blocked"); i.src = ${JSON.stringify(otherOrigin)} + "/img.png"; }));
  await run("own", async () => { const r = await fetch("data.json"); return r.status + ":" + (await r.text()).trim(); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  out.violations = [...new Set(violations)];
  window.__probe = out;
  parent.postMessage({ probe: out }, "*");
})();
</script></body></html>
`,
  );
  fs.writeFileSync(path.join(dir, "data.json"), '{"a":1}\n');
}

/** The host page's script (external, as the app's own policy allows only scripts from itself): the player element and a log of everything the bridge says. */
/** @param {string} previewUrl */
function hostScript(previewUrl) {
  return `window.__msgs = [];
window.__probes = [];
addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.probe) window.__probes.push(data.probe);
  if (data && data.source === "hf-preview") window.__msgs.push(data);
});
const player = document.createElement("hyperframes-player");
player.setAttribute("src", ${JSON.stringify(previewUrl)});
player.style.cssText = "display:block;width:640px;height:360px";
document.body.append(player);
window.__player = player;`;
}

const browser = FFMPEG ? await launchChromium() : null;
const skip = browser === null ? "Chromium or ffmpeg is not available" : false;

/** @param {string} text */
function listen(text) {
  /** @type {string[]} */
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(text);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        hits,
        origin: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done(undefined));
          }),
      }),
    ),
  );
}

test("the preview in Chromium", { skip, timeout: 60_000 }, async (t) => {
  const project = makePreviewProject("vidai-preview-browser-");
  const other = /** @type {{ hits: string[], origin: string, close(): Promise<void> }} */ (
    await listen("other")
  );
  writeProject(project, other.origin);
  const preview = createPreview({
    clock: { now: () => Date.now() },
    log: { info() {}, warn() {}, error() {} },
  });
  /** @type {{ site: string, cookie: string | undefined }[]} */
  const whoami = [];
  const { token, url } = preview.open({
    sessionId: "s1",
    userId: "u1",
    videoKey: "v1",
    projectDir: project.projectDir,
    videoDir: project.videoDir,
    channelDir: project.channelDir,
  });
  const server = await startRouteServer(preview.routes, (req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/host.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Set-Cookie", [sessionCookieHeader("secret-session-token"), "plain=1; Path=/"]);
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#222"><script src="/player.js"></script><script src="/host.js"></script></body></html>',
      );
      return true;
    }
    if (pathname === "/host.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(hostScript(url));
      return true;
    }
    if (pathname === "/player.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(fs.readFileSync(PLAYER_JS));
      return true;
    }
    if (pathname === "/api/whoami") {
      whoami.push({ site: String(req.headers["sec-fetch-site"]), cookie: req.headers.cookie });
      const signedIn = (req.headers.cookie ?? "").includes("vidai_session=");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.statusCode = signedIn ? 200 : 401;
      res.end(signedIn ? "signed-in" : "no");
      return true;
    }
    return false;
  });
  const context = await /** @type {import("playwright").Browser} */ (browser).newContext();
  const page = await context.newPage();
  /** @type {{ url: string, status: number, range: string | undefined }[]} */
  const responses = [];
  page.on("response", (response) => {
    responses.push({
      url: response.url().replace(server.origin, ""),
      status: response.status(),
      range: response.request().headers().range,
    });
  });
  /** The newest message of a type, as the host page saw it. */
  const lastMessage = (/** @type {string} */ type) =>
    page.evaluate(
      (type) =>
        /** @type {any[]} */ (/** @type {any} */ (globalThis).__msgs).findLast(
          (m) => m.type === type,
        ) ?? null,
      type,
    );
  /** Send a control message through the bridge, then wait for a `state` message that satisfies `until`. */
  const control = async (
    /** @type {string} */ action,
    /** @type {Record<string, unknown>} */ extra,
    /** @type {{ frame?: number, playing?: boolean, minTime?: number }} */ until,
  ) => {
    const before = await page.evaluate(() => /** @type {any} */ (globalThis).__msgs.length);
    await page.evaluate(
      ({ action, extra }) => {
        const frame = /** @type {any} */ (globalThis).__player.iframeElement;
        frame.contentWindow.postMessage(
          { source: "hf-parent", type: "control", action, ...extra },
          "*",
        );
      },
      { action, extra },
    );
    const handle = await page.waitForFunction(
      ({ before, until }) => {
        const states = /** @type {any[]} */ (/** @type {any} */ (globalThis).__msgs)
          .slice(before)
          .filter((m) => m.type === "state");
        return (
          states.find(
            (s) =>
              (until.frame === undefined || s.frame === until.frame) &&
              (until.playing === undefined || s.isPlaying === until.playing) &&
              (until.minTime === undefined || s.currentTime >= until.minTime),
          ) ?? false
        );
      },
      { before, until },
      { timeout: 15_000 },
    );
    return /** @type {any} */ (await handle.jsonValue());
  };
  const frameOf = () => {
    const frame = page
      .frames()
      .find((f) => f.url().includes(`/p/${token}/`) && !f.url().includes("probe"));
    assert.ok(frame, "the preview frame exists");
    return frame;
  };

  try {
    await page.goto(`${server.origin}/host.html`);
    await page.waitForFunction(
      () => {
        const types = new Set(
          /** @type {any[]} */ (/** @type {any} */ (globalThis).__msgs).map((m) => m.type),
        );
        return ["ready", "timeline", "state", "assets-ready"].every((type) => types.has(type));
      },
      undefined,
      { timeout: 20_000 },
    );

    await t.test("1. the player element loads the project into the sandboxed frame", async () => {
      const timeline = await lastMessage("timeline");
      assert.equal(timeline.durationSeconds, 6);
      assert.equal(timeline.durationInFrames, 150);
      assert.equal(timeline.clips.length, CLIPS + 1);
      assert.equal(timeline.compositionWidth, 640);
      const base = `/p/${token}/`;
      const ok = (/** @type {string} */ rest) =>
        responses.some((r) => r.url === base + rest && r.status < 300);
      assert.ok(ok("__hf/runtime.js"), "the runtime loaded under the token");
      assert.ok(ok("shared/gsap.min.js"));
      assert.ok(ok("compositions/g-1.html"), "the sub-composition was fetched");
      assert.ok(
        responses.some((r) => r.url === `${base}assets/media/aroll.mp4` && r.status === 206),
      );
      const frame = frameOf();
      const inside = await frame.evaluate(() => {
        const { origin, name, document } = /** @type {any} */ (globalThis);
        return {
          origin,
          name,
          card: document.querySelector("#g-1-card")?.textContent ?? null,
          videos: document.querySelectorAll("video").length,
          script: document.querySelector("head > script")?.getAttribute("src") ?? null,
        };
      });
      assert.equal(inside.origin, "null", "the frame has an opaque origin");
      assert.equal(inside.card, "Card", "the motion graphic is in the page");
      assert.equal(inside.videos, CLIPS);
      assert.equal(
        inside.script,
        `${base}__hf/runtime.js`,
        "the runtime is the first script of head",
      );
    });

    await t.test("2. the bridge: state, seek, play, pause", async () => {
      const first = await lastMessage("state");
      assert.deepEqual(first.fps, { numerator: 25, denominator: 1 });
      assert.equal(first.protocolVersion, 1);
      assert.equal(first.isPlaying, false);
      const sought = await control("seek", { timeSeconds: 2.4 }, { frame: 60 });
      assert.equal(sought.currentTime, 2.4);
      const byFrame = await control("seek", { frame: 75 }, { frame: 75 });
      assert.equal(byFrame.currentTime, 3);
      assert.equal(byFrame.isPlaying, false);
      const playing = await control("play", {}, { playing: true, minTime: 3.3 });
      assert.ok(playing.frame > 82);
      await frameOf().waitForFunction(() => {
        const { document } = /** @type {any} */ (globalThis);
        return [...document.querySelectorAll("video")].some(
          (/** @type {any} */ v) => !v.paused && v.currentTime > 0 && v.readyState >= 2,
        );
      });
      const paused = await control("pause", {}, { playing: false });
      const stillAt = paused.frame;
      await control("seek", { timeSeconds: 0 }, { frame: 0, playing: false });
      assert.ok(stillAt > 82);
    });

    await t.test("3. isolation from the VidAI origin", async () => {
      assert.equal(
        await page.evaluate(() => /** @type {any} */ (globalThis).document.cookie),
        "plain=1",
        "the host sees its own cookie",
      );
      assert.equal(await page.evaluate(() => fetch("/api/whoami").then((r) => r.status)), 200);
      await page.evaluate((src) => {
        const { document } = /** @type {any} */ (globalThis);
        const frame = document.createElement("iframe");
        frame.src = src;
        document.body.append(frame);
      }, `${url}probe.html`);
      await page.waitForFunction(() => /** @type {any} */ (globalThis).__probes.length > 0);
      const framed = await page.evaluate(() => /** @type {any} */ (globalThis).__probes[0]);
      const tab = await context.newPage();
      await tab.goto(`${server.origin}${url}probe.html`);
      await tab.waitForFunction(() => /** @type {any} */ (globalThis).__probe);
      const alone = await tab.evaluate(() => /** @type {any} */ (globalThis).__probe);
      await tab.close();
      for (const probe of [framed, alone]) {
        assert.equal(probe.origin, "null", "an opaque origin, also as a page of its own");
        assert.equal(probe.cookie, "ERROR:SecurityError", "document.cookie cannot be read");
        assert.equal(probe.localStorage, "ERROR:SecurityError");
        assert.equal(probe.parentCookie, "ERROR:SecurityError");
        assert.equal(probe.whoami, "401:no", "the VidAI cookie is not sent with its requests");
        assert.equal(probe.whoamiCredentials, "ERROR:TypeError");
        assert.equal(probe.whoamiNoCors, "opaque", "an opaque answer cannot be read");
        assert.equal(probe.other, "ERROR:TypeError", "no connection to another origin");
        assert.equal(probe.otherImage, "blocked", "no picture from another origin");
        assert.deepEqual(probe.violations.toSorted(), ["connect-src", "img-src"]);
        assert.equal(probe.own, '200:{"a":1}', "its own files still load");
      }
      assert.deepEqual(other.hits, [], "nothing reached the other server");
      const sandboxed = whoami.filter((entry) => entry.site !== "same-origin");
      assert.ok(sandboxed.length >= 6, "the probes did send their requests");
      assert.ok(
        sandboxed.every((entry) => entry.cookie === undefined),
        "none carried the cookie",
      );
    });
    await t.test("4. lazy media mode", async () => {
      const base = `/p/${token}/assets/media/aroll.mp4`;
      const frame = frameOf();
      const inside = await frame.evaluate(() => {
        const { name, document } = /** @type {any} */ (globalThis);
        return {
          name,
          preloads: [...document.querySelectorAll("video")].map(
            (/** @type {any} */ v) => v.preload,
          ),
        };
      });
      assert.equal(
        inside.name,
        "hyperframes-player",
        "the element names its frame; the runtime reads that",
      );
      assert.ok(
        inside.preloads.filter((v) => v === "auto").length <= 3,
        "only clips near the playhead preload",
      );
      assert.ok(inside.preloads.filter((v) => v === "none").length >= CLIPS / 2, "the others wait");
      assert.ok(
        responses.filter((r) => r.url === base).length <= 4,
        "few media requests for twelve clips",
      );

      // Control: the same project as a page of its own is not in the player's frame, so the runtime
      // loads every clip at once (with several hundred cuts: gigabytes of memory).
      const tab = await context.newPage();
      /** @type {string[]} */
      const tabMedia = [];
      tab.on("request", (request) => {
        if (request.url().endsWith("aroll.mp4")) tabMedia.push(request.url());
      });
      await tab.goto(`${server.origin}${url}`);
      await tab.waitForFunction(
        (count) => {
          const { document } = /** @type {any} */ (globalThis);
          const videos = [...document.querySelectorAll("video")];
          return (
            videos.length === count && videos.every((/** @type {any} */ v) => v.preload === "auto")
          );
        },
        CLIPS,
        { timeout: 15_000 },
      );
      assert.equal(await tab.evaluate(() => /** @type {any} */ (globalThis).name), "");
      assert.ok(
        tabMedia.length >= CLIPS / 2,
        `without the player element every clip loads (${tabMedia.length})`,
      );
      await tab.close();
    });

    await t.test("5. the element's own methods drive the same bridge", async () => {
      const before = await page.evaluate(() => /** @type {any} */ (globalThis).__msgs.length);
      await page.evaluate(() => {
        const player = /** @type {any} */ (globalThis).__player;
        player.seek(1);
        player.play();
      });
      await page.waitForFunction(
        (before) =>
          /** @type {any[]} */ (/** @type {any} */ (globalThis).__msgs)
            .slice(before)
            .some((m) => m.type === "state" && m.isPlaying && m.currentTime > 1.2),
        before,
        { timeout: 15_000 },
      );
      await page.evaluate(() => /** @type {any} */ (globalThis).__player.pause());
      await page.waitForFunction(
        () =>
          /** @type {any} */ (globalThis).__msgs.findLast(
            (/** @type {any} */ m) => m.type === "state",
          ).isPlaying === false,
      );
      const duration = await page.evaluate(() => /** @type {any} */ (globalThis).__player.duration);
      assert.equal(duration, 6);
    });
  } finally {
    await context.close();
    preview.stop();
    await server.close();
    await other.close();
    project.cleanup();
  }
});

test.after(async () => {
  await browser?.close();
});

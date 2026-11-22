// The browser side of the runner: one headless Chromium, a context per scenario, and the watch
// that fails a scenario on anything a user's console would show as a problem.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export const VIEWPORT = { width: 1280, height: 800 };

/** @returns {Promise<import("playwright").Browser>} */
export function launchBrowser() {
  return chromium.launch({ headless: true });
}

/**
 * Collects what must fail a scenario. A failed request is one that did not come back (network
 * error, other than the event stream that a navigation or a stopped server ends by design) or
 * came back with a status of 400 or more, unless the scenario said it expects it.
 */
export function createWatch() {
  /** @type {string[]} */
  const issues = [];
  /** @type {RegExp[]} */
  const allowed = [];
  const watched = new WeakSet();
  /** @param {string} text */
  const report = (text) => {
    if (!allowed.some((re) => re.test(text))) issues.push(text);
  };
  return {
    issues,
    /** @param {RegExp} pattern */
    allow(pattern) {
      allowed.push(pattern);
    },
    /** @param {import("playwright").Page} page */
    attach(page) {
      if (watched.has(page)) return;
      watched.add(page);
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const where = message.location().url;
        report(`console error: ${message.text()}${where ? ` (${where})` : ""}`);
      });
      page.on("pageerror", (error) => report(`page error: ${error.message}`));
      page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "failed";
        // The event stream is ended by a reload, a closed tab or a stopped server.
        if (request.url().endsWith("/api/events")) return;
        if (reason === "net::ERR_ABORTED" && page.isClosed()) return;
        report(`failed request: ${request.method()} ${request.url()} (${reason})`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          const request = response.request();
          report(
            `failed request: ${request.method()} ${response.url()} (status ${response.status()})`,
          );
        }
      });
    },
  };
}

/**
 * Makes a context of the standard viewport whose pages are watched. A Content Security Policy
 * violation is reported as a console error by Chromium and also by this listener, which names
 * the directive.
 * @param {import("playwright").Browser} browser
 * @param {ReturnType<typeof createWatch>} watch
 * @returns {Promise<import("playwright").BrowserContext>}
 */
export async function newWatchedContext(browser, watch) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    /** @type {any} */
    const page = globalThis;
    // Keeps the name of every backend event the page's event stream delivers (read-only: it
    // listens next to the app).
    const Native = page.EventSource;
    page.__vidaiEvents = [];
    page.EventSource = class extends Native {
      /** @param {string} url @param {any} [init] */
      constructor(url, init) {
        super(url, init);
        this.addEventListener("message", (/** @type {any} */ message) => {
          try {
            page.__vidaiEvents.push(String(JSON.parse(message.data).event));
          } catch {
            // not a backend event
          }
        });
      }
    };
    page.addEventListener("securitypolicyviolation", (/** @type {any} */ event) => {
      page.console.error(
        `Content-Security-Policy violation: ${String(event.violatedDirective)} blocked ${String(event.blockedURI)}`,
      );
    });
  });
  context.on("page", (page) => watch.attach(page));
  return context;
}

/**
 * Takes a screenshot once the page's finite animations have ended (a dialog or card popping in),
 * so the picture shows what a person sees a moment later.
 * @param {import("playwright").Page} page @param {string} file
 * @param {{ x: number, y: number, width: number, height: number }} [clip]
 */
export async function screenshot(page, file, clip) {
  await mkdir(path.dirname(file), { recursive: true });
  await page
    .evaluate(async () => {
      /** @type {any} */
      const doc = globalThis;
      const running = doc.document
        .getAnimations()
        .filter(
          (/** @type {any} */ a) =>
            a.playState === "running" && a.effect?.getTiming().iterations !== Infinity,
        );
      await Promise.race([
        Promise.all(running.map((/** @type {any} */ a) => a.finished.catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    })
    .catch(() => {});
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
}

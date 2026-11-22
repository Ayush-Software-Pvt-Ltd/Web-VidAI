// The in-page half of the end-to-end harness (scripts/e2e.mjs).
//
// The debug-only hook in src-tauri/src/e2e.rs evaluates this file, followed by one scenario
// step, in the app's main webview. It defines `window.__vidaiE2E` with:
// - `ui`: DOM helpers that act like a user (find by role and accessible name, click, type,
//   wait for text), with timeouts and readable failure messages;
// - `host`: requests to the runner (screenshots, disk checks, fake Claude controls), answered
//   through the app's stdin;
// - `run(params, step)`: runs one scenario step and reports `done` or `fail`.
// Reports travel as `vidai-e2e` events, which the hook appends to the report file.
//
// `params.platform` (scripts/e2e/interface.mjs) says what the interface looks like on the
// platform of the run, and `params.timeScale` how much longer every wait may take there.
(() => {
  if (window.__vidaiE2E) return;
  const internals = window.__TAURI_INTERNALS__;
  const DEFAULT_TIMEOUT = 10_000;
  /** The platform of the run, set by `run`. */
  let platform = { os: "macos", modifier: "meta" };
  let timeScale = 1;

  // ---------------------------------------------------------------------------------------
  // Reporting and runner requests
  // ---------------------------------------------------------------------------------------

  function report(payload) {
    return internals.invoke("plugin:event|emit", { event: "vidai-e2e", payload });
  }

  let nextRequest = 1;
  const pending = new Map();

  /** A request answered by the runner (`req`) or by the app's hook itself (`native`). */
  function request(op, args, timeout = 120_000, t = "req") {
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The runner did not answer "${op}" within ${timeout / 1000} s`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      report({ t, id, op, args: args ?? null }).catch(reject);
    });
  }

  function receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error));
  }

  const log = (text) => void report({ t: "log", text: String(text) });

  window.addEventListener("error", (event) => {
    void report({ t: "pageError", text: String(event.message) });
  });
  window.addEventListener("unhandledrejection", (event) => {
    void report({ t: "pageError", text: `Unhandled rejection: ${String(event.reason)}` });
  });
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    void report({ t: "consoleError", text: args.map(String).join(" ") });
    consoleError(...args);
  };

  // ---------------------------------------------------------------------------------------
  // Accessibility queries
  // ---------------------------------------------------------------------------------------

  const squash = (s) => (s ?? "").replace(/\s+/g, " ").trim();

  const IMPLICIT_ROLES = {
    button: 'button, input[type="button"], input[type="submit"], [role="button"]',
    link: "a[href], [role=link]",
    textbox:
      'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="password"], input[type="email"], [role="textbox"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    radio: 'input[type="radio"], [role="radio"]',
    heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    dialog: '[role="dialog"], [role="alertdialog"], dialog',
    alertdialog: '[role="alertdialog"]',
    navigation: 'nav, [role="navigation"]',
    complementary: 'aside, [role="complementary"]',
    // A section is a region only when it has a name (the Settings groups name themselves).
    region: 'section[aria-label], section[aria-labelledby], [role="region"]',
    list: 'ul, ol, [role="list"]',
    listitem: 'li, [role="listitem"]',
    spinbutton: 'input[type="number"], [role="spinbutton"]',
    img: 'img, [role="img"]',
  };

  function selectorFor(role) {
    return IMPLICIT_ROLES[role] ?? `[role="${role}"]`;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (el.getClientRects().length === 0) {
      // Visually hidden native inputs (custom checkboxes) still count when their label shows.
      return el instanceof HTMLInputElement && el.labels?.[0]?.getClientRects().length > 0;
    }
    return true;
  }

  /** The accessible name, close enough for this app's markup. */
  function nameOf(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      return squash(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return squash(aria);
    if (el.labels && el.labels.length > 0) {
      return squash([...el.labels].map((l) => l.textContent).join(" "));
    }
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return squash(el.getAttribute("title") || el.getAttribute("placeholder"));
    }
    if (
      tag === "DIALOG" ||
      el.getAttribute("role") === "dialog" ||
      el.getAttribute("role") === "alertdialog"
    ) {
      const title = el.querySelector("h1, h2, h3, [data-dialog-title]");
      return squash(title?.textContent);
    }
    return squash(el.textContent) || squash(el.getAttribute("title"));
  }

  function matches(actual, expected) {
    if (expected === undefined) return true;
    if (expected instanceof RegExp) return expected.test(actual);
    return actual === squash(expected);
  }

  function describe(role, name) {
    if (name === undefined) return `a ${role}`;
    return `${role} ${name instanceof RegExp ? String(name) : JSON.stringify(name)}`;
  }

  function queryAll(role, name, within = document) {
    return [...within.querySelectorAll(selectorFor(role))].filter(
      (el) => isVisible(el) && matches(nameOf(el), name),
    );
  }

  /** Visible accessible names of every element with `role`, for failure messages. */
  function namesOf(role, within = document) {
    return [...within.querySelectorAll(selectorFor(role))]
      .filter(isVisible)
      .map(nameOf)
      .filter(Boolean)
      .slice(0, 30);
  }

  // ---------------------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check, what, timeout = DEFAULT_TIMEOUT, explain) {
    timeout = Math.round((timeout ?? DEFAULT_TIMEOUT) * timeScale);
    const deadline = Date.now() + timeout;
    let lastError;
    for (;;) {
      try {
        const value = await check();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) {
        const extra = explain ? ` ${explain()}` : "";
        const cause = lastError ? ` (last error: ${lastError.message})` : "";
        // A hidden page runs no animations, so menus and dialogs never finish closing.
        const hidden =
          document.visibilityState === "visible"
            ? ""
            : ` The page is ${document.visibilityState}, so its animations do not run.`;
        throw new Error(
          `Timed out after ${timeout / 1000} s waiting for ${what}.${extra}${cause}${hidden}`,
        );
      }
      await sleep(50);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Acting like a user
  // ---------------------------------------------------------------------------------------

  function assertEnabled(el, what) {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      throw new Error(`${what} is disabled`);
    }
  }

  function pointer(el, type, init) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(
      new Ctor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: type.endsWith("down") ? 1 : 0,
        pointerType: "mouse",
        pointerId: 1,
        isPrimary: true,
        view: window,
        ...init,
      }),
    );
  }

  /** A full mouse click, so Radix triggers (which open on pointerdown) work too. */
  function clickElement(el) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    pointer(el, "pointerover", at);
    pointer(el, "pointerenter", at);
    pointer(el, "mouseover", at);
    pointer(el, "pointerdown", at);
    pointer(el, "mousedown", at);
    if (el instanceof HTMLElement && typeof el.focus === "function")
      el.focus({ preventScroll: true });
    pointer(el, "pointerup", at);
    pointer(el, "mouseup", at);
    pointer(el, "click", at);
  }

  /** Sets an input's or textarea's value so React sees the change. */
  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus({ preventScroll: true });
    setter.call(el, value);
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function keydown(target, key, modifiers = {}) {
    const init = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      composed: true,
      metaKey: !!modifiers.meta,
      shiftKey: !!modifiers.shift,
      altKey: !!modifiers.alt,
      ctrlKey: !!modifiers.ctrl,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // ---------------------------------------------------------------------------------------
  // The scenario API
  // ---------------------------------------------------------------------------------------

  /** Queries scoped to `root` (the document, or an element such as a row or a dialog). */
  function scope(root) {
    const self = {
      root,
      /** All visible elements with `role` and name. */
      all: (role, name) => queryAll(role, name, root),
      /** Waits for exactly one (the first) visible element with `role` and name. */
      find: (role, name, timeout) =>
        waitFor(
          () => queryAll(role, name, root)[0],
          describe(role, name),
          timeout,
          () => `Visible ${role} names: ${JSON.stringify(namesOf(role, root))}`,
        ),
      /** Waits until no visible element with `role` and name is left. */
      gone: (role, name, timeout) =>
        waitFor(
          () => queryAll(role, name, root).length === 0,
          `${describe(role, name)} to go away`,
          timeout,
        ),
      /** Whether such an element is visible right now. */
      has: (role, name) => queryAll(role, name, root).length > 0,
      /** Clicks the element (or the element found by role and name) like a user. */
      async click(roleOrEl, name, timeout) {
        const el =
          typeof roleOrEl === "string" ? await self.find(roleOrEl, name, timeout) : roleOrEl;
        assertEnabled(el, typeof roleOrEl === "string" ? describe(roleOrEl, name) : "The element");
        clickElement(el);
        await sleep(30);
        return el;
      },
      /** Waits until the button is enabled, then clicks it. */
      async press(name, timeout) {
        const el = await waitFor(
          () =>
            queryAll("button", name, root).find(
              (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true",
            ),
          `${describe("button", name)} to be enabled`,
          timeout,
          () => `Visible button names: ${JSON.stringify(namesOf("button", root))}`,
        );
        clickElement(el);
        await sleep(30);
        return el;
      },
      /** Replaces the text of the textbox with this label (or of the element). */
      async fill(labelOrEl, value, timeout) {
        const el =
          typeof labelOrEl === "string" || labelOrEl instanceof RegExp
            ? await self.find("textbox", labelOrEl, timeout)
            : labelOrEl;
        setValue(el, value);
        await sleep(30);
        return el;
      },
      /** Waits for visible text (substring, or a RegExp) inside this scope. */
      text: (expected, timeout) =>
        waitFor(
          () => {
            const text = squash(root === document ? document.body.innerText : root.innerText);
            return expected instanceof RegExp ? expected.test(text) : text.includes(expected);
          },
          `the text ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)}`,
          timeout,
          () =>
            `Visible text: ${JSON.stringify(squash((root === document ? document.body : root).innerText).slice(0, 600))}`,
        ),
      /** Waits until the text is no longer visible. */
      noText: (expected, timeout) =>
        waitFor(
          () => {
            const text = squash(root === document ? document.body.innerText : root.innerText);
            return !(expected instanceof RegExp ? expected.test(text) : text.includes(expected));
          },
          `the text ${JSON.stringify(String(expected))} to go away`,
          timeout,
        ),
      /** The visible text of this scope. */
      content: () => squash(root === document ? document.body.innerText : root.innerText),
    };
    return self;
  }

  const page = scope(document);

  /** The status pill of a video row: the first item of the row's detail line. */
  function pillOf(row) {
    return squash(row.querySelector('[id^="row-detail-"] > span')?.textContent);
  }

  function rowScope(row) {
    const self = scope(row);
    self.status = (expected, timeout) =>
      waitFor(
        () => matches(pillOf(row), expected),
        `the status ${JSON.stringify(String(expected))} of the row ${row.getAttribute("data-video-id")}`,
        timeout,
        () => `The status is ${JSON.stringify(pillOf(row))}.`,
      );
    self.currentStatus = () => pillOf(row);
    return self;
  }

  const ui = {
    ...page,
    sleep,
    log,
    waitFor,
    /** Queries inside one element. */
    within: (el) => scope(el),
    /** Whether an image has loaded (a broken or missing image has no natural width). */
    image: (el) => ({
      src: el.getAttribute("src"),
      loaded: !!el.complete && el.naturalWidth > 0,
      width: el.naturalWidth ?? 0,
    }),
    /** The accessible name of the focused element (`null` when nothing is focused). */
    focused: () =>
      document.activeElement && document.activeElement !== document.body
        ? nameOf(document.activeElement)
        : null,
    /** What a user sees of a control: disabled, checked, its value. */
    state: (el) => ({
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      checked: !!el.checked || el.getAttribute("aria-checked") === "true",
      value: "value" in el ? String(el.value) : null,
    }),
    /** The open dialog (with this title, if given). */
    dialog: async (title, timeout) => scope(await page.find("dialog", title, timeout)),
    /** The row of a video in the list, by its folder name, with `status(label)` to wait for
     * its status pill. */
    row: async (folderName, timeout) =>
      rowScope(
        await waitFor(
          () =>
            [...document.querySelectorAll('[role="listitem"][data-video-id]')].find((el) =>
              el.getAttribute("data-video-id").endsWith(`/${folderName}`),
            ),
          `the video row "${folderName}"`,
          timeout,
          () =>
            `Rows: ${JSON.stringify([...document.querySelectorAll('[role="listitem"][data-video-id]')].map((el) => el.getAttribute("data-video-id")))}`,
        ),
      ),
    /** Presses a key (with modifiers such as `{ meta: true }`) on the focused element. */
    key: async (key, modifiers) => {
      keydown(document.activeElement ?? document.body, key, modifiers);
      await sleep(30);
    },
    /** Presses an app shortcut: the key with the platform's modifier (Cmd on macOS, Ctrl on
     * Windows), as DOM events on the focused element. */
    shortcut: async (key, modifiers) => {
      keydown(document.activeElement ?? document.body, key, {
        ...modifiers,
        [platform.modifier]: true,
      });
      await sleep(30);
    },
    /** What the interface looks like on this platform (scripts/e2e/interface.mjs). */
    get platform() {
      return platform;
    },
    /** Answers the next native file dialog with `path` (`null` = cancelled). */
    answerNextDialog: (path) => report({ t: "pick", path }),
    /** Fails the scenario with a message unless `condition` holds. */
    assert(condition, message) {
      if (!condition) throw new Error(`Assertion failed: ${message}`);
    },
    /** Asserts two values are deeply equal (JSON). */
    equal(actual, expected, what) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
    },
  };

  const host = {
    /** Captures the VidAI window into the scenario's screenshots, once the page's finite
     * animations (a dialog or card popping in) have ended, so the picture shows what a person
     * sees a moment later. */
    shot: async (name) => {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
      await Promise.race([
        Promise.all(running.map((a) => a.finished.catch(() => {}))),
        sleep(2000),
      ]);
      return request("shot", { name });
    },
    /** Calls a runner operation (built-in or defined by the scenario). */
    call: (op, args, timeout) => request(op, args, timeout),
    /**
     * Asks the app's hook itself (src-tauri/src/e2e.rs): `window` (frame, content size, full
     * screen, zoomed, screen, View menu text size items), `appearance` (the theme the window is
     * drawn in, which native panels use), `minSize` (the smallest content size a person can
     * resize to, points), `setSize`, `maximize`, `unmaximize`, `fullscreen`, `focus`; on macOS
     * also `trafficLights` (button frames in points from the window's top left), `hitTest` (the
     * view classes a click at x, y points would reach), `blur` (focus out of the web content)
     * and `key` (Cmd with a key through AppKit).
     */
    native: (op, args, timeout) => request(op, args, timeout, "native"),
    /**
     * A real key press of an app shortcut through the OS (`=`, `+`, `-`, `0` and the keys of
     * MAC_KEY_CODES): on macOS posted through AppKit by the hook, with Cmd; on Windows sent with
     * SendInput by the runner, with Ctrl. `+` is Shift and `=` on a US keyboard.
     */
    pressShortcut: async (key) => {
      if (platform.os === "macos") {
        const keyCode = MAC_KEY_CODES[key];
        if (keyCode === undefined) throw new Error(`no macOS key code for ${key}`);
        await request("key", { characters: key, keyCode, shift: key === "+" }, 120_000, "native");
      } else {
        await request("pressKey", { key: key === "+" ? "=" : key, ctrl: true, shift: key === "+" });
      }
    },
  };

  /** Virtual key codes of a US Mac keyboard. */
  const MAC_KEY_CODES = { "=": 24, "+": 24, "-": 27, 0: 29, ",": 43, f: 3, s: 1 };

  async function run(params, step) {
    platform = params.platform ?? platform;
    timeScale = params.timeScale ?? 1;
    try {
      await step(ui, host, params);
      await report({ t: "done" });
    } catch (error) {
      await report({
        t: "fail",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        url: location.href,
      });
    }
  }

  window.__vidaiE2E = { ui, host, run, receive };
})();

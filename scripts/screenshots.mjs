// Captures the whole UI against the mock backend (no Tauri, no Claude Code) in light and dark mode,
// into artifacts/screenshots/<name>-<window>-<theme>-<text size>.png: the main window in each
// scenario, menus and popovers, the activity panel in each job state, every sheet and dialog,
// every Settings section and state, every onboarding step and the primitives gallery.
//
// Each shot is taken at two window sizes, given in points like the app window: "wide" (1240x800,
// the size of a new window) and "min" (the smallest window the app allows at that text size on
// the smallest supported screen, 1280x800 with the menu bar: 980x620 at text size 13, growing with
// the size up to 1280x775). The app scales its whole UI with the webview's page zoom
// (text size / 13, SPEC section 9, Appearance); the browser renders the same picture with a
// viewport of `points / zoom` CSS px and a device pixel ratio of `2 * zoom`, so every image has
// the window's size in points at 2x.
//
//   npm run screenshots                       every shot at the default text size (15)
//   npm run screenshots -- panel              only shots whose name contains "panel"
//   npm run screenshots -- panel min          ... and only at the "min" window size
//   npm run screenshots -- --text=11,13,20    at these text sizes (`--text=all`: 11 to 20)
//   npm run screenshots -- --theme=dark       only in dark mode
//   npm run screenshots -- --platform=windows the Windows interface (SPEC section 11), into
//                                             artifacts/screenshots-windows/
//
// With --platform=windows the page runs as it would in WebView2 on Windows (the mock's
// `?platform=windows`: Ctrl shortcuts, Windows wording and paths, no room for traffic lights), and
// every window shot gets a stand-in for the native Windows 11 title bar, drawn by this script only
// (it is not part of the page): 32 pt high, the app icon and "VidAI", the three caption buttons,
// light or dark with the theme. The window sizes are the page's size (Tauri's `width` and
// `height` are the inner size); the "min" window is the smallest one on a 1366x768 laptop at
// 100 % scaling with a 48 pt taskbar, minus the window frame (16 x 39 pt), like
// `appearance::min_window_size` with `content_room`. The real Windows fonts (Segoe UI Variable,
// Cascadia Mono) are not on a Mac, so text renders in the next font of the stack.
//
// Any shot whose selector is not found, or that logs an error, fails the run (exit code 1) after
// the other shots finished; its page is saved as FAILED-<file name>.png.
// Needs Playwright's Chromium once: `npx playwright install chromium`.
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const [filter = "", sizeFilter = ""] = args.filter((a) => !a.startsWith("--"));

/** Mirrors `TEXT_SIZE` in src/lib/types.ts. */
const TEXT_SIZE = { min: 11, max: 20, default: 15, base: 13 };
const textFlag = flag("text");
const TEXT_SIZES =
  textFlag === "all"
    ? Array.from({ length: TEXT_SIZE.max - TEXT_SIZE.min + 1 }, (_, i) => TEXT_SIZE.min + i)
    : (textFlag?.split(",").map(Number) ?? [TEXT_SIZE.default]);
for (const size of TEXT_SIZES) {
  if (!Number.isInteger(size) || size < TEXT_SIZE.min || size > TEXT_SIZE.max) {
    throw new Error(
      `--text: ${String(size)} is not a text size (${TEXT_SIZE.min} to ${TEXT_SIZE.max})`,
    );
  }
}
const THEMES = /** @type {const} */ (["light", "dark"]).filter(
  (t) => !flag("theme") || flag("theme") === t,
);
const PLATFORM = flag("platform") ?? "macos";
if (PLATFORM !== "macos" && PLATFORM !== "windows") {
  throw new Error(`--platform: ${PLATFORM} is not macos or windows`);
}
const WINDOWS = PLATFORM === "windows";
const outDir = fileURLToPath(
  new URL(
    WINDOWS ? "../artifacts/screenshots-windows/" : "../artifacts/screenshots/",
    import.meta.url,
  ),
);
/** The shortcut modifier the page listens to (src/lib/platform.ts). */
const MOD = WINDOWS ? "Control" : "Meta";
/** The window that installs Claude Code (`PlatformInfo.terminal` in src/lib/platform.ts). */
const TERMINAL = WINDOWS ? "PowerShell" : "Terminal";
/** Height of the stand-in Windows title bar, in points. */
const TITLE_BAR = 32;

/** Mirrors `appearance::MIN_LAYOUT_SIZE` and `min_window_size` in src-tauri/src/appearance.rs. */
const MIN_LAYOUT = { width: 980, height: 620 };
/**
 * The room for the page on the smallest supported screen: a 13 inch Mac (1280x800 minus the menu
 * bar), or a 1366x768 PC at 100 % (minus a 48 pt taskbar and the 16 x 39 pt window frame).
 */
const SMALL_SCREEN = WINDOWS ? { width: 1350, height: 681 } : { width: 1280, height: 775 };

/**
 * The window sizes in points at a text size.
 * @param {number} textSize
 * @returns {{ label: "wide" | "min", width: number, height: number }[]}
 */
function windowSizes(textSize) {
  const zoom = textSize / TEXT_SIZE.base;
  return [
    { label: "wide", width: 1240, height: 800 },
    {
      label: "min",
      width: Math.round(Math.min(MIN_LAYOUT.width * zoom, SMALL_SCREEN.width)),
      height: Math.round(Math.min(MIN_LAYOUT.height * zoom, SMALL_SCREEN.height)),
    },
  ];
}
const WORKERS = 4;
/** How long a selector may take to appear before the shot fails. */
const TIMEOUT_MS = 10_000;

/** @typedef {import("playwright").Page} Page */
/**
 * @typedef {object} Shot
 * @property {string} name
 * @property {string} [query] Extra URL query (mock scenarios and options).
 * @property {string | null} [ready] Selector to wait for after loading; `null` to skip.
 * @property {("wide" | "min")[]} [windows] Only at these window sizes (default: both).
 * @property {number[]} [textSizes] Only at these text sizes (default: every one asked for).
 * @property {("macos" | "windows")[]} [platforms] Only on these platforms (default: both).
 * @property {boolean} [hangLibrary] The library request never answers (loading state).
 * @property {boolean} [fullPage]
 * @property {(page: Page) => Promise<void>} [act]
 */

const HAIR = "018 Hair Oil";
const ALOE = "019 Aloe Vera Gel 5 Uses";
const MAIN_READY = "text=Glow Naturals";
const LONG_NAME = "हिंदी टेक रिव्यू चैनल - बहुत लंबा नाम Very Long Channel Name For Truncation";

// ---------------------------------------------------------------------------------------------
// Helpers (UI first; the mock's console handle `window.vidaiMock` only to set up a world)
// ---------------------------------------------------------------------------------------------

/** @param {string} prefix */
const startsWith = (prefix) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** The list row of the video whose folder name starts with `prefix`. */
const row = (/** @type {Page} */ page, /** @type {string} */ prefix) =>
  page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: startsWith(prefix) }) })
    .first();

/**
 * Clicks a row's action button (text or icon-only, both carry the label).
 * @param {Page} page
 * @param {string} prefix
 * @param {string} label
 */
async function rowAction(page, prefix, label) {
  await revealRow(page, prefix);
  await row(page, prefix).getByRole("button", { name: label, exact: true }).click();
}

/**
 * Scrolls the video list down with the mouse wheel until the row is rendered: the list is
 * virtualized, and short windows (large text sizes) render only the first rows.
 * @param {Page} page
 * @param {string} prefix
 */
async function revealRow(page, prefix) {
  const button = page.getByRole("button", { name: startsWith(prefix) }).first();
  const list = page.getByRole("list").first();
  for (let i = 0; i < 40 && (await button.count()) === 0; i++) {
    await list.hover();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(50);
  }
  await button.scrollIntoViewIfNeeded();
}

/** Opens the activity panel of a video by clicking its row. */
async function openPanel(/** @type {Page} */ page, /** @type {string} */ prefix) {
  await revealRow(page, prefix);
  await page
    .getByRole("button", { name: startsWith(prefix) })
    .first()
    .click();
  await page.getByRole("complementary", { name: "Activity" }).waitFor();
}

/**
 * Runs `fn` in the page with the mock backend (`window.vidaiMock`, see src/lib/mock) as its first
 * argument; used only to set up a world that the UI cannot reach on its own.
 * @template A
 * @param {Page} page
 * @param {(mock: any, arg: A) => unknown} fn
 * @param {A} [arg]
 */
async function withMock(page, fn, arg) {
  const mock = await page.evaluateHandle("window.vidaiMock");
  try {
    // The handle is untyped (`any`), so Playwright cannot match `fn` to an overload by itself.
    await mock.evaluate(/** @type {(mock: any, arg: unknown) => unknown} */ (fn), arg);
  } finally {
    await mock.dispose();
  }
}

/** Every mock command waits a minute from now on, to capture in-flight states. */
async function slowBackend(/** @type {Page} */ page) {
  await withMock(page, (mock) => {
    mock.options.latencyMs = 60_000;
  });
}

/**
 * Onboarding step 1, "How should VidAI run edits?": picks a setup and continues. Does nothing
 * when the scenario starts past the choice, so the shots stay valid as the onboarding changes.
 * @param {Page} page
 * @param {keyof typeof SETUP_LABEL} setup
 */
async function chooseSetup(page, setup) {
  const group = page.getByRole("radiogroup", { name: "How should VidAI run edits?" });
  if (!(await group.isVisible())) return;
  await group.getByRole("radio", { name: SETUP_LABEL[setup] }).click();
  await page.getByRole("button", { name: "Continue" }).click();
}

/**
 * Fills the card of an API option in the onboarding (key, then the model: OpenCode Go's first
 * model from its list, a typed id for the other two options) and continues.
 * @param {Page} page
 * @param {typeof API_SETUPS[number]} setup
 */
async function completeApiCard(page, setup) {
  await saveOnboardingKey(page);
  if (setup === "opencodeGo") {
    await page.getByRole("button", { name: "Model" }).click();
    await page.getByRole("dialog", { name: "Models" }).waitFor();
    await page.getByRole("option").first().click();
  } else {
    await typeModel(page, TYPED_MODEL[setup]);
  }
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Saves a key on the card of an API option in the onboarding. */
async function saveOnboardingKey(/** @type {Page} */ page) {
  // OpenCode Go needs its key; the other two options take one only if their server needs it.
  await page.getByPlaceholder(/^Paste (your|an) API key/).fill("oc_sk_live_0123456789abcdef");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByText(/^Saved, /)
    .first()
    .waitFor();
}

/** Types a model id into the Model box (options 3 and 4) and saves it with Return. */
async function typeModel(/** @type {Page} */ page, /** @type {string} */ id) {
  const box = page.getByRole("textbox", { name: "Model" });
  await box.fill(id);
  await box.press("Enter");
}

/** Picks Claude Code with the Claude subscription and waits for its install card. */
async function chooseClaudeCode(/** @type {Page} */ page) {
  await chooseSetup(page, "claudeSubscription");
  await page.getByText("Install Claude Code").first().waitFor();
}

/**
 * Opens Settings with Cmd+, and, when given, one of its sections.
 * @param {Page} page
 * @param {string} [section]
 */
async function openSettings(page, section) {
  await page.keyboard.press(`${MOD}+Comma`);
  const nav = page.getByRole("navigation", { name: "Settings" });
  await nav.waitFor();
  if (section) await nav.getByRole("button", { name: section, exact: true }).click();
}

/**
 * Opens Archive or Edit Log from the sidebar footer.
 * @param {Page} page
 * @param {string} name
 */
async function openFooterPage(page, name) {
  const footer = page.getByRole("navigation", { name: /^Archive, Edit Log/ });
  await footer.getByRole("button", { name, exact: true }).click();
  await page.getByRole("heading", { name, level: 1 }).waitFor();
}

/** Archives one failed video in the mock world, so Archive and Edit Log have something to list. */
async function archiveEarbuds(/** @type {Page} */ page) {
  await withMock(page, (mock) =>
    mock.archiveVideo("2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901/041 Best Budget Earbuds 2026"),
  );
  await page.getByRole("button", { name: startsWith("041 Best Budget Earbuds") }).waitFor({
    state: "detached",
  });
}

/** Adds `count` video folders to Tech Unboxed in the mock world. */
async function addManyVideos(/** @type {Page} */ page, /** @type {number} */ count) {
  await withMock(
    page,
    (mock, count) => {
      const folder = mock.world.disk.find(
        (/** @type {{ folderName: string }} */ f) => f.folderName === "Tech Unboxed",
      );
      for (let i = 0; i < count; i++) {
        folder.videos.push({
          folderName: `${String(200 + i)} Generated Video Number ${i} With A Reasonably Long Title`,
          arollCount: 1,
          detectedType: i % 4 === 0 ? "short" : "long",
          reviewFiles: [],
          finalFiles: [],
          thumbnails: [],
          hasMeta: false,
          hasInfo: false,
          createdAt: 0,
        });
      }
      mock.emit("libraryChanged", undefined);
    },
    count,
  );
  await page
    .getByRole("button", { name: startsWith("699 Generated") })
    .waitFor({ state: "attached" });
}

/** The library reports the Editing Folder as missing. */
async function loseEditingFolder(/** @type {Page} */ page) {
  await withMock(page, (mock) => {
    const getLibrary = mock.getLibrary;
    mock.getLibrary = async () => ({ ...(await getLibrary()), editingFolderExists: false });
    mock.emit("libraryChanged", undefined);
  });
}

/** The Settings section of how edits run (SPEC section 7a); its id is still `apiKeys`. */
const HARNESS_SECTION = "Harness + API Keys";

/** The four setups as the radio cards label them (`SETUP_INFO[...].label` in src/lib/setup.ts). */
const SETUP_LABEL = {
  claudeSubscription: "Claude Code with Claude Subscription",
  opencodeGo: "OpenCode 2 with OpenCode Go Subscription",
  anthropicApi: "Claude Code with Anthropic Compatible API",
  openaiApi: "OpenCode 2 with OpenAI Compatible API",
};

/** The three setups with a key, an address and a model of their own. */
const API_SETUPS = /** @type {const} */ (["opencodeGo", "anthropicApi", "openaiApi"]);

/** All four setups, in the order the radio cards list them. */
const ALL_SETUPS = /** @type {const} */ (["claudeSubscription", ...API_SETUPS]);

/** The two setups whose model is typed (with Fetch Models) instead of chosen from a list. */
const TYPED_SETUPS = /** @type {const} */ (["anthropicApi", "openaiApi"]);

/** The model id the screenshots type for them. */
const TYPED_MODEL = {
  anthropicApi: "claude-sonnet-5-5",
  openaiApi: "gpt-5.3",
};

/** The mock scenario that selects each API setup with its key and model saved. */
const SETUP_SCENARIO = {
  opencodeGo: "setup-opencode-go",
  anthropicApi: "setup-anthropic-api",
  openaiApi: "setup-openai-api",
};

/** Kebab-case file name part of a setup. */
const SETUP_SLUG = {
  claudeSubscription: "claude-subscription",
  opencodeGo: "opencode-go",
  anthropicApi: "anthropic-api",
  openaiApi: "openai-api",
};

/** Opens Settings, Harness + API Keys, and waits for the four radio cards. */
async function openHarness(/** @type {Page} */ page) {
  await openSettings(page, HARNESS_SECTION);
  await page.getByRole("radiogroup", { name: "How should VidAI run edits?" }).waitFor();
}

/**
 * Opens the Configure panel (address, key, model, effort, Test) of an API setup.
 * @param {Page} page
 * @param {keyof typeof SETUP_LABEL} setup
 */
async function openConfigure(page, setup) {
  const panel = page.getByRole("group", { name: `Settings of ${SETUP_LABEL[setup]}` });
  // The panel of the selected setup starts open; the others open with Configure.
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: `Configure ${SETUP_LABEL[setup]}` }).click();
  }
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  return panel;
}

/**
 * Opens the model picker inside the open Configure panel of an API setup.
 * @param {Page} page
 * @param {keyof typeof SETUP_LABEL} setup
 */
async function openModelPicker(page, setup) {
  const panel = await openConfigure(page, setup);
  await panel.getByRole("button", { name: "Model" }).click();
  await page.getByRole("dialog", { name: "Models" }).waitFor();
  return panel;
}

/** Scrolls the Program group (Claude Code or OpenCode 2, its status) into view. */
async function showProgramGroup(/** @type {Page} */ page, /** @type {string} */ status) {
  const program = page.getByRole("region", { name: "Program", exact: true });
  await program.waitFor();
  await program.getByText(status, { exact: true }).first().waitFor();
  await program.scrollIntoViewIfNeeded();
}

/**
 * Settings, Harness + API Keys, the Program group: which program does the editing, on every
 * setup (a program that is missing or logged out routes to the onboarding instead, see there), on a Mac and on Windows (Git for Windows).
 * @returns {Shot[]}
 */
function programShots() {
  /** @type {[string, string, string][]} */
  const states = [
    ["program-claude-subscription", "", "Installed"],
    ["program-anthropic-api", "scenario=setup-anthropic-api", "Installed"],
    ["program-opencode-go", "scenario=setup-opencode-go", "Installed"],
    ["program-openai-api", "scenario=setup-openai-api", "Installed"],
  ];
  /** @type {Shot[]} */
  const shots = states.map(([name, query, status]) => ({
    name,
    ...(query ? { query } : {}),
    act: async (page) => {
      await openHarness(page);
      await showProgramGroup(page, status);
    },
  }));
  shots.push({
    // Windows: Claude Code needs Git for Windows (its Git Bash runs the editing scripts).
    name: "program-git-missing",
    query: "scenario=git-bash-missing",
    platforms: ["windows"],
    act: async (page) => {
      await openHarness(page);
      await page.getByRole("region", { name: "Program", exact: true }).waitFor();
      await page.getByText("Git for Windows").first().scrollIntoViewIfNeeded();
    },
  });
  return shots;
}

/**
 * Settings, Harness + API Keys on a Mac and on Windows (every setup exists on both): the four
 * radio cards with each setup selected, each API option's form open (empty and set up), the model
 * picker in every state, Test, the unreadable Keychain, Claude Code pointed elsewhere, and the
 * Program group.
 * @returns {Shot[]}
 */
function apiKeysShots() {
  /** @type {Shot[]} */
  const list = [
    // The four setups selected: the cards, "Used for new edits", the reasons of disabled cards.
    { name: "harness", act: openHarness },
    { name: "harness-claude-subscription", query: "scenario=setup-ready", act: openHarness },
    ...API_SETUPS.map(
      (setup) =>
        /** @type {Shot} */ ({
          name: `harness-${SETUP_SLUG[setup]}`,
          query: `scenario=${SETUP_SCENARIO[setup]}`,
          act: openHarness,
        }),
    ),
    {
      // Choosing another setup: the toast names the program and the service.
      name: "harness-switched",
      query: "scenario=setup-ready",
      act: async (page) => {
        await openHarness(page);
        await page.getByRole("radio", { name: SETUP_LABEL.openaiApi }).click();
        await page
          .getByText("New edits run with OpenCode 2 on OpenAI Compatible API")
          .first()
          .waitFor();
      },
    },
    // Each API option's form open: nothing saved yet, then key and model saved.
    ...API_SETUPS.flatMap((setup) => [
      /** @type {Shot} */ ({
        name: `form-${SETUP_SLUG[setup]}-empty`,
        act: async (page) => {
          await openHarness(page);
          await openConfigure(page, setup);
          await page.getByText("No key saved.").first().waitFor();
        },
      }),
      /** @type {Shot} */ ({
        name: `form-${SETUP_SLUG[setup]}`,
        query: `scenario=${SETUP_SCENARIO[setup]}`,
        act: async (page) => {
          await openHarness(page);
          await openConfigure(page, setup);
          await page
            .getByText(/^Saved, /)
            .first()
            .waitFor();
        },
      }),
    ]),
    // The key is optional on options 3 and 4: removing it keeps the option selected.
    ...TYPED_SETUPS.map(
      (setup) =>
        /** @type {Shot} */ ({
          name: `form-${SETUP_SLUG[setup]}-no-key`,
          query: `scenario=${SETUP_SCENARIO[setup]}`,
          act: async (page) => {
            await openHarness(page);
            const panel = await openConfigure(page, setup);
            await panel.getByRole("button", { name: "Remove…" }).click();
            await page.getByRole("alertdialog").getByRole("button", { name: "Remove Key" }).click();
            await page.getByText("API key removed").first().waitFor();
            await page
              .getByText(/Leave it empty if your server needs no key/)
              .first()
              .waitFor();
            await page.getByRole("radio", { name: SETUP_LABEL[setup], checked: true }).waitFor();
          },
        }),
    ),
    // Options 3 and 4 take a typed model: Fetch Models lists what the service offers (only when
    // pressed), or says it cannot be reached.
    ...TYPED_SETUPS.flatMap((setup) => [
      /** @type {Shot} */ ({
        name: `form-${SETUP_SLUG[setup]}-fetched`,
        query: `scenario=${SETUP_SCENARIO[setup]}`,
        act: async (page) => {
          await openHarness(page);
          const panel = await openConfigure(page, setup);
          await panel.getByRole("button", { name: "Fetch Models" }).click();
          await page.getByRole("dialog", { name: "Models" }).waitFor();
          await page
            .getByText(/ models, updated /)
            .first()
            .waitFor();
        },
      }),
      /** @type {Shot} */ ({
        name: `form-${SETUP_SLUG[setup]}-fetch-failed`,
        query: `scenario=${SETUP_SCENARIO[setup]}`,
        act: async (page) => {
          await openHarness(page);
          const panel = await openConfigure(page, setup);
          // A model server on this computer that is not running.
          const address = panel.getByRole("textbox", { name: "API URL" });
          await address.fill("http://localhost:11434/v1");
          await address.press("Enter");
          await panel.getByRole("button", { name: "Reset to Default" }).waitFor();
          await panel.getByRole("button", { name: "Fetch Models" }).click();
          await panel.getByText("Could not reach the service").waitFor();
        },
      }),
    ]),
    // OpenCode Go's model list: search, no match, loading, failed and model gone.
    {
      name: `models-${SETUP_SLUG.opencodeGo}`,
      query: `scenario=${SETUP_SCENARIO.opencodeGo}`,
      act: async (page) => {
        await openHarness(page);
        await openModelPicker(page, "opencodeGo");
        await page
          .getByText(/ models, updated /)
          .first()
          .waitFor();
      },
    },
    {
      name: "models-pay-as-you-go",
      query: "scenario=setup-opencode-go",
      act: async (page) => {
        await openHarness(page);
        const panel = await openConfigure(page, "opencodeGo");
        const address = panel.getByRole("textbox", { name: "API URL" });
        await address.fill("https://opencode.ai/inference/anthropic/v1/messages");
        await address.press("Enter");
        await panel.getByRole("button", { name: "Reset to Default" }).waitFor();
        await panel.getByRole("button", { name: "Model" }).click();
        await page.getByRole("dialog", { name: "Models" }).waitFor();
        await page.getByText("86 models", { exact: false }).first().waitFor();
      },
    },
    {
      name: "models-search",
      query: "scenario=setup-opencode-go",
      act: async (page) => {
        await openHarness(page);
        await openModelPicker(page, "opencodeGo");
        await page.getByRole("combobox", { name: "Search the models" }).fill("kimi");
      },
    },
    {
      name: "models-no-match",
      query: "scenario=setup-opencode-go",
      act: async (page) => {
        await openHarness(page);
        await openModelPicker(page, "opencodeGo");
        await page.getByRole("combobox", { name: "Search the models" }).fill("sonnet 9");
        await page.getByText("No model matches").waitFor();
      },
    },
    {
      name: "models-loading",
      act: async (page) => {
        await withMock(page, (mock) => {
          mock.world.api.modelsDelayMs = 60_000;
        });
        await openHarness(page);
        await openModelPicker(page, "opencodeGo");
        await page.getByText("Loading the models").waitFor();
      },
    },
    {
      name: "models-failed",
      query: "scenario=setup-models-fail",
      act: async (page) => {
        await openHarness(page);
        await openModelPicker(page, "opencodeGo");
        await page.getByText("Could not reach OpenCode").first().waitFor();
      },
    },
    {
      name: "model-gone",
      query: "scenario=setup-model-gone",
      act: async (page) => {
        await openHarness(page);
        await openConfigure(page, "opencodeGo");
        await page.getByText("no longer offers").first().waitFor();
      },
    },
    // Test the connection: answered, refused (a key the service refuses), and an invalid address.
    ...API_SETUPS.map(
      (setup) =>
        /** @type {Shot} */ ({
          name: `test-ok-${SETUP_SLUG[setup]}`,
          query: `scenario=${SETUP_SCENARIO[setup]}`,
          act: async (page) => {
            await openHarness(page);
            const panel = await openConfigure(page, setup);
            await panel.getByRole("button", { name: "Test", exact: true }).click();
            await page
              .getByText(/ answered with /)
              .first()
              .waitFor();
          },
        }),
    ),
    {
      name: "test-refused",
      query: "scenario=setup-opencode-go",
      act: async (page) => {
        await openHarness(page);
        const panel = await openConfigure(page, "opencodeGo");
        await panel.getByPlaceholder("Paste a new key to replace it").fill("oc_sk_bad_0000000000");
        await panel.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("API key saved").first().waitFor();
        await panel.getByRole("button", { name: "Test", exact: true }).click();
        await page.getByText("OpenCode Go did not answer as expected").waitFor();
        await page.waitForTimeout(4500);
      },
    },
    {
      name: "address-invalid",
      act: async (page) => {
        await openHarness(page);
        const panel = await openConfigure(page, "opencodeGo");
        const address = panel.getByRole("textbox", { name: "API URL" });
        await address.fill("http://opencode.ai/inference/go/anthropic");
        await address.press("Enter");
        await page.getByText("Use https:// for the address").waitFor();
      },
    },
    {
      name: "key-remove",
      query: "scenario=setup-opencode-go",
      act: async (page) => {
        await openHarness(page);
        const panel = await openConfigure(page, "opencodeGo");
        await panel.getByRole("button", { name: "Remove…" }).click();
        await page.getByRole("alertdialog").waitFor();
      },
    },
    // The saved keys could not be read (the macOS Keychain, Windows Credential Manager).
    {
      name: "unreadable",
      query: "scenario=secrets-unreadable",
      act: async (page) => {
        await openHarness(page);
        await page.getByText("Your saved API keys could not be read").waitFor();
      },
    },
    // The user's own Claude Code settings point it at another service.
    {
      name: "routed",
      query: "scenario=claude-routed",
      act: async (page) => {
        await openHarness(page);
        await page.getByText("Claude Code is pointed at another service").waitFor();
      },
    },
    {
      name: "routed-anthropic-api",
      query: "scenario=claude-routed,setup-anthropic-api",
      act: async (page) => {
        await openHarness(page);
        await page.getByText("Claude Code is pointed at another service").waitFor();
      },
    },
    ...programShots(),
  ];
  return list.map((shot) => ({ ...shot, name: `settings-${shot.name}` }));
}

// ---------------------------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------------------------

/** @type {Shot[]} */
const mainShots = [
  { name: "main" },
  { name: "main-busy", query: "scenario=busy" },
  { name: "main-empty", query: "scenario=empty", ready: "text=No videos yet" },
  { name: "main-library-error", query: "scenario=library-error", ready: "text=Could not read" },
  { name: "main-usage-critical", query: "scenario=usage-critical" },
  { name: "main-usage-unavailable", query: "scenario=usage-unavailable" },
  { name: "main-usage-loading", query: "scenario=usage-loading" },
  { name: "main-loading", hangLibrary: true, ready: 'role=textbox[name="Search videos"]' },
  {
    name: "main-editing-folder-missing",
    act: async (page) => {
      await loseEditingFolder(page);
      await page.getByText("Editing Folder not found").first().waitFor();
    },
  },
  {
    name: "main-channel",
    act: async (page) => {
      await page.getByRole("navigation", { name: "Channels" }).getByText("Tech Unboxed").click();
      await page.getByRole("list", { name: "Videos in Tech Unboxed" }).waitFor();
    },
  },
  {
    name: "main-channel-missing",
    act: async (page) => {
      await page
        .getByRole("navigation", { name: "Channels" })
        .getByText("Old Recipes Archive")
        .click();
      await page.getByText("Channel folder not found").first().waitFor();
    },
  },
  {
    name: "main-search-none",
    act: async (page) => {
      await page.keyboard.press(`${MOD}+f`);
      await page.keyboard.type("zebra");
      await page.getByText("No matching videos").first().waitFor();
    },
  },
  {
    name: "main-search-hindi",
    act: async (page) => {
      await page.keyboard.press(`${MOD}+f`);
      await page.keyboard.type("बालों");
      await row(page, HAIR).waitFor();
    },
  },
  {
    name: "main-filter-edited",
    act: async (page) => {
      await page.getByRole("radio", { name: "Edited" }).click();
      await row(page, "015").waitFor();
    },
  },
  {
    name: "main-filter-none",
    act: async (page) => {
      await page.getByRole("navigation", { name: "Channels" }).getByText("Kitchen Stories").click();
      await page.getByRole("radio", { name: "Edited" }).click();
      await page.getByText("No edited videos yet").first().waitFor();
    },
  },
  {
    name: "main-long-list",
    act: async (page) => {
      await addManyVideos(page, 500);
      await page.locator("[data-video-list]").hover();
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(250);
    },
  },
  {
    name: "main-keyboard-focus",
    act: async (page) => {
      await page.keyboard.press(`${MOD}+f`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Tab");
    },
  },
  {
    name: "main-hover-row",
    act: async (page) => {
      await page.getByRole("button", { name: startsWith("041 Best Budget") }).hover();
    },
  },
  {
    name: "main-truncated-tooltip",
    // Only the narrow window truncates this name.
    windows: ["min"],
    act: async (page) => {
      await page.getByRole("button", { name: startsWith("017 Vitamin C") }).hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
  {
    name: "main-row-pending",
    act: async (page) => {
      await slowBackend(page);
      await rowAction(page, HAIR, "Pause Editing");
      await row(page, HAIR).locator('[aria-busy="true"]').waitFor();
    },
  },
  {
    name: "main-claude-status",
    act: async (page) => {
      await page.getByRole("status").filter({ hasText: "Claude Code ready" }).hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
];

/** @type {Shot[]} */
const menuShots = [
  {
    name: "menu-sort",
    act: async (page) => {
      await page.getByRole("button", { name: /^Sort videos/ }).click();
      await page.getByRole("menu").waitFor();
    },
  },
  {
    name: "menu-model",
    act: async (page) => {
      await page.getByRole("button", { name: /^Model:/ }).click();
      await page.getByRole("menu").waitFor();
    },
  },
  {
    name: "menu-effort",
    act: async (page) => {
      await page.getByRole("button", { name: /^Effort:/ }).click();
      await page.getByRole("menu").waitFor();
    },
  },
  {
    // Choosing gives focus back to the trigger; its tooltip must stay closed.
    name: "menu-effort-chosen",
    act: async (page) => {
      await page.getByRole("button", { name: /^Effort:/ }).click();
      await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
      await page.waitForTimeout(700);
      if (await page.getByRole("tooltip").count()) {
        throw new Error("the Effort tooltip opened after choosing from its menu");
      }
    },
  },
  {
    name: "menu-type",
    act: async (page) => {
      await page
        .getByRole("button", { name: /^Video type/ })
        .first()
        .click();
      await page.getByRole("menu").waitFor();
    },
  },
  {
    name: "menu-row",
    act: async (page) => {
      await page.getByRole("button", { name: startsWith("More for 017") }).click();
      await page.getByRole("menu").waitFor();
    },
  },
  {
    name: "popover-usage",
    act: async (page) => {
      await page.getByRole("button", { name: /^Usage limits/ }).click();
      await page.getByRole("dialog", { name: "Usage limits" }).waitFor();
    },
  },
  {
    name: "popover-usage-critical",
    query: "scenario=usage-critical",
    act: async (page) => {
      await page.getByRole("button", { name: /^Usage limits/ }).click();
      await page.getByRole("dialog", { name: "Usage limits" }).waitFor();
    },
  },
  // Archive and Edit Log in the main window (entries in the sidebar footer, with one video archived).
  {
    name: "main-archive",
    act: async (page) => {
      await archiveEarbuds(page);
      await openFooterPage(page, "Archive");
      await page.getByRole("button", { name: "Unarchive" }).waitFor();
    },
  },
  { name: "main-archive-empty", act: (page) => openFooterPage(page, "Archive") },
  {
    name: "main-edit-log",
    act: async (page) => {
      await archiveEarbuds(page);
      await openFooterPage(page, "Edit Log");
      await page.getByText("Archived", { exact: true }).first().waitFor();
    },
  },
  // New edits on an API setup (Macs and Windows): the top bar names the service and its model,
  // the meters show the OpenCode Go windows or why there are none, and the sidebar status is the
  // program's (OpenCode 2 needs no Claude Code at all; the Anthropic API needs no Claude login).
  ...API_SETUPS.map(
    (setup) =>
      /** @type {Shot} */ ({
        name: `main-setup-${SETUP_SLUG[setup]}`,
        query: `scenario=${SETUP_SCENARIO[setup]}`,
      }),
  ),
  {
    name: "popover-usage-opencode-go",
    query: "scenario=setup-opencode-go",
    act: async (page) => {
      await page.getByRole("button", { name: /^Usage limits/ }).click();
      await page.getByRole("dialog", { name: "Usage limits" }).waitFor();
    },
  },
  {
    name: "popover-usage-opencode-go-unavailable",
    query: "scenario=setup-usage-unavailable",
    act: async (page) => {
      await page.getByRole("button", { name: "OpenCode usage: not available" }).click();
      await page.getByRole("dialog", { name: "Usage limits" }).waitFor();
    },
  },
  ...API_SETUPS.map(
    (setup) =>
      /** @type {Shot} */ ({
        name: `tooltip-runner-${SETUP_SLUG[setup]}`,
        query: `scenario=${SETUP_SCENARIO[setup]}`,
        act: async (page) => {
          await page.getByRole("button", { name: /^New edits run with/ }).hover();
          await page.getByRole("tooltip").waitFor();
        },
      }),
  ),
  {
    name: "main-setup-opencode-go-claude-missing",
    query: "scenario=setup-opencode-go,claude-missing",
  },
  {
    name: "main-status-opencode-go-claude-missing",
    query: "scenario=setup-opencode-go,claude-missing",
    act: async (page) => {
      await page.getByRole("status").filter({ hasText: "OpenCode 2 ready" }).hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
  {
    name: "main-status-anthropic-api-logged-out",
    query: "scenario=setup-anthropic-api,claude-logged-out",
    act: async (page) => {
      await page.getByRole("status").filter({ hasText: "Claude Code ready" }).hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
];

/** @type {Shot[]} */
const panelShots = [
  { name: "panel-running", act: (page) => openPanel(page, HAIR) },
  { name: "panel-paused", act: (page) => openPanel(page, "016") },
  { name: "panel-failed", act: (page) => openPanel(page, "041") },
  { name: "panel-queued", act: (page) => openPanel(page, "042") },
  { name: "panel-never-edited", act: (page) => openPanel(page, ALOE) },
  { name: "panel-edited", act: (page) => openPanel(page, "015") },
  // The activity panel of a job that runs on each API setup (its header names the setup).
  ...API_SETUPS.map(
    (setup) =>
      /** @type {Shot} */ ({
        name: `panel-setup-${SETUP_SLUG[setup]}`,
        query: `scenario=${SETUP_SCENARIO[setup]}`,
        act: (page) => openPanel(page, HAIR),
      }),
  ),
  {
    name: "panel-edited-log",
    act: async (page) => {
      await openPanel(page, "015");
      await page.getByRole("tab", { name: "Log" }).click();
    },
  },
  {
    name: "panel-short-edited",
    act: async (page) => {
      const id = await row(page, "015").getAttribute("data-video-id");
      await withMock(page, (mock, id) => mock.setVideoTypeOverride(id, "short"), id);
      await row(page, "015").getByText("Short 9:16").waitFor();
      await openPanel(page, "015");
    },
  },
  {
    name: "panel-detail-expanded",
    act: async (page) => {
      await openPanel(page, "041");
      const details = page.getByRole("button", { name: "Show details" });
      await details.nth(1).click();
      await details.nth(1).click();
    },
  },
  {
    name: "panel-scrolled-up",
    query: "ticks=on&speed=4",
    act: async (page) => {
      await openPanel(page, HAIR);
      await page.waitForTimeout(2500);
      await page
        .locator("[data-radix-scroll-area-viewport]")
        .filter({ has: page.getByRole("log") })
        .evaluate((el) => {
          el.scrollTop = 0;
        });
      await page.waitForTimeout(1500);
    },
  },
  {
    name: "panel-pending",
    act: async (page) => {
      await openPanel(page, HAIR);
      await slowBackend(page);
      const panel = page.getByRole("complementary", { name: "Activity" });
      await panel.getByRole("button", { name: "Pause Editing" }).click();
      await panel.locator('[aria-busy="true"]').waitFor();
    },
  },
  {
    name: "panel-gone",
    act: async (page) => {
      await openPanel(page, ALOE);
      await withMock(page, (mock) => {
        /** @param {{ folderName: string }} f */
        const isGlow = (f) => f.folderName === "Glow Naturals";
        const folder = mock.world.disk.find(isGlow);
        folder.videos = folder.videos.filter(
          (/** @type {{ folderName: string }} */ v) => !v.folderName.startsWith("019"),
        );
        mock.emit("libraryChanged", undefined);
      });
      await page.getByText("This video is gone").first().waitFor();
    },
  },
  {
    name: "panel-divider-focus",
    act: async (page) => {
      await openPanel(page, HAIR);
      await page.getByRole("separator", { name: "Resize activity panel" }).focus();
      await page.keyboard.press("ArrowLeft");
    },
  },
  {
    name: "panel-widest",
    act: async (page) => {
      await openPanel(page, "015");
      await page.getByRole("separator", { name: "Resize activity panel" }).focus();
      await page.keyboard.press("End");
      await page.getByRole("separator", { name: "Resize activity panel" }).blur();
    },
  },
];

/** @type {Shot[]} */
const sheetShots = [
  {
    name: "sheet-start",
    act: async (page) => {
      await rowAction(page, ALOE, "Start Editing");
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "sheet-start-filled",
    act: async (page) => {
      // What was used last time for this video, as the backend remembers it.
      const id = await row(page, "041").getAttribute("data-video-id");
      await withMock(
        page,
        (mock, id) => {
          mock.world.videos.get(id).inputs = {
            productLinks: "https://example.com/boat-airdopes-141\nhttps://example.com/boat-case",
            notes: "Compare the bass with the 2025 model.",
            promptSlot: 0,
            styleSlot: 0,
          };
        },
        id,
      );
      await rowAction(page, "041", "Start Editing");
      await page.waitForFunction(
        "document.querySelector('textarea')?.value.includes('boat-case') === true",
      );
    },
  },
  {
    name: "sheet-start-validation",
    act: async (page) => {
      await rowAction(page, ALOE, "Start Editing");
      await page.getByLabel("Product links").fill("https://example.com/aloe\naloe gel, comb");
      await page.getByLabel("Notes").fill("Keep it under 6 minutes.");
      await page.getByRole("dialog").getByRole("button", { name: "Start Editing" }).click();
      await page.getByRole("dialog").getByRole("alert").waitFor();
    },
  },
  {
    name: "sheet-start-submitting",
    act: async (page) => {
      await rowAction(page, ALOE, "Start Editing");
      await page.getByLabel("Product links").fill("https://example.com/aloe");
      await slowBackend(page);
      await page.getByRole("dialog").getByRole("button", { name: "Start Editing" }).click();
      await page.getByRole("dialog").locator('[aria-busy="true"]').waitFor();
    },
  },
  {
    name: "sheet-start-prompt-missing",
    act: async (page) => {
      await rowAction(page, "108", "Start Editing");
      await page.getByRole("button", { name: "Open Settings" }).waitFor();
    },
  },
  {
    name: "sheet-start-open-settings",
    act: async (page) => {
      await rowAction(page, "108", "Start Editing");
      await page.getByRole("button", { name: "Open Settings" }).click();
      await page.getByRole("tab", { name: "Short 9:16", selected: true }).waitFor();
    },
  },
  {
    name: "sheet-reedit",
    act: async (page) => {
      await rowAction(page, "017", "Re-Edit");
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "sheet-reedit-validation",
    act: async (page) => {
      await rowAction(page, "017", "Re-Edit");
      await page.getByRole("dialog").getByRole("button", { name: "Re-Edit" }).click();
      await page.getByRole("dialog").getByRole("alert").waitFor();
    },
  },
  {
    name: "sheet-reedit-submitting",
    act: async (page) => {
      await rowAction(page, "017", "Re-Edit");
      await page
        .getByLabel("What should change")
        .fill(
          "Shorten the intro to 10 seconds.\nMake the price text bigger.\nReplace the b-roll at 2:10 with the close-up of the bottle.",
        );
      await slowBackend(page);
      await page.getByRole("dialog").getByRole("button", { name: "Re-Edit" }).click();
      await page.getByRole("dialog").locator('[aria-busy="true"]').waitFor();
    },
  },
  {
    name: "sheet-render",
    act: async (page) => {
      await rowAction(page, "015", "Render Final 4K");
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "sheet-render-filled",
    act: async (page) => {
      await rowAction(page, "015", "Render Final 4K");
      await page.getByRole("button", { name: "Use my exported timeline" }).click();
      await page
        .getByText(WINDOWS ? "Timeline Export.xml" : "Timeline Export.fcpxml")
        .first()
        .waitFor();
      await page.getByLabel("Notes").fill("Use the louder music mix.");
    },
  },
  {
    name: "sheet-render-validation",
    act: async (page) => {
      await rowAction(page, "015", "Render Final 4K");
      await withMock(page, (mock) => mock.queuePick("/Users/editor/Desktop/final.mov"));
      await page.getByRole("button", { name: "Use my exported timeline" }).click();
      await page.getByRole("dialog").getByRole("alert").waitFor();
    },
  },
  {
    name: "sheet-render-submitting",
    act: async (page) => {
      await rowAction(page, "015", "Render Final 4K");
      await slowBackend(page);
      await page.getByRole("dialog").getByRole("button", { name: "Render Final 4K" }).click();
      await page.getByRole("dialog").locator('[aria-busy="true"]').waitFor();
    },
  },
  {
    name: "dialog-stop",
    act: async (page) => {
      await rowAction(page, HAIR, "Stop Editing");
      await page.getByRole("alertdialog").waitFor();
    },
  },
  {
    name: "dialog-stop-queued",
    act: async (page) => {
      await rowAction(page, "042", "Stop Editing");
      await page.getByRole("alertdialog").waitFor();
    },
  },
  {
    name: "dialog-quit",
    act: async (page) => {
      await withMock(page, (mock) => mock.requestQuit());
      await page.getByRole("alertdialog").waitFor();
    },
  },
];

/** @type {Shot[]} */
const settingsShots = [
  { name: "settings-general", act: (page) => openSettings(page) },
  {
    name: "settings-general-missing",
    act: async (page) => {
      await openSettings(page);
      await loseEditingFolder(page);
      await page.getByText("This folder cannot be found").first().waitFor();
    },
  },
  {
    name: "settings-general-conflict",
    act: async (page) => {
      await openSettings(page);
      await withMock(page, (mock) => mock.queuePick("/Users/editor/Movies/Other Folder"));
      await page.getByRole("button", { name: "Change…" }).click();
      await page.getByText("cannot change while edits are active").first().waitFor();
    },
  },
  {
    name: "settings-general-max-menu",
    act: async (page) => {
      await openSettings(page);
      await page.getByLabel("Maximum simultaneous edits").click();
      await page.getByRole("listbox").waitFor();
    },
  },
  { name: "settings-appearance", act: (page) => openSettings(page, "Appearance") },
  {
    // The theme chosen in VidAI wins over the system's (the run's colour scheme).
    name: "settings-appearance-forced-dark",
    query: "theme=dark",
    act: (page) => openSettings(page, "Appearance"),
  },
  {
    name: "settings-appearance-forced-light",
    query: "theme=light",
    act: (page) => openSettings(page, "Appearance"),
  },
  {
    name: "settings-appearance-tooltip",
    act: async (page) => {
      await openSettings(page, "Appearance");
      await page.getByRole("button", { name: "Make Text Bigger" }).hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
  { name: "settings-channels", act: (page) => openSettings(page, "Channels") },
  {
    name: "settings-channels-dirty",
    act: async (page) => {
      await openSettings(page, "Channels");
      const prompt = page.getByRole("textbox", { name: "Long 16:9 prompt" });
      await prompt.click();
      // To the start of the text: Cmd+Up on macOS, Ctrl+Home on Windows.
      await prompt.press(WINDOWS ? "Control+Home" : "Meta+ArrowUp");
      await prompt.pressSequentially("NOTE: keep intros under 5 seconds.\n");
      await page.getByRole("textbox", { name: "Channel name" }).fill("Glow Naturals India");
    },
  },
  {
    name: "settings-channels-saved",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("textbox", { name: "Long 16:9 style" }).fill("Bold yellow captions.");
      await page.keyboard.press(`${MOD}+s`);
      await page.getByText("Saved", { exact: true }).first().waitFor();
    },
  },
  {
    name: "settings-channels-guard",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("textbox", { name: "Long 16:9 style" }).fill("Bold yellow captions.");
      await page.getByRole("button", { name: "Toolkit" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "settings-channels-short-tab",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "Kitchen Stories", exact: true }).click();
      await page.getByRole("tab", { name: "Short 9:16" }).click();
    },
  },
  {
    name: "settings-channels-slots",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("combobox", { name: "Long 16:9 prompt slot" }).click();
      await page.getByRole("option", { name: /^Prompt 2/ }).click();
      await page.getByRole("textbox", { name: "Prompt name, Long 16:9" }).fill("Product reviews");
    },
  },
  {
    name: "settings-channels-tools",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "Prompt Tools" }).click();
      await page.getByRole("menuitem", { name: "Copy from Another Channel" }).hover();
      await page.getByRole("menuitem", { name: "Tech Unboxed" }).waitFor();
    },
  },
  {
    name: "settings-channels-reset-confirm",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "Prompt Tools" }).click();
      await page.getByRole("menuitem", { name: "Reset to Default" }).click();
      await page.getByRole("alertdialog").waitFor();
    },
  },
  {
    name: "settings-channels-remove-confirm",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "Remove…" }).click();
      await page.getByRole("alertdialog").waitFor();
    },
  },
  {
    name: "settings-channels-new",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "New Channel" }).first().click();
      await page.getByRole("dialog").getByRole("textbox").fill("Podcast Clips");
      await page.getByRole("button", { name: "Create Channel" }).click();
      await page.getByText("already exists").first().waitFor();
    },
  },
  {
    name: "settings-channels-missing",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: /^Old Recipes Archive/ }).click();
    },
  },
  {
    name: "settings-channels-rename-conflict",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "Tech Unboxed", exact: true }).click();
      await page.getByRole("textbox", { name: "Channel name" }).fill("Tech Unboxed 2026");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Not saved").first().waitFor();
    },
  },
  {
    name: "settings-channels-long-name",
    act: async (page) => {
      await openSettings(page, "Channels");
      await page.getByRole("button", { name: "New Channel" }).first().click();
      await page.getByRole("dialog").getByRole("textbox").fill(LONG_NAME);
      await page.getByRole("button", { name: "Create Channel" }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
    },
  },
  {
    name: "settings-channels-empty",
    query: "scenario=empty",
    ready: "text=No videos yet",
    act: (page) => openSettings(page, "Channels"),
  },
  { name: "settings-toolkit", act: (page) => openSettings(page, "Toolkit") },
  {
    name: "settings-toolkit-own",
    act: async (page) => {
      await openSettings(page, "Toolkit");
      await page.getByRole("button", { name: "Create My Own Toolkit" }).click();
      await page.getByRole("radio", { name: "My own toolkit" }).click();
      await page.getByText("Used for new edits").first().waitFor();
      await page.waitForTimeout(4500);
    },
  },
  {
    name: "settings-toolkit-created",
    act: async (page) => {
      await openSettings(page, "Toolkit");
      await page.getByRole("button", { name: "Create My Own Toolkit" }).click();
      await page.getByText("Your own toolkit is ready").first().waitFor();
    },
  },
  {
    // The toast of the Toolkit section closes with Settings (see toastStore.ts).
    name: "main-after-toolkit-created",
    act: async (page) => {
      await openSettings(page, "Toolkit");
      await page.getByRole("button", { name: "Create My Own Toolkit" }).click();
      // `.first()`: for a moment the toast text can be in the page twice, which strict mode
      // refuses; detached waits until no copy is left.
      await page.getByText("Your own toolkit is ready").first().waitFor();
      await page.getByRole("button", { name: "Done" }).click();
      await page.getByRole("navigation", { name: "Channels" }).waitFor();
      await page.getByText("Your own toolkit is ready").first().waitFor({ state: "detached" });
      // Done sits in the top bar; move away so no hover shows on what is under it.
      await page.mouse.move(600, 600);
    },
  },
  ...apiKeysShots(),
  { name: "settings-system", act: (page) => openSettings(page, "System") },
  // The OpenCode 2 program (Macs and Windows): while edits run with it, unsupported, and missing.
  {
    name: "settings-system-opencode-program",
    query: "scenario=setup-opencode-go",
    act: async (page) => {
      await openSettings(page, "System");
      await page.getByRole("region", { name: "OpenCode 2", exact: true }).scrollIntoViewIfNeeded();
    },
  },
  {
    // No Claude at all: nothing of Claude Code is asked, it is information.
    name: "settings-system-no-claude",
    query: "scenario=setup-opencode-go,claude-missing",
    act: (page) => openSettings(page, "System"),
  },
  {
    // The Anthropic compatible API runs Claude Code without a Claude login.
    name: "settings-system-anthropic-api-logged-out",
    query: "scenario=setup-anthropic-api,claude-logged-out",
    act: (page) => openSettings(page, "System"),
  },
  {
    name: "settings-system-opencode-missing",
    query: "scenario=opencode2-missing",
    act: async (page) => {
      await openSettings(page, "System");
      await page.getByRole("region", { name: "OpenCode 2", exact: true }).scrollIntoViewIfNeeded();
    },
  },
  {
    name: "settings-system-opencode-unsupported",
    query: "scenario=opencode2-unsupported",
    act: async (page) => {
      await openSettings(page, "System");
      await page.getByRole("region", { name: "OpenCode 2", exact: true }).scrollIntoViewIfNeeded();
    },
  },
  {
    // The helper tools with their paths, the line about this computer and (Windows) the version.
    name: "settings-system-bottom",
    act: async (page) => {
      await openSettings(page, "System");
      await page.getByText("This computer:").waitFor();
      await page.getByText("This computer:").evaluate((el) => {
        const viewport = el.closest("[data-radix-scroll-area-viewport]");
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      });
    },
  },
  { name: "settings-import-export", act: (page) => openSettings(page, "Import / Export") },
  {
    name: "settings-import-error",
    act: async (page) => {
      await openSettings(page, "Import / Export");
      await page.getByRole("button", { name: "Import…" }).click();
      await page.getByText("were not imported").first().waitFor();
    },
  },
  {
    name: "settings-import-ok",
    act: async (page) => {
      await openSettings(page, "Import / Export");
      await withMock(page, (mock) => mock.queuePick("/Users/editor/Desktop/team-settings.json"));
      await page.getByRole("button", { name: "Import…" }).click();
      await page.getByText("Settings imported").first().waitFor();
    },
  },
  {
    name: "settings-from-sidebar",
    act: async (page) => {
      await page.getByRole("button", { name: "2 new folders found" }).click();
      await page.getByRole("heading", { name: "Found in Editing Folder" }).waitFor();
    },
  },
];

/** @type {Shot[]} */
const onboardingShots = [
  // Step 1, "How should VidAI run edits?" (shown on a new install while something blocks edits).
  {
    name: "onboarding-choice",
    query: "scenario=claude-missing,first-run",
    ready: "text=How should VidAI run edits?",
  },
  ...ALL_SETUPS.map(
    (setup) =>
      /** @type {Shot} */ ({
        name: `onboarding-choice-${SETUP_SLUG[setup]}`,
        query: "scenario=claude-missing,first-run",
        ready: "text=How should VidAI run edits?",
        act: async (page) => {
          await page.getByRole("radio", { name: SETUP_LABEL[setup] }).click();
        },
      }),
  ),
  // One card per API option: address (pre-filled), key, model, Continue; then the key saved and
  // OpenCode Go's model list open, or the model typed for the other two options.
  ...API_SETUPS.flatMap((setup) => [
    /** @type {Shot} */ ({
      name: `onboarding-${SETUP_SLUG[setup]}-form`,
      query: "scenario=claude-missing,first-run",
      ready: "text=How should VidAI run edits?",
      act: async (page) => {
        await chooseSetup(page, setup);
        await page.getByRole("textbox", { name: "API URL" }).waitFor();
      },
    }),
    setup === "opencodeGo"
      ? /** @type {Shot} */ ({
          name: `onboarding-${SETUP_SLUG[setup]}-models`,
          query: "scenario=claude-missing,first-run",
          ready: "text=How should VidAI run edits?",
          act: async (page) => {
            await chooseSetup(page, setup);
            await saveOnboardingKey(page);
            await page.getByRole("button", { name: "Model" }).click();
            await page.getByRole("dialog", { name: "Models" }).waitFor();
            await page.getByRole("option").first().waitFor();
          },
        })
      : /** @type {Shot} */ ({
          name: `onboarding-${SETUP_SLUG[setup]}-typed`,
          query: "scenario=claude-missing,first-run",
          ready: "text=How should VidAI run edits?",
          act: async (page) => {
            await chooseSetup(page, setup);
            await saveOnboardingKey(page);
            await typeModel(page, TYPED_MODEL[/** @type {"anthropicApi" | "openaiApi"} */ (setup)]);
            await page
              .getByRole("button", { name: "Continue" })
              .and(page.locator(":enabled"))
              .waitFor();
          },
        }),
  ]),
  // Options 3 and 4 need no key: a typed model alone enables Continue.
  ...TYPED_SETUPS.map(
    (setup) =>
      /** @type {Shot} */ ({
        name: `onboarding-${SETUP_SLUG[setup]}-no-key`,
        query: "scenario=claude-missing,first-run",
        ready: "text=How should VidAI run edits?",
        act: async (page) => {
          await chooseSetup(page, setup);
          await page.getByText("API Key (optional)").first().waitFor();
          await typeModel(page, TYPED_MODEL[setup]);
          await page
            .getByRole("button", { name: "Continue" })
            .and(page.locator(":enabled"))
            .waitFor();
        },
      }),
  ),
  // The program of the chosen setup is missing or a version VidAI does not drive (Macs and Windows).
  .../** @type {const} */ (["opencodeGo", "openaiApi"]).map(
    (setup) =>
      /** @type {Shot} */ ({
        name: `onboarding-${SETUP_SLUG[setup]}-program-missing`,
        query: "scenario=claude-missing,first-run,opencode2-missing",
        ready: "text=How should VidAI run edits?",
        act: async (page) => {
          await chooseSetup(page, setup);
          await completeApiCard(page, setup);
          await page.getByText("Install OpenCode 2").first().waitFor();
        },
      }),
  ),
  {
    name: "onboarding-opencode-program-unsupported",
    query: "scenario=claude-missing,first-run,opencode2-unsupported",
    ready: "text=How should VidAI run edits?",
    act: async (page) => {
      await chooseSetup(page, "opencodeGo");
      await completeApiCard(page, "opencodeGo");
      await page.getByText("Install a supported OpenCode 2").first().waitFor();
    },
  },
  {
    name: "onboarding-anthropic-api-claude-missing",
    query: "scenario=first-run,claude-missing",
    ready: "text=How should VidAI run edits?",
    act: async (page) => {
      await chooseSetup(page, "anthropicApi");
      await completeApiCard(page, "anthropicApi");
      await page.getByText("Install Claude Code").first().waitFor();
    },
  },
  // Claude Code with the Claude subscription: install card, then login card.
  {
    name: "onboarding-claude-missing",
    query: "scenario=claude-missing,first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: chooseClaudeCode,
  },
  {
    name: "onboarding-claude-missing-opened",
    query: "scenario=claude-missing,first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseClaudeCode(page);
      await page.getByRole("button", { name: `Open ${TERMINAL} to Install` }).click();
      await page.getByText("Waiting for the install").first().waitFor();
    },
  },
  {
    name: "onboarding-claude-logged-out",
    query: "scenario=claude-logged-out,first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "claudeSubscription");
      await page.getByText("Log in to Claude Code").first().waitFor();
    },
  },
  // Step 4: the Editing Folder and the channels, after the program is settled.
  {
    name: "onboarding-folder",
    query: "scenario=first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "claudeSubscription");
      await page.getByText("Choose your Editing Folder").first().waitFor();
    },
  },
  {
    name: "onboarding-channels",
    query: "scenario=first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "claudeSubscription");
      await page.getByRole("button", { name: "Choose Folder" }).click();
      await page.getByText("Travel Diaries").first().waitFor();
      await page.getByRole("checkbox").nth(2).click();
    },
  },
  {
    name: "onboarding-channels-none",
    query: "scenario=first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "claudeSubscription");
      await withMock(page, (mock) => mock.queuePick("/Users/editor/Movies/Empty"));
      await page.getByRole("button", { name: "Choose Folder" }).click();
      await page.getByText("Add your channels").first().waitFor();
      await page.getByText("no folders").first().waitFor();
    },
  },
  {
    name: "onboarding-unsupported",
    query: "scenario=unsupported-platform",
    ready: "text=does not run on this computer",
  },
  {
    name: "onboarding-git-missing",
    platforms: ["windows"],
    query: "scenario=git-bash-missing,claude-missing,first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "claudeSubscription");
      await page.getByText("Install Git for Windows").first().waitFor();
    },
  },
  {
    name: "onboarding-git-missing-opened",
    platforms: ["windows"],
    query: "scenario=git-bash-missing,first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "claudeSubscription");
      await page.getByRole("button", { name: "Download Git" }).click();
      await page.getByText("Waiting for the install").first().waitFor();
    },
  },
  {
    name: "onboarding-git-missing-anthropic-api",
    platforms: ["windows"],
    query: "scenario=git-bash-missing,first-run",
    ready:
      "text=/How should VidAI run edits\\?|Choose your Editing Folder|Install Claude Code|Log in to Claude Code|Install Git for Windows/",
    act: async (page) => {
      await chooseSetup(page, "anthropicApi");
      await completeApiCard(page, "anthropicApi");
      await page.getByText("Install Git for Windows").first().waitFor();
    },
  },
  {
    name: "onboarding-git-missing-later",
    platforms: ["windows"],
    query: "scenario=git-bash-missing",
    ready: "text=Install Git for Windows",
  },
];

/** @type {Shot[]} */
const galleryShots = [
  { name: "gallery", query: "gallery=1", ready: "text=VidAI primitives", fullPage: true },
  ...[
    ["dialog", "Open Dialog", "dialog"],
    ["sheet", "Open Sheet", "dialog"],
    ["confirm", "Open Confirm", "alertdialog"],
    ["menu", "Open Menu", "menu"],
  ].map(([suffix, button, role]) => ({
    name: `gallery-${suffix}`,
    query: "gallery=1",
    ready: "text=VidAI primitives",
    act: async (/** @type {Page} */ page) => {
      await page.getByRole("button", { name: button }).click();
      await page.getByRole(/** @type {any} */ (role)).waitFor();
    },
  })),
  {
    name: "gallery-toasts",
    query: "gallery=1",
    ready: "text=VidAI primitives",
    act: async (page) => {
      await page.getByRole("button", { name: "Toast success" }).click();
      await page.getByRole("button", { name: "Toast error" }).click();
    },
  },
];

/**
 * Job progress, the start delay and the session chip. `minute=60000` makes the mock's start delay
 * real time, so the countdown reads "Starts in 6 min" ("Earliest start in 6 min" when no slot is
 * free either).
 * @type {Shot[]}
 */
const progressShots = [
  { name: "progress-main-start-delay", query: "scenario=start-delay&minute=60000" },
  {
    name: "progress-panel-start-delay",
    query: "scenario=start-delay&minute=60000",
    act: (page) => openPanel(page, "042"),
  },
  { name: "progress-main-start-delay-full", query: "scenario=start-delay-full&minute=60000" },
  {
    name: "progress-panel-start-delay-full",
    query: "scenario=start-delay-full&minute=60000",
    act: (page) => openPanel(page, "042"),
  },
  { name: "progress-panel-stopped", act: (page) => openPanel(page, "040") },
  { name: "progress-panel-pausing", act: (page) => openPanel(page, "111") },
  {
    name: "progress-main-completed",
    act: async (page) => {
      // A running job finishes now: its bar is full for a moment before it goes away.
      await withMock(page, (mock) => {
        const job = mock.world.videos.get(
          [...mock.world.videos.keys()].find((/** @type {string} */ k) => k.includes("/039 ")),
        ).job;
        Object.assign(job, {
          state: "completed",
          endedAt: new Date().toISOString(),
          runningSince: null,
          progress: { percent: 100, stage: "Done" },
        });
        mock.emit("libraryChanged", undefined);
      });
      await row(page, "039").getByText("Edited").waitFor();
    },
  },
  {
    name: "progress-panel-session",
    act: async (page) => {
      await openPanel(page, HAIR);
      await page.locator("[data-session-chip]").focus();
      await page.getByRole("tooltip").waitFor();
    },
  },
  {
    name: "progress-settings-delay-invalid",
    act: async (page) => {
      await openSettings(page);
      const field = page.getByRole("textbox", { name: "Delay between edit starts" });
      await field.fill("150");
      await field.press("Enter");
      await page.getByRole("alert").waitFor();
    },
  },
];

const shots = [
  ...mainShots,
  ...progressShots,
  ...menuShots,
  ...panelShots,
  ...sheetShots,
  ...settingsShots,
  ...onboardingShots,
  ...galleryShots,
];

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

const names = new Set();
for (const shot of shots) {
  if (names.has(shot.name)) throw new Error(`Duplicate shot name: ${shot.name}`);
  names.add(shot.name);
}

/**
 * A free TCP port on localhost.
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  });
}

const port = await freePort();
const server = await createServer({
  root,
  logLevel: "error",
  server: { port, strictPort: true, host: "127.0.0.1", hmr: false },
});
await server.listen();
const base = `http://127.0.0.1:${port}/`;

/**
 * @typedef {object} Job
 * @property {Shot} shot
 * @property {{ label: "wide" | "min", width: number, height: number }} size in points
 * @property {"light" | "dark"} theme
 * @property {number} textSize
 */

/** @type {Job[]} */
const jobs = [];
for (const textSize of TEXT_SIZES) {
  for (const size of windowSizes(textSize).filter((s) => s.label.includes(sizeFilter))) {
    for (const theme of THEMES) {
      for (const shot of shots) {
        if (!shot.name.includes(filter)) continue;
        if (shot.windows && !shot.windows.includes(size.label)) continue;
        if (shot.textSizes && !shot.textSizes.includes(textSize)) continue;
        if (shot.platforms && !shot.platforms.includes(PLATFORM)) continue;
        jobs.push({ shot, size, theme, textSize });
      }
    }
  }
}
if (jobs.length === 0) {
  await server.close();
  throw new Error(`No shot matches "${filter}" ${sizeFilter}`);
}

if (!filter && !sizeFilter && !textFlag && !flag("theme")) {
  await rm(outDir, { recursive: true, force: true });
}
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
/** @type {string[]} */
const failures = [];
let done = 0;

const appIcon = `data:image/png;base64,${(
  await readFile(fileURLToPath(new URL("../src-tauri/icons/32x32.png", import.meta.url)))
).toString("base64")}`;

/**
 * Saves a page screenshot (`size` in points at 2x) inside a stand-in for the native Windows 11
 * title bar, which the real window draws above the page (decorations on, SPEC section 11).
 * Light or dark with the theme, like the native one follows the app theme.
 * @param {Buffer} image
 * @param {{ width: number, height: number }} size
 * @param {"light" | "dark"} theme
 * @param {string} path
 */
async function withTitleBar(image, size, theme, path) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height + TITLE_BAR },
    deviceScaleFactor: 2,
  });
  try {
    const page = await context.newPage();
    const dark = theme === "dark";
    const fg = dark ? "#ffffff" : "#1a1a1a";
    const glyph = (/** @type {string} */ d) =>
      `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="${fg}" stroke-width="1">${d}</svg>`;
    await page.setContent(`<!doctype html>
      <style>
        * { margin: 0; box-sizing: border-box; }
        body { background: ${dark ? "#202020" : "#ffffff"}; font: 12px "Segoe UI", system-ui, sans-serif; }
        .bar { height: ${TITLE_BAR}px; display: flex; align-items: center; color: ${fg}; }
        .bar img { width: 16px; height: 16px; margin: 0 8px 0 12px; }
        .bar span { flex: 1; }
        .bar i { width: 46px; height: ${TITLE_BAR}px; display: flex; align-items: center; justify-content: center; }
        .page { display: block; width: ${size.width}px; height: ${size.height}px; }
      </style>
      <div class="bar">
        <img src="${appIcon}" alt="">
        <span>VidAI</span>
        <i>${glyph('<path d="M0 5.5h10"/>')}</i>
        <i>${glyph('<rect x="0.5" y="0.5" width="9" height="9" rx="1"/>')}</i>
        <i>${glyph('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>')}</i>
      </div>
      <img class="page" src="data:image/png;base64,${image.toString("base64")}" alt="">`);
    await page.locator("img.page").evaluate((/** @type {any} */ img) => img.decode());
    await page.screenshot({ path });
  } finally {
    await context.close();
  }
}

/** @param {Job} job */
async function capture({ shot, size, theme, textSize }) {
  const file = `${shot.name}-${size.label}-${theme}-${String(textSize)}.png`;
  // The page zoom of the app, emulated: fewer CSS px, more device pixels per CSS px.
  const zoom = textSize / TEXT_SIZE.base;
  const context = await browser.newContext({
    viewport: { width: Math.round(size.width / zoom), height: Math.round(size.height / zoom) },
    deviceScaleFactor: 2 * zoom,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(TIMEOUT_MS);
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  if (shot.hangLibrary) {
    // The mock registers itself as `window.vidaiMock`; its library request then never answers.
    await page.addInitScript({
      content: `{
        let mock;
        Object.defineProperty(window, "vidaiMock", {
          configurable: true,
          get: () => mock,
          set: (value) => {
            value.getLibrary = () => new Promise(() => {});
            mock = value;
          },
        });
      }`,
    });
  }
  try {
    const ticks = shot.query?.includes("ticks=on") ? [] : ["ticks=off"];
    const platform = WINDOWS ? "platform=windows" : null;
    const query = [...ticks, "latency=0", `textSize=${String(textSize)}`, platform, shot.query]
      .filter(Boolean)
      .join("&");
    await page.goto(`${base}?${query}`);
    const ready = shot.ready === undefined ? MAIN_READY : shot.ready;
    if (ready) await page.locator(ready).first().waitFor();
    // A steady caret, so text fields do not blink between runs.
    await page.addStyleTag({ content: "*{caret-color:transparent !important}" });
    if (shot.act) await shot.act(page);
    await page.waitForTimeout(300);
    if (WINDOWS && !shot.fullPage) {
      const image = await page.screenshot();
      await withTitleBar(image, size, theme, `${outDir}${file}`);
    } else {
      await page.screenshot({ path: `${outDir}${file}`, fullPage: shot.fullPage ?? false });
    }
    if (errors.length > 0)
      failures.push(`${file}: the page logged errors:\n  ${errors.join("\n  ")}`);
  } catch (error) {
    failures.push(
      `${file}: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`,
    );
    await page.screenshot({ path: `${outDir}FAILED-${file}` }).catch(() => {});
  } finally {
    await context.close();
    done += 1;
    if (done % 20 === 0 || done === jobs.length) console.log(`${done} / ${jobs.length}`);
  }
}

try {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await capture(job);
    }),
  );
} finally {
  await browser.close();
  await server.close();
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} of ${jobs.length} screenshots FAILED:\n${failures.join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Wrote ${jobs.length} screenshots to ${outDir}`);
}

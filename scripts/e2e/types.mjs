// Type definitions (JSDoc) shared by the end-to-end runner and its scenarios. No runtime code.

/**
 * An element in the page. Scenario files are type-checked as Node code (no DOM types), and a
 * step should read element state through `ui.state` rather than the DOM.
 * @typedef {{ getAttribute(name: string): string | null }} PageElement
 */

/**
 * A query scope in the page (the document, a row, a dialog). See scripts/e2e/page/harness.js.
 * @typedef {object} Scope
 * @property {PageElement} root
 * @property {(role: string, name?: string | RegExp) => PageElement[]} all
 * @property {(role: string, name?: string | RegExp, timeout?: number) => Promise<PageElement>} find
 * @property {(role: string, name?: string | RegExp, timeout?: number) => Promise<true>} gone
 * @property {(role: string, name?: string | RegExp) => boolean} has
 * @property {(roleOrEl: string | PageElement, name?: string | RegExp, timeout?: number) => Promise<PageElement>} click
 * @property {(name: string | RegExp, timeout?: number) => Promise<PageElement>} press
 * @property {(labelOrEl: string | RegExp | PageElement, value: string, timeout?: number) => Promise<PageElement>} fill
 * @property {(expected: string | RegExp, timeout?: number) => Promise<true>} text
 * @property {(expected: string | RegExp, timeout?: number) => Promise<true>} noText
 * @property {() => string} content
 */

/**
 * A video row with its status pill.
 * @typedef {Scope & {
 *   status: (expected: string | RegExp, timeout?: number) => Promise<true>,
 *   currentStatus: () => string,
 * }} RowScope
 */

/**
 * The user-like DOM helpers a scenario step gets.
 * @typedef {Scope & {
 *   sleep: (ms: number) => Promise<void>,
 *   log: (text: unknown) => void,
 *   waitFor: <T>(check: () => T | Promise<T>, what: string, timeout?: number) => Promise<NonNullable<T>>,
 *   within: (el: PageElement) => Scope,
 *   state: (el: PageElement) => { disabled: boolean, checked: boolean, value: string | null },
 *   image: (el: PageElement) => { src: string | null, loaded: boolean, width: number },
 *   focused: () => string | null,
 *   dialog: (title?: string | RegExp, timeout?: number) => Promise<Scope>,
 *   row: (folderName: string, timeout?: number) => Promise<RowScope>,
 *   key: (key: string, modifiers?: { meta?: boolean, shift?: boolean, alt?: boolean, ctrl?: boolean }) => Promise<void>,
 *   shortcut: (key: string, modifiers?: { shift?: boolean, alt?: boolean }) => Promise<void>,
 *   platform: import("./interface.mjs").Interface,
 *   answerNextDialog: (path: string | null) => Promise<unknown>,
 *   assert: (condition: unknown, message: string) => void,
 *   equal: (actual: unknown, expected: unknown, what: string) => void,
 * }} Ui
 */

/**
 * Requests from a scenario step to the runner.
 * @typedef {object} Host
 * @property {(name: string) => Promise<unknown>} shot
 * @property {(op: string, args?: unknown, timeout?: number) => Promise<any>} call
 * @property {(op: string, args?: unknown, timeout?: number) => Promise<any>} native answered by
 *   the app's own hook (src-tauri/src/e2e.rs), not by the runner
 * @property {(key: string) => Promise<void>} pressShortcut a real key press of the app's
 *   shortcut modifier (Cmd, Ctrl) with `key` (`=`, `+`, `-`, `0`, a letter), through the OS
 */

/**
 * Plain data handed from the runner to every step of a scenario.
 * @typedef {Record<string, any>} Params
 */

/**
 * One launch of the app: the step runs in the page. It is serialized with `toString()`, so it
 * may only use its arguments (no variables from the module around it).
 * @typedef {object} Launch
 * @property {(ui: Ui, host: Host, params: Params) => Promise<void>} page
 * @property {boolean} [exits] the step makes the app quit by itself; wait for that instead of
 *   quitting it
 */

/**
 * One fake Claude Code process as recorded in the fake's state folder.
 * @typedef {object} FakeCall
 * @property {number} pid
 * @property {string} mode "new" or "resume"
 * @property {string} sid
 * @property {string} args
 * @property {string} cwd
 * @property {Record<string, string>} env the recorded environment subset
 * @property {string[]} messages the text of every user message received on stdin
 * @property {string[]} stdin every raw line received on stdin
 */

/**
 * @typedef {object} Context
 * @property {string} dir the scenario's own folder (everything below is inside it)
 * @property {string} editing the Editing Folder
 * @property {string} data the app data directory (`VIDAI_DATA_DIR`)
 * @property {string} fake the fake Claude's state folder (`FAKE_STATE`)
 * @property {boolean} real whether the real Claude Code is used
 * @property {Platform} platform the operations of the OS the run is on
 * @property {Params} params handed to every step
 * @property {(channel: string, folder: string, media: "landscape" | "portrait" | "rotated") => Promise<string>} video
 *   creates a video folder with one A-roll file and returns its path
 * @property {(settings: Record<string, any>) => Promise<void>} seedSettings writes settings.json
 * @property {() => Promise<FakeCall[]>} fakeCalls
 * @property {(name: string, content?: string) => Promise<void>} fakeSet writes a file in the
 *   fake Claude's state folder (for example `scenario` with the scenario name)
 */

/**
 * One process of the system.
 * @typedef {object} Proc
 * @property {number} pid
 * @property {number} ppid
 * @property {number | null} pgid the process group (Unix), null on Windows
 * @property {number | null} started when it started, in ms since the epoch (Windows, where
 *   process ids are reused quickly and a parent id may name a newer, unrelated process)
 * @property {string} name
 * @property {string} command the whole command line
 */

/**
 * The app's main window on screen.
 * @typedef {object} AppWindow
 * @property {string} id the window server's id of the window (macOS window number, Windows HWND)
 * @property {number[]} bounds x, y, width and height in points (macOS) or DIPs (Windows)
 * @property {any} [info] everything the platform knows about it
 */

/**
 * The platform-specific operations of the runner (scripts/e2e/macos/platform.mjs,
 * scripts/e2e/windows/platform.mjs). Everything else in scripts/e2e.mjs is the same everywhere.
 * @typedef {object} Platform
 * @property {"macos" | "windows"} name
 * @property {number} timeScale how much more time waits get on this platform
 * @property {string} appBinary the debug app's executable
 * @property {string[]} buildInputs platform files that make a rebuild necessary when changed
 * @property {() => number} builtAt when the usable end-to-end build was made (ms), 0 when none
 * @property {() => Promise<string[]>} buildArgs the Tauri CLI arguments of the debug build
 * @property {() => Promise<void>} afterBuild
 * @property {() => Promise<void>} checkBuild throws when the build cannot run here
 * @property {() => Promise<string>} start starts the helpers; describes the display
 * @property {() => Promise<void>} stop
 * @property {(env: NodeJS.ProcessEnv) => void} appEnv platform environment of the app
 * @property {(source: string, binDir: string) => Promise<string>} installFake puts the fake
 *   `claude` into `binDir`, returns its path
 * @property {(pid: number, any?: boolean) => Promise<AppWindow | null>} findWindow the process's
 *   main window when it is on screen (with `any`, also when it is not)
 * @property {(window: AppWindow, file: string) => Promise<string>} capture only that window, as a
 *   PNG; returns how it was captured
 * @property {() => Promise<Proc[]>} processes
 * @property {(file: string) => Promise<void>} clipboardSave keeps everything on the clipboard
 * @property {(file: string) => Promise<void>} clipboardRestore puts it back exactly
 * @property {() => Promise<string>} clipboardText
 * @property {(pid: number, key: string, modifiers: { ctrl?: boolean, shift?: boolean, alt?: boolean }) => Promise<void>} pressKey
 *   a real key press into the app's window (Windows; macOS posts them through the app's hook)
 * @property {(pid: number, from: number[], to: number[]) => Promise<any>} drag a real mouse drag
 *   in screen pixels, returns the window afterwards (Windows)
 * @property {(pid: number, at: number[], button: "left" | "right") => Promise<any>} click a real
 *   click at a point of the window's client area, in pixels (Windows)
 * @property {(pid: number, at: number[], delta: number, ctrl: boolean) => Promise<any>} wheel a
 *   real turn of the mouse wheel at a screen point, with Ctrl held when `ctrl` (Windows)
 * @property {(pid: number) => Promise<{ bounds: number[], foreground: boolean | null }>} cover
 *   covers the app's main window with an opaque window of the runner, as the person's own windows
 *   do (on Windows the cover is also made the foreground window); returns the covered bounds
 * @property {() => Promise<void>} uncover takes the cover away again (nothing when there is none)
 * @property {(file: string, cwd: string, env: Record<string, string | null>, timeout: number) => Promise<{ pid: number, exited: boolean, code: number | null, ms: number, coverWasForeground: boolean }>} startFromForeground
 *   starts a program from the runner's helper while its cover is the foreground window, so the
 *   program may take the foreground like one started by a click in the Start menu, and waits up
 *   to `timeout` ms for it to end (Windows)
 * @property {(width: number, height: number) => Promise<void>} setDisplay changes the primary
 *   display mode (Windows, on CI only)
 * @property {() => Promise<void>} reopen like a click on the Dock icon (macOS)
 * @property {() => Promise<boolean>} systemDark whether the system is in dark mode
 * @property {(pids: number[]) => Promise<number[]>} fakeAlive which of the process ids the fake
 *   Claude reported (`$$`, `$!`) are still running
 * @property {() => Promise<void>} watchWindows starts recording the top-level windows that show up
 * @property {() => Promise<any[]>} shownWindows stops recording and returns them (Windows)
 * @property {(identifier: string) => string} appDataDir the OS app data folder of a bundle id
 * @property {any} [helper]
 */

/**
 * @typedef {object} Scenario
 * @property {string} name short id, used on the command line and for folder names
 * @property {string} title one line for the output
 * @property {string | null} [skip] why the scenario does not run on this platform (it is reported
 *   as skipped with this reason)
 * @property {boolean} [real] needs the real Claude Code (`npm run e2e -- --real`)
 * @property {number} [timeout] for the whole scenario, in ms
 * @property {Record<string, string>} [env] more environment variables for the app, for example
 *   `VIDAI_E2E_DELAY_MINUTE_MS`
 * @property {(ctx: Context) => Promise<void>} [prepare]
 * @property {(ctx: Context) => Promise<void>} [cleanup] runs after the launches, also when one
 *   failed (for example to put back a changed display mode)
 * @property {Record<string, Function>} [shared] functions the steps share; they run in the page,
 *   as `window.__vidaiShared.<name>`
 * @property {Launch[]} launches
 * @property {Record<string, (ctx: Context, args: any) => Promise<unknown>>} [ops] runner
 *   operations the steps can call with `host.call(name, args)`
 */

export {};

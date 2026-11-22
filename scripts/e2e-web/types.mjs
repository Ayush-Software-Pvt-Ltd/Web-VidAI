// Type definitions (JSDoc) shared by the VidAI Web end-to-end runner and its scenarios. No runtime
// code. The scenario files are type-checked as Node code (no DOM types): a callback that runs in
// the page reads `globalThis` through `any`.

/**
 * A running `vidai-web`.
 * @typedef {object} Server
 * @property {number} port
 * @property {string} origin `http://127.0.0.1:<port>`
 * @property {string} address the tokenized address the server printed
 * @property {string} token
 * @property {import("node:child_process").ChildProcess} child
 * @property {string[]} output every line the server printed on standard output
 * @property {string[]} errors every line it printed on standard error
 * @property {() => Promise<{ code: number | null, signal: string | null }>} exited resolves
 *   when the process has ended
 * @property {() => boolean} isRunning
 * @property {() => Promise<{ code: number | null, signal: string | null }>} interrupt sends
 *   SIGINT (Ctrl+C) and waits for the process to end
 * @property {() => Promise<void>} kill ends it at once
 */

/**
 * @typedef {object} StartOptions
 * @property {number} [port] a fixed port (a restart); default 0, any free port
 * @property {Record<string, string>} [env] more environment variables
 */

/**
 * What a scenario gets: its own folders, helpers for the data on disk and the fake Claude Code,
 * the server and the browser. Everything it starts is ended by the runner.
 * @typedef {object} Test
 * @property {string} name
 * @property {string} dir the scenario's own folder (everything below is inside it)
 * @property {string} editing the Editing Folder
 * @property {string} data the app data directory (`VIDAI_DATA_DIR`)
 * @property {string} fake the fake Claude Code's state folder (`FAKE_STATE`)
 * @property {string} shots where the screenshots go
 * @property {(channel: string, folder: string, media: "landscape" | "portrait" | "rotated") => Promise<string>} video
 *   creates a video folder with one A-roll file and returns its path
 * @property {(settings: Record<string, any>) => Promise<void>} seedSettings writes settings.json
 * @property {(videos: Array<[string, "landscape" | "portrait" | "rotated"]>, settings?: Record<string, any>) => Promise<void>} seedLibrary
 *   one channel with these videos, set up as if onboarding was done
 * @property {(name: string, content?: string) => Promise<void>} fakeSet writes a file in the
 *   fake's state folder
 * @property {(name: string, timeout?: number) => Promise<void>} waitFake waits for a file there
 * @property {(name: string) => Promise<void>} fakeRemove
 * @property {(folder: string) => Promise<void>} release lets the fake edit of a video finish
 * @property {() => Promise<import("../e2e/types.mjs").FakeCall[]>} fakeCalls
 * @property {(options?: StartOptions) => Promise<Server>} startServer
 * @property {(options?: { cookie?: boolean }) => Promise<import("playwright").BrowserContext>} newContext
 *   a browser context (1280x800) whose pages are watched for errors
 * @property {(server: Server, context?: import("playwright").BrowserContext) => Promise<import("playwright").Page>} open
 *   opens the tokenized address in a page of `context` (a new one by default) and waits for the
 *   app to be there
 * @property {(page: import("playwright").Page, name: string, clip?: { x: number, y: number, width: number, height: number }) => Promise<string>} shot
 *   a screenshot into the scenario's folder; returns the file
 * @property {(allowed: RegExp) => void} allowFailure a failed request or error status whose
 *   `METHOD url (reason)` text matches is expected, not a failure
 * @property {() => string[]} issues console errors, page errors, failed requests and Content
 *   Security Policy violations seen so far
 * @property {(message: string) => void} note
 * @property {<T>(check: () => T | Promise<T>, what: string, timeout?: number) => Promise<NonNullable<T>>} waitFor
 *   polls until `check` returns something truthy
 * @property {(condition: unknown, message: string) => void} assert
 * @property {(actual: unknown, expected: unknown, what: string) => void} equal
 */

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} title one line for the output
 * @property {number} [timeout] for the whole scenario, in ms
 * @property {boolean} [real] uses the real local Claude Code: runs with `--real` and never without
 * @property {(t: Test) => Promise<void>} run
 */

export {};

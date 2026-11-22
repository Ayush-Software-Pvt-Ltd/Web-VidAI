# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VidAI Server is a multi-user web app for an office intranet: a Node.js server in plain JavaScript (`server/`) and a React + TypeScript UI (`src/`).
It runs on one Windows or Mac computer; colleagues open it in a browser over HTTPS and sign in with an email and a password that an admin created.
Each user has their own channels (a directory with one folder per video, with its own prompts and styles) and sees only their own channels and videos; the admin sees all.
It starts, queues, pauses, continues, stops and re-edits AI video edits; each edit is a locally installed coding agent (Claude Code or OpenCode 2) running headless on the server and producing a HyperFrames project.
Users review the result on a timeline in the browser, ask for changes there (a timeline-edit queue) and ask for the rendered video explicitly (a render queue); edits can be marked Urgent, the admin sets CPU and GPU limits, and Disk Cleanup frees space.
The contract is `docs/SPEC.md`: read its table of contents and only the section for the area you touch (section 3 has the code layout).
If code and SPEC disagree, fix one of them in the same change.
Never use the em dash character anywhere in the repository; ESLint and the SPEC forbid it, use a plain dash instead.

## Transition (delete this section once `src-tauri/` and `src-web/` are removed)

- `src-tauri/`, `src-web/`, `docs/SPEC-desktop.md`, `.github/` and the old scripts (`scripts/e2e*`, `scripts/bundle*`, `scripts/web*`) belong to the old desktop and single-user apps.
- They are read-only references, never described as current: do not edit, build or test them, and never run `cargo`, `npm run tauri`, `e2e`, `e2e:web`, `bundle:*`, `web*`, `rust:*` or `gen:types`.
- The `check` script no longer calls cargo.

## Commands

Requires Node.js 22.13+, ffmpeg and ffprobe, Python 3.10+; run `npm install` first.
`./start.sh` (Mac) or `start.cmd` (Windows) installs dependencies, builds the UI when it is stale and starts the server; `npm start` or `npm run server` starts it without those steps (`--port`, `--host`, `--data`, `-h`; SPEC section 2).
The server listens on `https://localhost:14200` by default and prints the one-time setup address when no admin exists.
`npm run dev` runs the UI alone on http://localhost:1420 against the in-memory mock backend (`?scenario=a,b`, `?as=admin|user`, `?latency=`, `?speed=`, `?minute=`, `?ticks=off`; scenarios in `src/lib/mock/scenarios.ts`).
`npm run dev` with `?backend=http` talks to the real server through the Vite proxy (`VIDAI_SERVER` changes its address, default `https://127.0.0.1:14200`).
`npm run build` is `tsc` then `vite build`; the server serves `dist/`.
`npm run check` runs every gate: `format:check lint typecheck test server:typecheck server:test toolkit:test`.
The gates alone: `npm run format:check` (Prettier, `printWidth: 100`), `npm run lint` (ESLint on UI and server, zero warnings), `npm run typecheck` (UI), `npm run server:typecheck` (server JavaScript with `tsc --checkJs`), `npm run test` (vitest), `npm run server:test` (`node --test`), `npm run toolkit:test` (Python unittest).
One UI test file: `npx vitest run <path> --reporter=dot`.
One server area: `node --test --test-reporter=dot "server/test/<area>/**/*.test.js"`.

## Server architecture (SPEC section 3)

- `server/src/main.js` is the executable (arguments, data directory lock, start, signals, `admin-reset`); `app.js` builds the database, sessions, HTTP server and RPC and plugs in the modules; `engine.js` is the composition root that builds every feature module and says in which order they start and stop (storage, harness, claude, limits, toolkit, library, maintenance, timeline, render, edit log, disk, jobs).
- A module is `{ name, rpc, routes, hooks, start, stop, api }` (all but `name` optional) or a function of the `AppContext` that returns one; `stop` must cope with a `start` that never ran.
- Hooks (`rpc/index.js`, `Hooks`) let later modules react to account changes (`onUserRemoved`, `afterUserRemoved`, `onUserDisabled`, `activeJobCount`, `beforeSettingsChange`); every module's hook runs in module order, so the accounts code never imports the job engine.
- Areas: `rpc/` (the RPC functions, one file per area), `http/` (TLS, router, SSE, static UI, security headers), `auth/`, `db/` (repositories and numbered migrations `migrations/NNN-name.sql`), `storage/`, `library/`, `agents/` (harness, `claude/`, `opencode/`, setups, readiness), `jobs/` (manager, the three queues, keep-going, retry, prompts, logs), `limits/` (CPU budgets, GPU slots), `timeline/`, `render/`, `toolkit/`, `platform/`.
- The transport is `POST /api/rpc/<name>` (JSON in, JSON out, `X-VidAI: 1` header, session cookie) and `GET /api/events` (Server-Sent Events); the RPC names are in SPEC section 14 and `src/lib/rpc.ts`.
- Errors are `AppError(code, message, { field })` from `server/src/errors.js`, sent as `{ code, message, field? }` with the HTTP status of the code; a message is a full sentence a user can read, and `field` names the input it is about.
- Server code is plain ES modules with JSDoc types: no TypeScript files, no build step, no framework, no new packages without asking; SQLite is `node:sqlite`.
- Modules export factories (`createX({ deps })`) and take a `clock` and timings as parameters; no mutable state at module level, so every test builds its own.
- RPC functions stay thin: check the session and role, validate, call a module, map errors.
- All OS-specific code lives in `server/src/platform/`; never test `process.platform` anywhere else, and write the Windows path too because the server runs on macOS and Windows.
- The editing toolkit (`toolkit/`, Python, see `toolkit/README.md`) is copied into `<data dir>/toolkit/` by the server; nothing writes into the repository copy at run time.

## UI architecture

- `src/app/` is the shell and routing (`route.ts`), `src/features/<area>/` the screens (account, activity, admin, disk, filepicker, history, jobs, library, settings, timeline, uploads), `src/components/ui/` the primitives.
- The seams are in `src/lib/`: `rpc.ts` (the frozen contract of every call and event), `api.ts` (the `Api` type derived from it), `http.ts` (the real backend), `sse.ts` (the event stream), `ipc.ts` (picks the backend: HTTP in production builds, the mock in `npm run dev` and tests).
- UI code in `src/app/`, `src/features/` and `src/components/` reaches the backend only through `@/lib/appEnv` (`useApi()`, `useAppState(selector)`, `useAppStoreApi()`, `usePlatform()`); never import `api` from `@/lib/ipc` or the store from `@/lib/store` there, ESLint enforces it.
- The store (`src/lib/store/`, zustand) has one slice per area; every server resource is a `Resource<T>` with `status`, `data` and `error`, kept fresh by the server's events.
- Wire types are TypeScript in `src/lib/wire.ts` and `src/lib/wire/<area>.ts`, owned by the server; the UI imports them from `@/lib/types`, and every field is always present (`null` when empty).
- The server is the single source of truth; the UI never derives business rules (which buttons a video offers comes from the server as `actions`, what new edits need is `readiness.problem` on the server and `problemOf` in `src/lib/readiness.ts`, both run against `server/test/support/fixtures/readiness-table.json`).
- `src/lib/mock/` is a complete in-memory backend that simulates users, jobs, queues and the timeline, so the whole UI runs and tests without the server; keep it in step when server behavior changes.
- `src/lib/platform.ts` is the one place for what differs by the browser's operating system in the UI.

## Tests

- UI tests are `src/**/*.test.{ts,tsx}` (jsdom, 60 s test timeout, 20 s `findBy` timeout); no teardown is needed, everything is disposed in `src/test/setup.ts`.
- Write UI tests with `setupApp` or `renderApp` from `src/test/app.tsx` (each test gets its own `MockBackend` and store, `autoTick: false`), or with `openApp` from `src/test/whole.tsx` to open the whole `App` at an address as a signed-in user.
- `vi.spyOn` on a `MockBackend` method fails ("Cannot redefine property"); use `src/features/jobs/recordedApp.tsx` or observe the store and the mock's world.
- Server tests are `server/test/<area>/*.test.js` with `node:test`; `startWorld()` in `server/test/app/world.js` is the whole server wired as in production with the fake programs in a temporary data directory, and `startApp` and `makeClient` in `server/test/app/support.js` give a real app on port 0 and an HTTPS client with a cookie jar.
- The fake programs and fixtures are in `server/test/support/` (`fake-claude.sh`, `fake-opencode2.py`, `fake-hyperframes.mjs`, `fake-python.*`, `fixtures/`); engine tests use them with shortened timers.
- Tests never use the real data directory, a fixed port, the network or real sleeps: use a temporary `VIDAI_DATA_DIR`, port 0, `VIDAI_SECRETS=memory` and the injected clock.
- Point the programs at fakes with `VIDAI_CLAUDE_BIN`, `VIDAI_OPENCODE2_BIN`, `VIDAI_FFMPEG_BIN`, `VIDAI_FFPROBE_BIN`, `VIDAI_PYTHON_BIN` and `VIDAI_HYPERFRAMES_BIN`.
- Every rule that keeps users apart needs a test that tries to cross it (SPEC section 4).
- Never write a real email address, password or API key into the repository; use values such as `admin@example.com`.

## Environment the server reads

`VIDAI_PORT`, `VIDAI_HOST`, `VIDAI_DATA_DIR` (the options `--port`, `--host`, `--data` win), `VIDAI_UI_DIST` (where the built UI is read from), `VIDAI_ADMIN_EMAIL` and `VIDAI_ADMIN_PASSWORD` (create the first admin on start), `VIDAI_SECRETS=memory` (API keys kept in memory, for tests and development).
Binary overrides: `VIDAI_CLAUDE_BIN`, `VIDAI_OPENCODE2_BIN`, `VIDAI_FFMPEG_BIN`, `VIDAI_FFPROBE_BIN`, `VIDAI_PYTHON_BIN`, `VIDAI_HYPERFRAMES_BIN`.
`VE_HW` forces a video encoder (`none` for software), and `VIDAI_E2E_OPENCODE_LOGIN` is read only when `NODE_ENV=test`.
The Vite dev proxy reads `VIDAI_SERVER`.

## Working rules

- `docs/SPEC.md` is the contract; behavior changes update the matching section in the same change.
- Windows is a first-class server platform: check `server/src/platform/` and SPEC sections 2, 8 and 9 when touching process trees, CPU limits, paths or launching programs.
- Keep sentences in docs and comments to one per line, and never write a password or key into a log, a file or the repository.

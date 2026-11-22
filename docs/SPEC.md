# VidAI Server - Product and Engineering Spec

This file is the contract for VidAI Server, the multi-user web app.
If code and this file disagree, fix one of them in the same change.
Never use the em dash character anywhere in the repository.

## 1. Product

VidAI Server runs on one Windows or Mac computer in the office.
Everybody in the office opens it in a browser over the intranet and signs in with an email and a password.
A user starts AI video edits of their own videos, follows them, reviews the result on a timeline in the browser, asks for changes on the timeline, and finally asks for the rendered video.
Each edit is done by a locally installed coding agent (Claude Code or OpenCode 2) that runs headless on the server inside the video's folder and uses the editing toolkit.

Decisions of the product owner (2026-11-22), all settled:

1. The server is Node.js in plain JavaScript (ES modules, no TypeScript, no build step) with SQLite for accounts, queues and all management data.
2. The browser UI is React + TypeScript (`src/`), served by the server.
3. Accounts are created only by an admin, with an email and a password.
4. The admin chooses the harness (the setup, which decides Claude Code or OpenCode 2), the API details and the model for everybody.
5. Every user has several channels; a channel is a directory with one folder per video, its own prompts and styles; a user sees only their own channels and videos.
   Only the admin creates, changes and removes channels: the admin gives each channel to one user and chooses its directory anywhere on the server, on an internal or an external drive.
6. The footage of a video is put into its video folder outside VidAI; users edit only footage that is already there.
   In the browser a user can upload extra files (pictures, music, documents) into the `upload` folder of a channel or of a video, and nowhere else; a prompt that names such a file makes the edit use it.
7. The result of an edit is a HyperFrames project, not a Final Cut Pro or Premiere Pro file.
8. Review happens on a timeline in the browser: play, scrub, edit by hand (trim, move, delete, split) and ask for changes by circling an area of a frame and typing what to change.
9. A change asked for on the timeline is sent to editing at once and only that part is changed; a motion graphic is re-created on its own and replaced in place.
10. The final video is rendered only when the user explicitly asks for it.
11. Three separate queues exist: edits, timeline changes, renders, each with its own limit set by the admin (renders default 1).
12. A user can mark an edit Urgent when starting it.
13. The admin sets the maximum CPU and GPU share (5 to 100 percent in steps of 5) for one edit and for all edits together; the GPU share is approximate.
14. Users can free disk space with Disk Cleanup, which deletes the files in a video's `CLAUDE_VE` folder.
15. The server always speaks HTTPS and makes its own certificate on the first start.
16. The server starts with an empty database.

Trust model: all users are colleagues on a private network.
The agent runs as the operating system user that runs the server, with permission checks switched off, so an edit can read and write whatever that OS user can.
VidAI keeps users apart in its own interface and API (section 4), not at the operating system level.

## 2. Running the server

`npm start` (or `./start.sh` on a Mac, `start.cmd` on Windows) builds the UI when its sources are newer than `dist/` and starts `node server/src/main.js`.
Requirements on the server computer: Node.js 22.13 or newer, ffmpeg and ffprobe, Python 3.10 or newer, and the agent program of the chosen setup (Claude Code or OpenCode 2).
HyperFrames is a pinned npm dependency of the server; its browser (Chrome headless shell) is fetched once by the System page's "Prepare" step (section 7).

Options: `--port <n>` (default 14200, also `VIDAI_PORT`), `--host <address>` (default `0.0.0.0`, also `VIDAI_HOST`), `--data <dir>` (also `VIDAI_DATA_DIR`), `-h`.
On start the server prints every address it can be reached at (`https://<host name>:<port>` and one per network address).
Ctrl+C (SIGINT, SIGTERM, Ctrl+Break) pauses running edits like Pause does, stops running renders, waits for both up to 40 seconds, then exits; a second signal exits at once after killing the process trees.

### Data directory

Default: `~/Library/Application Support/VidAI Server` on macOS, `%LOCALAPPDATA%\VidAI Server` on Windows.
Only one server may use a data directory (a lock file with the process id; a stale lock of a dead process is taken over).

| Path | Content |
|---|---|
| `vidai.db` | SQLite database (WAL mode, foreign keys on) |
| `secret.key` | 32 random bytes, readable by the owner only; encrypts API keys in the database |
| `tls/cert.pem`, `tls/key.pem` | the certificate and its key |
| `logs/<jobId>.jsonl` | job logs |
| `server.log` | server log, rotated at 10 MB, 5 files kept |
| `toolkit/` | the editing toolkit, its Python environment and lessons file (section 7) |
| `projects/<videoKey>/` | timeline revisions and change-request pictures of one video (section 11) |
| `cache/proxy/` | preview copies of heavy video files (section 11) |
| `cache/render/` | frame caches and temporary files of renders |
| `locks/` | GPU slots and other machine locks (section 9) |

### HTTPS

The server only listens with TLS.
On the first start it creates a self-signed certificate (RSA 2048, valid 825 days) whose names are `localhost`, the host name, the host name with `.local`, and every network address of the computer at that moment.
A certificate within 30 days of its end, or one that lacks a current address of the computer, is replaced on start.
If `tls/cert.pem` and `tls/key.pem` were put there by the admin (the certificate is not self-signed by VidAI, recognised by its subject), they are used as they are and never replaced.
Browsers warn once about a self-signed certificate; the README explains how to accept it and how to install a proper one.

### First admin

If no admin account exists on start:

- with `VIDAI_ADMIN_EMAIL` and `VIDAI_ADMIN_PASSWORD` set, that account is created (the password is hashed, section 4) and the log says so without the password;
- otherwise the server prints a one-time setup address `https://localhost:<port>/setup#<token>`; the page asks for the admin's email and password; the token is 32 random bytes, kept in memory only, and ends when used or when the server stops.

`node server/src/main.js admin-reset --email <email>` asks for a new password on the terminal and sets it (for a locked-out admin).
No password is ever written to the repository, a log, or a file other than as a hash in the database.

### Environment for tests and development

`VIDAI_DATA_DIR`, `VIDAI_CLAUDE_BIN`, `VIDAI_OPENCODE2_BIN` (binary overrides), `VIDAI_FFMPEG_BIN`, `VIDAI_FFPROBE_BIN`, `VIDAI_PYTHON_BIN`, `VIDAI_HYPERFRAMES_BIN` (fakes in tests), `VIDAI_SECRETS=memory` (API keys kept in memory), `VIDAI_UI_DIST` (where the built UI is read from).
Tests never use the real data directory.

## 3. Architecture

- The server is the single source of truth; the UI never derives business rules (which buttons a video offers comes from the server as `actions`).
- One process: an HTTPS server, the job engine, the queues, the scanner. No background daemon, no second service.
- SQLite through Node's built-in `node:sqlite` (`DatabaseSync`); every write that spans rows is a transaction; schema changes are numbered migrations applied on start.
- RPC functions are thin: check the session and role, validate input, call a module, map errors.
- All operating-system-specific code lives in `server/src/platform/` behind small functions (process trees, CPU limits, machine facts, links, paths).
- Wire types are described once in TypeScript in `src/lib/types.ts`; the server refers to them in JSDoc and is checked with `tsc --checkJs` (no emit), so UI and server cannot drift silently.
- Every field of a wire type is always present (`null` when empty); nothing is optional.
- Errors cross the wire as `{ code, message, field? }` with HTTP 400 (or 401, 403, 404, 409, 413, 429); codes: `invalidInput`, `notFound`, `conflict`, `forbidden`, `unauthenticated`, `notReady`, `io`, `internal`, `tooLarge`, `rateLimited`.
- `field` names the input the sentence is about, so a form can show it under that field: every refusal of an input check carries it (an unknown key as `parent.key`), the account functions use `email`, `password`, `currentPassword` and `newPassword`, and refusing to make the last admin a user or to disable them uses `role` or `disabled`; a wrong email or password at sign-in never has one, so it never says which of the two was wrong.

### Code layout

| Path | Content |
|---|---|
| `server/src/main.js` | arguments, data directory, start, shutdown |
| `server/src/app.js` | the app: database, sessions, HTTP server, and the modules of `engine.js` plugged in (`{ name, rpc, routes, hooks, start, stop, api }`) |
| `server/src/engine.js` | the composition root: builds every feature module, joins them, and gives the order they start in |
| `server/src/db/` | open, migrations (`migrations/NNN-name.sql`), one repository module per table group |
| `server/src/http/` | TLS, router, static UI, SSE, body reading, security headers, errors |
| `server/src/auth/` | passwords, sessions, login throttle, first-admin setup |
| `server/src/rpc/` | the RPC functions of section 14, one file per area |
| `server/src/storage/` | path safety, the admin's folder browsing, uploads, file serving with Range |
| `server/src/library/` | scanner, media probing, outputs, video actions |
| `server/src/agents/` | `harness.js`, `claude/`, `opencode/`, setups, readiness |
| `server/src/jobs/` | manager, the three queues, keep-going, retry, progress, prompts, logs, errors |
| `server/src/limits/` | CPU budgets and GPU slots |
| `server/src/timeline/` | project document (parse and edit), profile check, hand edits, revisions, change requests, preview serving, proxies |
| `server/src/render/` | the render runner |
| `server/src/toolkit/` | installing and checking the toolkit |
| `server/src/platform/` | OS-specific code |
| `server/test/` | `node --test` tests; `support/` has the fake agent programs and fixtures |
| `toolkit/` | the editing toolkit sources (`CLAUDE_VE_ALL/`, `MEMORY.md`, `CLAUDE.md`, `default_prompt.md`) |
| `src/` | the React UI |
| `scripts/e2e-server/` | end-to-end suite (real server, fake agents, Chromium) |

Modules start in this order: storage, harness, Claude Code, limits, toolkit, library, preview, timeline, render (which first removes what an interrupted render left behind), the player script, edit log, disk, jobs.
They stop in the reverse order, so the job engine pauses its jobs before anything it uses goes away; preview copies, change-request pictures and the preview stop after it.
When a module cannot start, the server stops the modules already started and ends with "The <name> part of the server could not start: <reason>".

The UI reaches the server only through `@/lib/appEnv` (`useApi()`, `useAppState(selector)`, `useAppStoreApi()`, `usePlatform()`); `src/lib/http.ts` is the real backend and `src/lib/mock/` the in-memory one for UI tests and `npm run dev`.

## 4. Accounts and sessions

- Roles: `admin` and `user`. An admin can do everything a user can, plus section 5.
- An account is an email (stored trimmed and lower-cased, unique, at most 254 characters, must contain one `@` with text on both sides) and a password (8 to 200 characters).
- Only an admin creates, edits (email, password, role, disabled, may mark Urgent) and deletes accounts.
- The last enabled admin can be neither deleted, disabled nor made a user.
- Every user can change their own password (current password required); doing so, or an admin setting it, ends all other sessions of that account.
- Deleting or disabling an account ends its sessions, stops its active jobs (like Stop) and removes its waiting jobs and uploads; files on disk are never touched; deleting also removes its channel rows (the directories stay).
- Passwords are stored as `scrypt$N$r$p$<salt>$<hash>` (N 32768, r 8, p 1, 16 byte salt, 32 byte hash, compared in constant time).
- Login: `login(email, password)`; a wrong email and a wrong password give the same answer and take the same time ("Email or password is wrong.").
- Throttle: after 5 failures for the same email or from the same address within 15 minutes, further attempts for it are refused for 15 minutes with `rateLimited`.
- Session: 32 random bytes, sent as cookie `vidai_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`), stored only as its SHA-256; it ends after 30 days without use or at Sign out.
- Every RPC except `getSession`, `login` and `setupAdmin` needs a session; admin functions need the admin role and answer `forbidden` otherwise.
- Every changing request must carry the header `X-VidAI: 1` and, when the browser sends `Origin`, an origin equal to the request's own scheme, host and port; otherwise `forbidden`.
- A user's functions only ever reach that user's channels, videos, jobs, uploads and change requests; a foreign id answers `notFound`, never `forbidden`.
- An admin additionally sees every job in the queues with its owner (section 8) and may stop, pause, continue or re-prioritise it.

Response headers on every page and API answer: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (except preview content, section 11), and a Content-Security-Policy that allows scripts, styles, fonts, media and connections only from the server itself (frames only from itself, for the preview).

## 5. Admin settings

All of these are for the whole server and only an admin can change them.
Each change is validated and clamped on the server and announced with `settings-changed`.

### Harness, program and model

This is the one place that says how edits run: which program does the editing and which service the model comes from.
The choice is one of four setups (`Setup`); the three that use a service (the API options `opencodeGo`, `anthropicApi`, `openaiApi`) each have their own address, API key, model and reasoning efforts.

| Setup | Label | Program | Service | Default address | Key |
|---|---|---|---|---|---|
| `claudeSubscription` | Claude Code with Claude Subscription | Claude Code | the Claude login of the OS user that runs the server | none | none |
| `opencodeGo` | OpenCode 2 with OpenCode Go Subscription | OpenCode 2 (`opencode2`) | OpenCode Go | `https://opencode.ai/inference/go/anthropic` | its own, required |
| `anthropicApi` | Claude Code with Anthropic Compatible API | Claude Code | any Anthropic compatible API | `https://api.anthropic.com` | its own, optional |
| `openaiApi` | OpenCode 2 with OpenAI Compatible API | OpenCode 2 (`opencode2`) | any OpenAI compatible API | `https://opencode.ai/inference/go/v1` | its own, optional |

- A new database starts on `claudeSubscription`.
- The setup, API address, key, model and efforts are admin settings for everybody; users see the active setup and model read-only.
- Each API option keeps its own address (null = the default above), model, reasoning efforts (per model id) and key, so switching options never loses anything.
- An API option can be selected only with its model chosen, and `opencodeGo` also only with its key saved; the program is not checked there, because a missing or unsupported program is a readiness problem (next section).
- The program follows from the setup (`agents/harness.js`, `forNewJob`); a session stays in the program it started in (section 8, "State machine").
- All four setups exist on macOS and on Windows.
- A job on an API option keeps itself going when its model ends a turn early (section 8, "Keeping a job going").
- API keys are stored in the database encrypted with AES-256-GCM under `secret.key`; the UI only ever gets "saved" plus the last 4 characters; a key never appears in an argument, a log, an error or an event, and is replaced by `[api key]` in the job log (section 8, "The job log"); the settings screen is its only source, never a `.env` file.
- The Claude subscription login is the login of the OS user that runs the server; the System page tells the admin to run `claude` once in a terminal on the server and shows the login state.
- When the installed Claude Code's model list changes, the saved model and effort are checked again: a model that is gone becomes Claude Code's default (`null`), an effort the model does not support becomes `null`, and a changed choice is saved and announced with `settings-changed` and `system-changed`.

What each setup puts into a job's environment:

- `claudeSubscription`: Claude Code runs on the server's own environment and the OS user's login; VidAI sets none of the variables below.
  When that environment or Claude Code's settings file (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`; on Windows `%USERPROFILE%\.claude\settings.json`) already sets `ANTHROPIC_BASE_URL`, it is left alone and the System page says so plainly, because "Claude Subscription" would then not mean what it says.
- `anthropicApi` (Claude Code): `ANTHROPIC_BASE_URL` (the address), `ANTHROPIC_API_KEY` (the key, which Claude Code sends as `x-api-key`), and `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL`, all set to the chosen model, so the edit (`--model <model>`), its sub-agents and background tasks use it; `--effort <level>` is added only when an effort is remembered for the model.
  The `ANTHROPIC_AUTH_TOKEN` of the server's environment is removed when a key is saved.
  Without a key `ANTHROPIC_API_KEY` of the server's environment is removed and `ANTHROPIC_AUTH_TOKEN` is set to the placeholder `no-key`: Claude Code then has credentials of its own kind and never falls back to the Claude login, and a server that needs no key ignores `Authorization: Bearer no-key`.
- `opencodeGo` (OpenCode 2): the key as `OPENCODE_API_KEY`.
- `openaiApi` (OpenCode 2): the key, when one is saved, as `VIDAI_API_KEY`; never together with `OPENCODE_API_KEY`.
  The key of the server's own environment under either name is removed first.

Addresses (`agents/setupsUrl.js`; null, an empty text or the default address of the option is stored as null):

- For every option: the text is trimmed and a trailing `/` removed; `https://` is required, and plain `http://` is allowed only for `localhost`, `127.0.0.1` and `[::1]`; a user name, password, query or fragment is refused with `invalidInput`.
- `opencodeGo` and `anthropicApi` use the Anthropic form (the programs append `/v1/messages` themselves): a trailing `/v1/messages` or `/v1` is removed.
  Pay-as-you-go OpenCode is `https://opencode.ai/inference/anthropic`, entered by hand.
- `openaiApi` uses the OpenAI form: a trailing `/chat/completions` is removed and `/v1` is kept, because it is part of the address.

The key of an option:

- Removing the key of the selected `opencodeGo` switches edits back to `claudeSubscription`; removing the key of the selected `anthropicApi` or `openaiApi` keeps it selected, because they work without a key.
- Only `opencodeGo` needs its key (`keyRequired`); `anthropicApi` and `openaiApi` often point at a model server on the admin's own network (Ollama, LM Studio, vLLM, a LiteLLM proxy) that asks for none.
  A job on `opencodeGo` without a key cannot launch ("No API key is saved for OpenCode Go.").
- Without a key Fetch Models and Test send no key header (`anthropicApi` still sends `anthropic-version`), and a 401 answer to such a request says "The service wants an API key. Enter one in the settings." instead of blaming a key that was never sent.
- A blank key is refused when saving.

The model:

- `opencodeGo`: a searchable list fetched live from the option's list address and kept with its address; a saved model the last list does not have is shown as no longer offered, and a launch then cannot use it.
- `anthropicApi` and `openaiApi`: the model is a text box for the id as the service names it (a text with spaces or control characters is refused, an empty text clears it).
  Fetch Models asks the service for its list to choose from; the list is not kept, nothing fetches it by itself and a launch never checks the model against it, because local servers and gateways name models freely.
- Lists: `opencodeGo`: `GET <address>/v1/models` with the key as bearer token; `anthropicApi`: `GET <address>/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01`; both are Anthropic's list form, following `has_more` with `after_id` (an OpenAI form list from a gateway is read as well).
  `openaiApi`: `GET <address>/models` with `Authorization: Bearer <key>`, OpenAI's form `{"data":[{"id":...}]}`, other fields ignored.

The reasoning effort is a choice under the model (Default, Low, Medium, High, Extra high, Max), remembered per option and model id; Default sends nothing.
In Claude Code a chosen level is sent as `--effort <level>` (its effect behind a gateway is not verified); in OpenCode 2 it is the model variant of that name when the server's catalog offers it, otherwise the model runs on its default and the log says why.

Test sends the one tiny request of the option (`POST <address>/v1/messages` with `max_tokens` 1, the chosen model and the headers above; `openaiApi`: `POST <address>/chat/completions`) and reports "OpenCode Go answered with GLM-5.3." (the service and the model) or the reason.
Every request the server makes to a service has short time limits, follows no redirect (the key must never follow one), uses `http` without a proxy only for this computer, identifies itself as `VidAI/<version>` and never puts the key in a message.

Errors of a service, for Test, the model list and jobs of every API option (`agents/apiHttpFailure.js`): a refused key (401), a model not allowed for the plan or a free model used outside OpenCode's own apps (403), a model not offered (404), a Go window reached (429 `GoUsageLimitError` with `metadata.limitName` "5 hour", "weekly" or "monthly"), a budget reached (429 `BudgetLimitError`), the free limit (`FreeUsageLimitError`), a balance used up (402), an overdue invoice, other rate limits (429) and the service's own trouble (5xx).
An `opencode.ai` or `*.opencode.ai` address keeps OpenCode's own texts; any other address uses these generic ones:

- Key refused: "The service did not accept the API key. Check that you copied the whole key, or make a new one with the service."
- 403: "The service does not allow the model X for this key: it is not in your plan. Choose another model."
- 404: "The service does not offer the model X at this address. Choose another model."
- 429: "The service is limiting requests right now. Try again in a minute."
- 5xx: "The service is having problems right now (error N). Try again later."
- Other HTTP: "The service answered with an unexpected error (HTTP N)."
- Budget: "A budget limit of the service is reached. Raise it with the service, or wait until it resets."
- Free limit: "The free limit of the service is reached. Try again later, or choose a paid model."
- Balance: "Your balance with the service is used up. Add credit with the service."
- Overdue invoice: "Your account with the service has an overdue invoice. Settle it with the service."
- Nothing recognizable: "The service reported an error."

An unrecognized report of the program stays "Claude Code reported an error: <first line>" or "OpenCode 2 reported an error: <first line>"; texts about the local OpenCode 2 server itself keep naming OpenCode 2.

The OpenCode 2 program:

- It is OpenCode 2 (2.x, as `opencode2` or `opencode`), belongs to the setups `opencodeGo` and `openaiApi`, and is driven as section 8, "Driving OpenCode 2", says.
- Finding it (`agents/opencode/locate.js`): `VIDAI_OPENCODE2_BIN` is the only candidate when set; otherwise the candidates are every `opencode2`, then every `opencode`, each on the `PATH` and then in the folders the installers use (`~/.opencode/bin`, Homebrew's two `bin` folders, `~/.local/bin`).
  On Windows the program is called `opencode` only (WinGet and npm's `.exe` have no `opencode2`; the bash installer adds an `opencode2.cmd` shim), each name is tried with `PATHEXT` (and always `.exe` and `.cmd`), and the folders are `%LOCALAPPDATA%\Microsoft\WinGet\Links`, every `Anomaly.OpenCode_*` folder in `%LOCALAPPDATA%\Microsoft\WinGet\Packages`, the same two under `%ProgramFiles%\WinGet` (machine scope), `%USERPROFILE%\.opencode\bin`, `%APPDATA%\npm` and `%USERPROFILE%\scoop\shims`.
  The package folders matter because WinGet adds only that folder to the user's `PATH` when it cannot make a link, and a server started earlier does not see the change.
  A `.cmd` shim is never run through `cmd.exe`: the launcher (`platform/launch.js`) reads it and starts its target, the quoted path that begins with the shim's own folder (`%dp0%\x`, `%~dp0\x` or `%~dp0x`), so both npm's shims and the installer's `opencode2.cmd` (`"%~dp0opencode.exe" %*`) work; any other batch file is refused.
  The first candidate that reports a 2.x version is the program, so a 2.x `opencode` needs no shim, and a stale `opencode2` shim over an older binary does not hide a 2.x program elsewhere.
  When no candidate reports 2.x, an `opencode2` counts as found but not supported, with the version it reports, and so does the first `opencode` that did not say its version (its path is shown and the System page says it did not say which version it is); a 1.x `opencode` alone means OpenCode 2 is not installed.
  The version is what `--version` prints on standard output or, when that has none, on standard error (with auto-update off, at most 45 seconds).
- The environment of its server is the server's own minus `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENCODE_PASSWORD`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_API_KEY`, `VIDAI_API_KEY` and `OPENCODE_FLAGS`, plus the key variable of the option, `OPENCODE_SERVER_PASSWORD` (a new random password per run), `OPENCODE_DISABLE_AUTOUPDATE=1`, and `OPENCODE_CONFIG_CONTENT`, the run configuration.
- The run configuration has OpenCode's own keys and is merged above every configuration file of the OS user and below an administrator's managed settings: `formatter` and `lsp` off, `snapshots` false (the video folder holds gigabytes of footage), `share` disabled, `instructions` naming the `CLAUDE.md` of the working directory and `~/.claude/CLAUDE.md` (OpenCode does not read `CLAUDE.md` by itself; a file that does not exist is skipped), and VidAI's own provider `vidai` with the model.
- How address and model become OpenCode's `provider/model`: on `opencodeGo` the default Go address is OpenCode's provider `opencode-go` and the pay-as-you-go address `opencode` (each knows the protocol, limits and price of every model of its catalog); any other address is `vidai`, Anthropic's API at `<address>/v1` through `@ai-sdk/anthropic`, with the key `{env:OPENCODE_API_KEY}`.
  On `openaiApi` it is always `vidai`, named "OpenAI Compatible API (VidAI)", with `@ai-sdk/openai-compatible`, `baseURL` the address as it is and the key `{env:VIDAI_API_KEY}` (left out when no key is saved, because OpenCode 2.2.6 refuses `apiKey: false`), whatever the address; OpenCode's own providers are never used for it.
  OpenCode answers `GET /api/model` with each model's resolved settings, the key included, so that answer is never logged.
- A job never loads the OS user's own OpenCode MCP servers, plugins, agents, commands or project configuration (an MCP server that cannot connect delays the first message by about 33 seconds): the server gets an empty private config folder (`OPENCODE_CONFIG_DIR`) and `OPENCODE_CONFIG_PROJECT_DISABLE=1`; skills in `~/.claude/skills` and `AGENTS.md` files still apply.
- Sessions live in OpenCode's own store, so a later server resumes a session by its id; a plain `opencode2 serve` does not resume interrupted work by itself, so nothing of a paused job runs on until Continue.
- With `NODE_ENV=test`, `VIDAI_E2E_OPENCODE_LOGIN` (`own` or `public`) starts the server without VidAI's key and uses OpenCode's own provider of the address, whatever login it has.

A job keeps the setup, program and model it started with, also for Continue, Re-Edit and timeline changes (section 8).

### Readiness

What new edits need on the server is one decision, made by one pure function with the same name on both sides: `problem(facts)` in `server/src/agents/readiness.js` and `problemOf` in `src/lib/readiness.ts`.
It is used by Start Editing, the status line and the System page.
The rule in one sentence: only the program that does the editing is needed, with the service it runs on; a server with no Claude login and no Claude Code can run edits on OpenCode Go or an API, and a server with only a Claude login is never asked about API keys or OpenCode.

The facts are plain, so every combination is a unit test:

- the setup (all four exist on every platform);
- whether the setup's API key is saved and its model chosen (`keySaved`, `modelChosen`; they count only for the API options, and `keySaved` only for `opencodeGo`);
- Claude Code: not installed, installed but logged out, or ready (`claude`); on Windows also whether Git for Windows is missing (`gitBashMissing`);
- the OpenCode 2 program: not installed, installed in a version VidAI does not drive, or ready (`program`);
- whether the toolkit environment of section 7 is prepared (`prepared`).

The program follows from the setup.
What blocks edits is the first of these that applies, in this order:

| Order | Applies when | Problem |
|---|---|---|
| 1 | the setup is an API option that needs a key (`opencodeGo`) and its key is not saved | `apiKeyMissing` |
| 2 | the setup is an API option and its model is not chosen | `apiModelMissing` |
| 3 | the program is Claude Code and Git for Windows is missing (Windows) | `gitBashMissing` |
| 4 | the program is Claude Code and it is not installed | `claudeMissing` |
| 5 | the setup is `claudeSubscription` and Claude Code is logged out | `claudeLoggedOut` |
| 6 | the program is OpenCode 2 and it is not installed | `programMissing` |
| 7 | the program is OpenCode 2 and its version is not one VidAI drives | `programUnsupported` |
| 8 | the toolkit environment is not prepared (section 7) | `notPrepared` |

`server/test/support/fixtures/readiness-table.json` (every row named, with its facts, the program and the problem) is run by the server tests and by `src/lib/readiness.test.ts`, and both sides also run these invariants over the whole domain, so the two functions cannot disagree:

- `claudeSubscription` never asks for an API key, a model or the OpenCode 2 program, whatever is stored or installed.
- `apiKeyMissing` happens only on `opencodeGo`; `anthropicApi` and `openaiApi` need a chosen model and their program, never a key.
- `opencodeGo` and `openaiApi` never ask for Claude Code, a Claude login or Git for Windows.
- `anthropicApi` needs Claude Code installed (and Git for Windows on Windows), never a login and never the OpenCode 2 program.
- Facts the setup does not look at never change the answer.

The server gathers the facts lazily: an edit on OpenCode 2 never runs `claude`, an edit on Claude Code never runs `opencode2 --version`, and only `claudeSubscription` runs `claude auth status`.
A refused start says the reason as a sentence, for example "No API key is saved for OpenCode Go. Edits are set to run on it. ..." (`notReady` or `invalidInput`), and every launch of a job checks again what its own session needs (section 8, "State machine").
The admin can change the setup while jobs are queued or running: running jobs and the sessions of earlier edits keep the setup they started with; only new edits, and a job that must start a new session, use the new setup.

### Usage limits

All through the local Claude Code process, never a direct API call and never reading Claude's stored credentials.
The model list and the usage limits are the Claude subscription's, so that process is started only while the setup is `claudeSubscription`; on the other setups neither the startup fetch, nor the schedule, nor a refresh runs it, and nothing is logged about Claude Code.

- A Claude Code process in stream-json mode answers control requests without a model call: `initialize` returns `models` (each with `value`, `displayName`, `description`, `supportedEffortLevels`), the account's `subscriptionType` and `claude_code_version`; `get_settings` returns `applied.model` and `applied.effort`, the defaults Claude Code would use; `get_usage` returns `rate_limits_available` and `rate_limits` with `five_hour`, `seven_day` and model-scoped weekly entries, each `{ utilization (percent), resets_at }` or null.
- The `rate_limit_event` lines of running jobs carry `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization (0..1), resetsAt (epoch seconds)}` and update the meters at no cost.
- The model list is fetched at startup, on demand and at most once a day otherwise, and kept so the pickers are never empty after the first run.
- `UsageStatus` (`getUsage`, event `usage-updated`) is refreshed at startup, every 60 seconds while a browser shows it, every 5 minutes while jobs run, on demand and from every `rate_limit_event`; a failed refresh keeps the last values and sets `error`.
  One helper Claude Code process without MCP servers is reused for the periodic requests.
- The 5-hour and weekly limits of the plan are shown to every user, with the weekly limits of model families by their display name.
- New jobs use the model and effort selected at that moment and remember them; Continue reuses the job's own.
  When the selected model does not support the selected effort, the effort is reset to null; when the selected model is no longer in the list, the selection falls back to null (Claude Code's default).

OpenCode Go quota (`getOpencodeUsage`, `agents/opencode/usage.js`): a Go plan reports its three windows at `GET <Go root>/v1/usage` (for the default address `https://opencode.ai/inference/go/v1/usage`) with the key as bearer token, as `{"usage":{"rolling"|"weekly"|"monthly":{"status":"ok"|"rate-limited","percent":0..100,"resetsAt":ISO}}}`: a share of each window and when it resets, no dollars.
Inference answers carry no rate-limit headers (only `retry-after` on a 429), so the endpoint is the only source.

- While the setup is an API option whose address is an OpenCode Go address (on `opencode.ai`, with a path that starts with `/inference/go`), the meters show "5h", "Week" and "Month" as OpenCode reports them, with the reset times, using the selected option's own key.
- When there is nothing true to show they say "not available" with the reason, never a number the server made up: an address that is not a Go address, a key the endpoint refuses (it may need the "Usage: Read" permission), a workspace without Go (403 `EntitlementError`), or no key.
- It is refreshed on the schedule above and when the setup, key or address changes; only while the setup is an API option.

### Queues

| Setting | Range | Default |
|---|---|---|
| `maxEdits` (edits at the same time) | 1 to 8 | 2 |
| `maxTimelineEdits` (timeline changes at the same time) | 1 to 8 | 2 |
| `maxRenders` (renders at the same time) | 1 to 4 | 1 |
| `maxEditsPerUser` (edits of one user at the same time, 0 = no limit) | 0 to 8 | 0 |
| `startDelayMinutes` (pause between two edit launches) | 0 to 120 | 0 |
| `maxModelRetries` | 0 to 50 | 5 |

### Limits (section 9)

`cpuPerEditPercent`, `cpuTotalPercent`, `gpuPerEditPercent`, `gpuTotalPercent`: 5 to 100 in steps of 5, default 100.
A per-edit value above the total is stored as typed and never refused; a job gets the lower of the two, and the page shows such a value as limited by the total by comparing the two settings.

### Storage (section 6)

`maxUploadGb` (1 to 2000, default 200): the largest single file a user may upload.
`proxyCacheGb` (1 to 2000, default 50): the size at which the oldest preview copies are deleted.

### System page

Shows, each with a state and a hint how to fix it: Claude Code (path, version, login), OpenCode 2 (path, version), ffmpeg and ffprobe (path, version, hardware encoders found), Python (path, version), toolkit environment, HyperFrames (version) and its browser, speech model, the speech device and video encoder in use (below), free disk space of the data directory, the addresses of the server, the certificate (names, end date, SHA-256 fingerprint).
"Prepare" runs the toolkit preparation of section 7 and shows its log.
The renderer's browser line of a Windows computer with an NVIDIA GPU says in the Prepare log that the GPU is set for it (section 9, "Graphics in the browser").
A group "Speech and video hardware" shows, from `ve.py hardware` (the same logic as `ve.py doctor`), what speech recognition really runs on (`GPU (CUDA)`, `Apple GPU (MLX)` or `CPU`) and the video encoder and decoder actually chosen (for example `h264_nvenc and hevc_nvenc, decoding with cuda`, or `libx264 (software)`), and the NVIDIA graphics card when there is one.
Each line has a `problem` sentence with its fix when an NVIDIA GPU is present but not used: speech names the missing CUDA libraries or the failure and says to press Prepare, video names why NVENC did not start (ffmpeg's last line) or that the ffmpeg build has no NVENC.
The answer is asked at most once per Prepare and per 30 seconds; before the toolkit environment exists the lines say "Not checked yet."

## 6. Storage, channels and videos

### Folders on the server

Only an admin chooses folders: `fsPlaces`, `fsList` and `fsCreateFolder` answer `forbidden` to everybody else.
The admin's folder picker shows the server's whole file system, so a channel can lie on any internal, external or network drive the server can reach.
`fsPlaces` lists the home folder of the account the server runs as (`home`), then the drives (`drive`): on a Mac the root `/` named after the startup volume, on Windows every drive letter that exists (fixed, removable and network drives); on a Mac every volume in `/Volumes` follows (`volume`), except the link to the startup volume.
A place that cannot be read right now is listed with `available: false`.
`fsList` lists the folders inside one folder (files never), in natural order, with hidden ones left out (a leading dot, and on Windows the hidden or system attribute); a folder that does not exist or cannot be read answers `notFound`.
Every path is resolved to its real path (links followed) before it is checked or stored.
A channel directory must be an existing directory, must not be, lie inside or contain the server's data directory (`invalidInput`: "This folder belongs to VidAI's own data." with `field: "dir"`), and must not be the same as, inside, or around the directory of another channel (`conflict`: "This folder already belongs to a channel.").
Users never send a path: every user function names channels and videos by id and files by a checked name (no separators, no `..`).
VidAI never deletes or overwrites a file in a channel directory, with exactly two exceptions: Disk Cleanup (section 13) and its own files inside `<video>/output/<video>.hf/` (section 10).

### Channels

A channel belongs to one user and has a name (1 to 60 characters, unique for that user), a directory chosen by the admin, a video type (`auto`, `long`, `short`) and two profiles (Long and Short), each with exactly 5 prompt slots and 5 style slots.
Each profile has exactly 5 prompt slots and 5 style slots (`{ name, text }`), and slot 0 is always named "Default".
Other slot names are 1 to 40 characters after trimming; an empty name is "Prompt 2" to "Prompt 5" or "Style 2" to "Style 5".
A saved profile that does not have exactly 5 prompts and 5 styles, or a name outside those limits, is refused with `invalidInput`; slot 0 is always saved as "Default".
Each video remembers which prompt slot and which style slot (0 to 4) it uses; starting is refused with `invalidInput` when the chosen prompt is empty (the message names the slot and Long or Short) or a slot index is outside 0 to 4.
A new channel gets the text of `toolkit/default_prompt.md` in prompt slot 0 of Long and of Short and everything else empty; when `<channel>/Style/STYLE.md` exists, its text (the file is only read) is copied once into style slot 0 of both.
A channel name is 1 to 60 characters, has no control characters and is unique for its user without regard to letter case (`conflict`: "This user already has a channel with that name." with `field: "name"`); its directory follows "Folders on the server".

Only an admin creates, changes and removes channels (`adminListChannels`, `adminCreateChannel`, `adminUpdateChannel`, `adminRemoveChannel`); users have no function for it.
`adminListChannels` lists every user's channels ordered by owner email, then name, each with its owner, folder, whether it can be reached, its number of video folders and `busy` (a job of one of its videos waits, runs or is paused).
`adminCreateChannel({ name, userId, dir, videoType })` gives the channel to an existing user (`notFound` otherwise) and puts it last in that user's order; the directory must exist already (the picker's New Folder makes one).
`adminUpdateChannel` changes the name, the owner, the directory and the video type; the owner and the directory cannot change while the channel is busy (`conflict`: "Stop the running edits of this channel's videos first.").
A new owner gets the channel last in their order, with its videos, their inputs, revisions and change requests; finished jobs and edit log entries keep the user who made them, and unfinished uploads into the channel are cancelled.
A new directory keeps the video rows: a row belongs to the folder of the same name, so videos whose folders lie in the new directory too keep their inputs, revisions and change requests; rows whose folder is not there stay in the database unlisted, like those of any video folder that disappeared (an archived one leaves the archive), and come back when the folder does.
A new directory also cancels the unfinished uploads into the channel.
Every change sends `workspace-changed` and `library-changed` to the owner (and to the old owner when it changed).
The owner changes only the video type, the prompts and the styles (`updateChannel`), and the order of their channels.
`importChannels` updates the user's channels of the same name (without regard to letter case) and makes none; the other names of the file come back in `skipped`.
Removing a channel removes only the row and its videos' rows (with their jobs, change requests, revisions and unfinished uploads, whose partial files are deleted) and the server's own folder of each of those videos (`<data dir>/projects/<videoKey>/`); the channel directory and everything in it stay, and so do the edit log's entries.
Deleting a user removes those folders of all the user's videos the same way, and at start the server removes every folder under `<data dir>/projects/` that belongs to no video (logged with the count).
While a job of one of its videos waits, runs or is paused the removal is refused (`conflict`): "Stop the running edits of this channel's videos first.".
Channels can be reordered; the order is per user.

### Videos

A video is a folder directly inside a channel directory.
Its id is `<channelId>/<folder name>`.
Never a video: a name that starts with `.` or `CLAUDE_VE`, the channel's `upload` folder, and the asset folders `Style`, `sample`, `samples`, `images`, `pictures`, `host images` and `host pictures` (compared ignoring case); `CLAUDE_VE*` is the working folder of an edit.
A-roll files are regular files directly in the video folder with the extension `mp4`, `mov`, `m4v`, `mkv`, `mts`, `m2ts`, `avi` or `webm` (ignoring case); the main A-roll is the largest one, and a tie goes to the smaller name.
The B-roll folder is the first subfolder (in natural order) whose name matches `b-roll`, `b_roll`, `b roll` or `broll`, with an optional `s` and in any case; when there is none it is `Broll`.
Videos are listed newest first: the natural order of their folder names, descending, where runs of digits compare as numbers, letters ignore case and digits come before letters.
`createdAt` is the creation time of the video folder, and its modified time on a file system that keeps no creation time.
A link is followed only when it leads to a place inside the channel directory, and a video folder that is itself a link is not a video.
A channel directory that is missing or unreadable gives no videos and is marked unavailable, so nobody concludes from it that a video was deleted.
Video folders and their footage are put into the channel directory outside VidAI; VidAI never makes a video folder.

Outputs of a video, found in `<video>/output/`:

- project: `output/<video folder name>.hf/index.html` (section 10); a video has at most one project;
- finals: `*.mp4`, `*.mov`, `*.m4v` directly in `output/`;
- thumbnails `thumbnail-*.png|jpg|jpeg` and `meta.txt` in `output/`, and `info.txt` in the video folder.

Long or Short is detected from the main A-roll and never asked:

- Its display size is the coded size with the rotation applied (a 3840x2160 file rotated by 90 or 270 degrees is vertical); taller than wide is Short, otherwise Long.
- MP4, MOV and M4V files are read in the server itself: the top-level `moov` box (header only, so a few small reads even for hours of footage) gives the track header size and matrix; a file without a readable `moov` box, such as one that is still being copied or recorded, falls through to `ffprobe`.
  Every other container goes through `ffprobe` (15 seconds at most); a missing `ffprobe` is not remembered, so installing it fixes the detection without touching the file.
- When nothing can be read, the type is unknown: the UI shows it as assumed Long with a hint.
- Results are remembered per file by path, size and modified time, in a cache of at most 5000 files.
- The effective type of a video (`videoType`, and the type a new job starts with) is the first that applies, and `typeSource` says which: `override` (the video's own choice on its row), `channel` (the channel's video type when it is `long` or `short`), `detected`, or `assumed` (Long).
  `detectedType` always reports the detection, whatever decides the effective type.
- There is no picture check: a file that carries no rotation information is judged by its metadata, and the channel's video type or the video's own choice overrides it.

The library is rescanned after job events, uploads and channel changes, and every 5 seconds for users with an open event stream; `library-changed` goes only to the owner and only when their result differs.

### Uploads

A user uploads files into exactly two kinds of folders and nowhere else: the `upload` folder of one of their videos (`<video folder>/upload/`) and the `upload` folder of one of their channels (`<channel directory>/upload/`).
The folder is made when the first upload into it starts; an existing folder whose name is `upload` in another letter case is used as it is.
Every file type is accepted.
Uploaded files are only stored: an edit is not told about them, and uses one only when the video's prompt or a change request names it (the agent knows `MAIN_FOLDER` and `CHANNEL_FOLDER`, section 8).
`listUploads({ target })` lists the files directly in that folder (hidden ones and unfinished uploads left out) in natural order with size and modified time; a folder that does not exist yet gives an empty list.
`createUpload({ target, name, size })`, where `target` is `{ kind: "video", videoId }` or `{ kind: "channel", channelId }` of the user's own, checks the name (1 to 200 characters, no path separators, no control characters, no leading dot, no trailing dot or space, not a name Windows reserves such as `CON` or `LPT1`), the size (`maxUploadGb`, free disk space plus 1 GB) and that no file of that name exists, and returns an upload id.
The browser then sends the bytes in order with `PUT /api/upload/<id>?offset=<n>` (raw body, at most 32 MB per request); the server appends only when `offset` equals what it already has and answers with the new offset, so a broken upload continues from `GET /api/upload/<id>`.
Bytes are written to `.<name>.<id>.part` in the target folder (hidden from the scanner and from `listUploads`); when the last byte arrives the file is renamed to its name, failing with `conflict` if the name was taken meanwhile.
`cancelUpload(id)` deletes the part file; part files untouched for 24 hours are deleted on start and hourly.
A video with an upload in progress into its own `upload` folder does not offer Start Editing; uploads into a channel's folder block nothing.
Disk Cleanup never touches an `upload` folder.

## 7. Toolkit

The toolkit is one copy for the whole server at `<data dir>/toolkit/`:

| Path | Content |
|---|---|
| `CLAUDE_VE_ALL/` | the toolkit programs (`ve.py`, `vekit/`, graphic templates and design kits, sound effects) |
| `MEMORY.md` | lessons the agents read; agents may append to it |
| `CLAUDE.md` | short rules for the agent |
| `venv/` | the Python environment |
| `VERSION` | the toolkit version that was installed |

On start the server compares `toolkit/VERSION` in the repository with the installed one.
When they differ, `CLAUDE_VE_ALL` and `CLAUDE.md` are replaced by the shipped ones (the old folder is kept once as `CLAUDE_VE_ALL.previous`), `MEMORY.md` is created only when missing and never overwritten, and the Python environment is marked as needing preparation when `requirements.txt` changed.
"Prepare" (System page, and automatically on the first start) creates `venv/`, installs the requirements, makes sure the HyperFrames browser is installed and the speech model is downloaded, and records each step's result; edits cannot start until it has succeeded (`notPrepared`).

- The steps, in order: Python (3.10 to 3.13, found by running it; the Python that comes with macOS is not used), `venv/`, the packages, ffmpeg and ffprobe, the toolkit's own check (`ve.py doctor`), the speech model, the renderer's browser, the test render.
- On a Windows or Linux computer with an NVIDIA GPU (the driver's `nvidia-smi` names one) the packages step also installs `requirements-cuda.txt`: `ctranslate2>=4.6`, `nvidia-cublas-cu12` and `nvidia-cudnn-cu12`, the CUDA 12 libraries `faster-whisper` needs on the GPU; a failed install fails the step, with a sentence that says speech does not run on the CPU there.
- On such a computer the speech step also proves the device: the model is loaded on CUDA and run once on a second of silence (`vekit/asr.py`, `warm_up`), and a failure is the step's message, so edits cannot start until the GPU works. A failed step stops the later ones; the results are kept in `toolkit/prepare.json` and shown after a restart.
- Edits can start when the toolkit is installed and the steps up to the speech model are done; Render Final also needs the browser and the test render.
- Whether Prepare is needed is read from the disk: the environment's Python is missing, the packages were never installed, `requirements.txt` differs from the one last installed, or the computer has an NVIDIA GPU and `requirements-cuda.txt` was never installed (or differs from the installed one), so an existing install that lacks the CUDA libraries is repaired by the automatic Prepare at the next start, before any edit runs. A toolkit upgrade with the same requirements keeps the environment.
- Prepare starts by itself at every server start while edits could not start otherwise; only one runs at a time, and edits cannot start while it runs.
- A crash during an upgrade leaves a usable toolkit: the next start puts the old programs back or finishes the swap. `VERSION` is written last. A failed install is shown on the System page and never stops the server.
- The copy never contains the toolkit's tests or Python cache folders.

The toolkit is portable: it runs on Apple Silicon and Intel Macs and on Windows.
Speech recognition uses `mlx-whisper` on Apple Silicon and `faster-whisper` elsewhere, on CUDA whenever the computer has an NVIDIA GPU and on the CPU only when it has none.
There is no quiet fallback to the CPU on an NVIDIA computer: `transcribe.py`, `windows.py` and `qa` stop with exit code 2 and one line on stderr that names what is missing (a CUDA library, no CUDA device, or the failure of the first run) and says the administrator presses Prepare.
Before ctranslate2 loads, `vekit/asr.py` makes the folders `site-packages/nvidia/<library>/bin` (Windows, through `os.add_dll_directory` and PATH) or `.../lib` (Linux, the libraries are loaded with global symbols) findable, because the pip wheels keep their DLLs there.
`VE_ASR_DEVICE` (`cpu` or `cuda`) is an administrator and test override that the editing agents must not set (`toolkit/CLAUDE.md`), `VE_ASR_BACKEND` likewise.
`ve.py doctor` prints the speech device and exits non-zero when an NVIDIA GPU cannot be used for speech, and `ve.py hardware` prints the speech device and the video encoding as one JSON line for the System page; hardware video encoders are chosen from what ffmpeg offers on the machine (VideoToolbox, NVENC, Quick Sync, AMF) with a software fallback.
The spoken language is detected by the toolkit, never by the agent's own code: `ve.py lang <video folder>` prints one line per A-roll after `prep` (`a1  language: hi 0.93 (en 0.05, ur 0.01)`: the code, its probability and the next two guesses).
`transcribe.py` and `windows.py` take `--lang <code>` (default `hi`, an explicit code is never detected) or `--lang auto`, which detects once, prints the same line and uses that code for every pass, chunk and window.
Detection is Whisper's language guess on up to three windows of 30 s spread over the audio (silent windows left out, so crew chatter in the first seconds of a take does not decide), with the probabilities averaged; it runs on the speech device as a GPU task like a transcription (mlx-whisper on Apple Silicon, faster-whisper elsewhere).
The default Hindi prompt is used only when the language is `hi`, and the JSON files written by `transcribe.py` and `windows.py` carry the language used in a `language` field.
The toolkit takes the video folder as an absolute path; nothing in it depends on where the toolkit lies.
Each video's working files are in `<video>/CLAUDE_VE/`; everything there can be rebuilt, and nothing the project needs to play or render lies there (section 10).
The toolkit obeys the resource limits of section 9 through `vekit/resources.py`.
It writes only inside `<video>/CLAUDE_VE/`, `<video>/output/` and `<video>/info.txt`, never into its own folder; jobs run with `PYTHONDONTWRITEBYTECODE=1`.
Paths it stores (`timeline.json`, `recon.json`) are relative to the video folder, so a moved video folder keeps working.
Every render of the toolkit (`ve.py gfx`, `build`, `frames`, `qa`, and the graphics of `thumbs.py`) is at 720 or 1080: it refuses `--res 2160` with one line on stderr, and `VE_ALLOW_2160=1` (administrator and tests) lifts that.
Only the final render (section 12) works at 2160, and it needs none of the toolkit's picture files: the project's graphics are HyperFrames compositions that `hyperframes render` draws itself, so an edit never renders the 2160 graphics set; the `.mov` files of `ve.py gfx` are for the toolkit's own previews, QA frames and review exports.
The work folders of `ve.py gfx` and `thumbs.py` are removed with retries and never raise (Windows keeps a file locked for a moment after Chrome or ffmpeg ends), and the cache key of a graphic is written as soon as its file is in place, so a failing cleanup cannot cost the cache.
`npm run toolkit:test` runs its own tests (`toolkit/tests/`, Python's unittest).

## 8. Jobs and queues

### Kinds, queues and actions

| Kind | Queue | Started by | Done when |
|---|---|---|---|
| `edit` | edits | Start Editing | the project exists and passes the profile check |
| `reEdit` | edits | Re-Edit (a change request for the whole video) | the project changed since the job started and passes the check |
| `timelineEdit` | timeline | change requests on the timeline (section 11) | as `reEdit` |
| `render` | renders | Render Final (section 12) | the final file exists |

`edit`, `reEdit` and `timelineEdit` are agent jobs; `render` runs HyperFrames directly, without an agent.
A video has at most one active job (queued, running, pausing, paused, stopping) at a time.
Agent jobs work like this:

- the agent's working directory is the video folder; the prompt gives the video folder, the channel directory and the toolkit folder as absolute paths;
- sessions are remembered per video in the database; a session is resumed only by the program that created it;
- the expected output is the project of section 10 (progress milestone `project_saved`);
- the completion marker is `[OUTPUT COMPLETED]`; after it the server runs the profile check (section 10): when it fails the agent is told the errors and asked to fix them (at most twice), then the job fails with "The project has errors: ..." and, for `reEdit` and `timelineEdit`, the project is put back to the revision from before the job;
- before every agent job that can change an existing project, a revision is saved (section 11);
- Render Final does not talk to an agent;
- the prompt names the machine (OS, CPU, memory, GPU) in one line;
- the toolkit's heavy steps obey the limits of section 9, which the server enforces; there are no lock files between sessions.

Which actions a video offers is computed by the server (`VideoView.actions`): `startEdit`, `pause`, `continue`, `stop`, `reEdit`, `review` (open the timeline; offered when a project exists), `renderFinal` (a project exists and no job is active), `upload`, `diskCleanup` (no job is active and `CLAUDE_VE` holds files), `archive`, `unarchive`, `startNow` (admin only, a queued edit held only by the start delay).

### State machine

- `startEdit`, `reEdit`, change requests on the timeline, `renderFinal` and `continueJob` put the job in `queued`; a queue is first in, first out (the edit queue also orders Urgent jobs first).
  At most the queue's slots are held by jobs in `running`, `pausing` or `stopping`.
  A changed limit applies at once: when an admin raises it, waiting jobs start right away.
- `queued` to `running` when a slot is free and the start delay allows it: the agent process is started and its message is sent.
- `running` to `pausing` on `pauseJob`: the turn is interrupted, the server waits for the agent to go idle, closes the process, then the job is `paused`; the session id is kept, so nothing is lost.
- `paused` to `queued` on `continueJob`: a new process resumes the same session with a "continue" message.
- `running`, `paused` or `queued` to `stopping` and then `stopped` on `stopJob`: interrupt, then the whole process tree ends; working files stay on disk, and a later Start Editing begins a new session.
- `running` to `completed` when the agent is done by the rule of "Keeping a job going" and the expected output exists.
- `running` to `failed` when the agent is finished without the expected output, exits with an error, or reports an error result.
  `error` holds a short readable message, for example "Claude usage limit reached, resets at 4:30 PM" or "Claude finished without creating the project.".
  A turn that ends before the work is done is not a failure: the job stays `running` and the server sends the next message; it fails only for the reasons listed in "Keeping a job going".
- `continueJob` on a `failed` job resumes the same session and tells the agent what was missing.
- The server closes a job's halt under the manager's lock before it sends a pause or a stop (also when shutting down); the driver writes a message only while the halt is open, so no message is ever sent after one was asked for.
- A job recovered as paused after a restart has no process; nothing goes on until Continue.
  Continue, like every launch, starts a new run with new counters.

One session per video:

- Every video is edited in sessions of its own; no two videos ever share one.
  Each job runs its own agent process, started with exactly one of `--session-id <new uuid>` (a new session) or `--resume <the video's own session>` (Continue, Re-Edit, timeline edits).
  `--continue` is never used: it picks the most recent conversation of the working directory.
- Start Editing always starts a new session; `reEdit`, `timelineEdit` and Continue resume the video's own session.
- The helper process for models and usage (section 5, "Usage limits") never carries a job: it has no session flag, runs with `--no-session-persistence` and only answers control requests.
- OpenCode 2 chooses the id of a new session itself (`ses_...`); a session is resumed only by its own id, and each run has its own OpenCode 2 server.
- A video has at most one active job, so no two live processes ever use the same session.

Setup of a job:

- A job records the setup its session runs on (`setup`, `model`, `effort`) and the program it runs in (`harness`).
- A new edit uses the current setup (section 5): the admin's model and effort for it.
- Re-Edit and timeline edits resume the video's session, so they stay on the setup and program that session started with (a conversation written by one model family cannot be safely replayed to another, and one program cannot resume another's session); without a session to resume they use the current setup.
  Continue keeps the job's own setup, model, effort and program.
- When the job's own setup cannot run at launch (the key of `opencodeGo` was removed, its model is no longer offered, its program is missing or not a version VidAI drives, or Claude Code is logged out on `claudeSubscription`), a launch that would resume a session starts a new session on the current setup instead, with the full instructions, records its new setup and program, and logs "This video's session ran on OpenCode Go (glm-5.3), which cannot continue it now (No API key is saved for OpenCode Go). A new session on Claude Code with Claude Subscription gets the full instructions.".
  A launch that has to start a new session anyway fails with the reason (a readiness sentence of section 5).
- The first status line of a run names the program, the service and the model: "Started a new Claude Code session on Anthropic Compatible API (model claude-sonnet-5-5)", "Resumed the OpenCode 2 session on OpenCode Go (model glm-5.3)"; the services are named OpenCode Go, Anthropic Compatible API and OpenAI Compatible API, and a launch on `claudeSubscription` names only the program.
- A job on an API option gets its readable errors from what the service answered (section 5, "Harness, program and model"), never "Claude Code is logged out" or "Claude usage limit reached".

### Driving Claude Code

Spawn, with the video folder as working directory and the server's environment:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode bypassPermissions [--model <model>] [--effort <effort>] \
  (--session-id <new uuid> | --resume <session uuid>)
```

- The process is started in its own process group (Windows: Job Object) so the whole tree can be ended (section 8, "Recovery").
- A job on `anthropicApi` also gets the variables of that option (section 5); a job on `claudeSubscription` gets none of them.
- A message is one JSON line on stdin: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null,"session_id":""}`.
- Interrupt is one JSON line on stdin: `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}`; Claude Code answers with a `control_response` and stops its background tasks.
- stdout is one JSON object per line.
  Relevant types: `system` (subtypes `init`, `task_started`, `task_notification`, `background_tasks_changed` and others), `assistant` (content blocks `text`, `thinking`, `tool_use`), `user` (tool results), `result`, `rate_limit_event`.
  Unknown types and subtypes are ignored, never errors.
- A `result` ends one turn, not the job.
  Claude Code often ends a turn while background tasks (renders, sub-agents) still run and starts a new turn by itself when they report back.
  The agent is idle, and the job may be finished, only when a `result` has arrived, no background task is active, and nothing new started during a settle time of 4 seconds; then the server closes stdin and the process exits with code 0.
- After `--resume`, Claude Code can emit an immediate empty `result` (`num_turns` 0) before it handles the new message; it is not counted as the answer to the message just sent.
- The error of `--resume` for a session Claude Code no longer has is recognised, and the job starts a new session with the full instructions plus a paragraph about the earlier work.
- `--permission-mode bypassPermissions` is what `--dangerously-skip-permissions` sets; hooks and settings of the OS user's own Claude Code configuration apply and are left alone.
- The helper for models and usage is a Claude Code process in the same stream-json mode that answers control requests without a model call (section 5, "Usage limits").

### Driving OpenCode 2

OpenCode 2 is driven through its own headless server, one server per run of a job, on this computer only; its HTTP API is `/api/...` with server-sent events at `/api/event` (`agents/opencode/`).
It was chosen over `opencode2 run` because an interrupt is not a kill of a process per message, and because the server reports background work, which a job must wait for.

A run:

1. The server starts `opencode2 serve --stdio --hostname 127.0.0.1 --port 0` in its own process group, with the video folder as working directory and a pipe to its stdin.
   With `--stdio` OpenCode picks a free port itself, ends when its stdin closes (so it never outlives VidAI, also after a crash), and keeps its password out of the environment of the commands it runs.
2. The address is the first line it prints, `{"url":"http://127.0.0.1:<port>"}`.
3. Every request carries the run's password as HTTP basic auth (user `opencode`) and the video folder as the header `x-opencode-directory` (percent-encoded), and goes to 127.0.0.1 without a proxy.
4. `GET /api/event` is subscribed first (events of every session of the server: `{"id","created","type","location","data"}`, the first is `server.connected`), so nothing is missed.
5. The model: on `opencodeGo`, OpenCode's own provider of the address (`opencode-go` or `opencode`) runs it only when `GET /api/model` lists it there and that provider would use VidAI's key (`GET /api/integration/<provider>` lists connections in the order OpenCode uses them and the first must be the variable `OPENCODE_API_KEY`); a login stored in OpenCode's own database comes first and cannot be overridden, so with one, VidAI's own provider `vidai` runs the model; so it does for any other address and for a model the catalog does not list.
   On `openaiApi` `vidai` always runs it.
6. A new session is `POST /api/session` with the title "VidAI: <video folder name>", the model (`{"providerID","id"}`), the video folder as its location, and permission rules that allow everything and deny `question` (which removes the question tool).
   A permission request that still comes (`permission.asked`) is answered `once`; a form (`form.created`) is cancelled with a message that tells the model to go on without an answer.
   A resumed session is checked with `GET /api/session/<id>`; a 404 is treated like a session Claude Code does not have (new session, full instructions).
   A resumed session that ran on another model is moved to the model first (`POST /api/session/<id>/model`).
7. A message is `POST /api/session/<id>/prompt` with `{"text"}`; it is queued and joins the current busy period of the session or starts one.
   A message OpenCode refuses ends the turn at once with an error that says why.
8. Pause and Stop are `POST /api/session/<id>/interrupt`; the running step and its commands stop at once.
   Because background work would wake the session again, the server also ends the session tree's running background commands (`GET /api/experimental/job?sessionID=<id>&descendants=true&status=running`, then `DELETE /api/shell/<id>` for each), interrupts its sub-agents (`POST /api/session/<child>/interrupt`), and keeps interrupting busy periods that still start until the server is closed.
9. Closing the run closes the stdin pipe and sends SIGTERM to the server's process group; the commands it started run in groups of their own and are ended with the job's process tree.

Background work:

- The shell tool moves a command that is still running after its timeout (2 minutes unless the model gives a longer one) to the background; `background: true` starts it there.
  The sub-agent tool always runs its child session in the background.
- Both answer at once; when the command ends or the child goes idle, a report is queued for the session that started it and starts a new busy period.
  The job engine therefore sees them as Claude Code's background tasks, and a job is finished only when no turn runs and no background work is left.
- While the main session waits for background work only, the server compares it with the OpenCode server's job list every 30 seconds; work the list does not have twice in a row is no longer waited for, so a lost report cannot hold a job forever.
- The OpenCode block of the first message (section 8, "Prompt") names these tools and says that sub-agents and long commands report back, that a long command needs a long enough timeout, and to end the turn when only waiting.

The event stream is translated into Claude Code's vocabulary, so the job engine, the log, the progress and the turn tracking read both programs the same way:

| OpenCode 2 | Job engine event |
|---|---|
| main session busy (`session.execution.started`) | `system` `init` with the session id and model |
| `session.text.ended` | assistant text (nested for a sub-agent's session) |
| `session.tool.called` | assistant `tool_use`, named and shaped as Claude Code's tools (`shell` is `Bash` with `run_in_background`, `read`, `write`, `edit` are `Read`, `Write`, `Edit` with `file_path`, `subagent` is `Agent` with `subagent_type`) |
| `session.tool.success` / `session.tool.failed` | user `tool_result` (failed: `is_error`) |
| `session.tool.progress` | `system` `task_progress` |
| a command or sub-agent that goes on in the background | `system` `task_started` |
| its report queued for the main session | `system` `task_notification` |
| terminal event of the main session (`session.execution.succeeded`, `.failed`, `.interrupted`) | one `result` per message that joined the busy period |
| `session.retry.scheduled` for a usage limit | an error `result` at once; any other retry is `system` `api_retry` |

Reasoning, deltas, steps, usage and heartbeat events are dropped; unknown events and fields are ignored.

Errors and limits:

- Errors arrive as `session.execution.failed` with OpenCode's error (`{"type","message","status","response":{"body"}}`); they become "API Error: <status> <body>" worded like a job on `anthropicApi` (section 5), and anything else is "OpenCode 2 reported an error: <first line>".
- A Go, free or budget limit is not retried by OpenCode: the job ends at once with the limit in OpenCode's words.
- A busy period interrupted without the server asking (OpenCode shutting down) is the error "OpenCode 2 stopped the turn (shutdown).".
- A server that cannot start fails the job with "The OpenCode 2 program could not be started: <reason>"; the start may take up to 180 seconds (the first start can migrate a database or let macOS check the program), the log says "Still waiting for OpenCode to start (8 s)" after 8 seconds and every 15 seconds after, and the reason holds the last four lines the server printed.
- The log names the program "OpenCode 2".

### Keeping a job going

Some models end a turn with a sentence that announces the next step and no tool call, long before the work is done.
Claude Code then reports a normal `result`, and without this rule the job would look finished and fail with "Claude finished without creating the project.".
The server therefore decides at every idle moment of every agent job, on every setup and in both programs (`jobs/keepgoing.js`, a pure function free of program types).
The harness reports the idle moment with what the main conversation did since the last message (tool calls, whether it wrote `[OUTPUT COMPLETED]`) and the evidence (the project on disk, whether an edit's thumbnails and `meta.txt` are written, the finished progress milestones), and gets back: done, send this message, or stop.

A job is done, checked only at an idle moment and never while a background task runs, when the deliverable exists and `[OUTPUT COMPLETED]` was written in this run:

| Kind | Deliverable |
|---|---|
| `edit` | the project in `output/` that passes the profile check |
| `reEdit`, `timelineEdit` | a project modified after the job started that passes the check |

Cases:

- The deliverable without the marker: one message asks to finish the last steps (naming missing thumbnails and `meta.txt` of an edit); at the next idle moment the job is done whatever the model wrote.
- The marker without the deliverable: the model is asked to save it, at most twice; a third time fails with the missing output error.
- Neither: the turn ended early; the model is asked to keep going.
- Waiting for its own commands: a model that starts a long command in the background of a shell ends its turn to wait, which Claude Code does not track as a task.
  The server reads the CPU time of the job's process tree every 5 seconds; when a process used at least a tenth of a core since the last look, the computer counts as busy with the model's commands for the next 90 seconds.
  At an idle moment of a busy job, with neither deliverable nor marker, the turn counters are not touched and the model gets a wait message instead (do not end the turn, wait with one command that blocks until they finish, restart a command that shows no output for 10 minutes); at most one goes out every 5 minutes, it is logged "Asked to wait for the running commands (n): the computer is busy with your background work", and it counts only toward the ceiling.
  A process that is not busy leaves the ordinary rules in force, so a hang is still found.

The message goes to the same live process and session; nothing is restarted.
The texts are in `server/src/jobs/promptTexts.js` (exact-text tests): "Keep going" says the project is not finished and asks to do the next step with tool calls and never to end a turn after only announcing a step; "Finish" names the saved project and what is still missing; "Save" says the marker was written but there is no project.
On every setup except `claudeSubscription` they also ask to write each progress marker right after its step.

The job stays `running` the whole time: no `failed` state, no error line.
The log gets one status line per message, numbered per run: "Asked to keep going (1): the turn ended before the edit was finished", "Asked to finish the last steps (2): the project is saved, [OUTPUT COMPLETED] is not written yet", "Asked to save the project (3): [OUTPUT COMPLETED] was written, but it is not in the output folder".

The job stops for real reasons only, each with a readable error, and Continue starts it again:

- An API problem that the program reports after its own retries (an error result, or a result whose text starts with "API Error"), in the words of the provider (section 5, "Harness, program and model"; on the Claude subscription `jobs/errors.js`), with no further message; a temporary problem is first retried by the server itself (next section).
- The process exits by itself or crashes ("Claude Code stopped unexpectedly (exit code 1): ..."), or prints nothing at all for the stall time of 20 minutes in the middle of a turn ("Claude Code stopped responding (no activity for 20 minutes)."; the job is done instead when the deliverable is there).
  While a tool call runs that was started with a time limit of its own (the `timeout` of a shell call), the stall time is that limit plus two minutes when that is longer.
- Pause, Stop or the server shutting down.
- A stuck model, per run:
  - 3 idle moments in a row whose turns made no tool call at all: "The model stopped working on the edit: it ended 3 turns in a row without doing anything. Press Continue Editing to try again."
  - 8 messages in a row without new work (a new progress milestone or a new file written in the video folder): "The model made no progress on the edit after being asked 8 times to keep going. Press Continue Editing to try again."
  - The ceiling of 40 messages in one run (waiting messages included): "The edit is still not finished after VidAI asked 40 times to keep going, the most it asks in one run. Press Continue Editing to go on." A deliverable that exists at the ceiling still completes the job.
  - The wording says "the model", not "Claude", because on an API option it is not Claude.

### Retrying after a model error

A model provider fails now and then for a few minutes (overloaded, rate limited, a network drop), and an edit that ran for an hour should not stay dead because of it.
`maxModelRetries` (section 5, 0 to 50, default 5; 0 turns it off) is how many times in a row the server waits and then continues the same session by itself, exactly like Continue (the job keeps its program and session).
It is read when a failure happens, so a change applies to running jobs as well.

What is retried (`jobs/retry.js`, from the result text and the HTTP status in it):

- a status of 400, 408, 409, 425 or any 5xx;
- 429 and any usage or rate limit, where the wait honors the reset time the provider names (Claude Code's rate limit event, or the epoch at the end of an OpenCode limit text) when that is later than the schedule's wait;
- a text that says overloaded, rate limit, internal server error, bad gateway, service unavailable, temporarily unavailable, gateway timeout, timed out, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, socket hang up, fetch failed or network error.

Never retried, and failing at once: a missing program or login, a status of 401, 402, 403 or 404, the OpenCode Go and Free usage limits, a used-up budget or credit, a model that is not found, Pause, Stop, shutdown, and the stuck-model rules above.

The waits before retry 1 to 5 are 30 seconds, 1 minute, 2 minutes, 5 minutes and 10 minutes; every later retry waits 15 minutes.
A reset time the provider named that is later than that wait is waited for instead.
Waits are measured on the wall clock.

- There is no new job state: the job stays `running` while it waits, so it keeps its slot and the queue behind it does not move (the provider fails for everybody).
  Pause or Stop ends the wait at once and frees the slot; nothing is retried afterwards.
- The job shows it: `lastActivity` says "Model error. Retrying at 14:32 (retry 3 of 5)" and the log gets "Model error (529 Overloaded). Retrying in 2 minutes (retry 3 of 5)", later "Retrying now (retry 3 of 5)".
- The running clock keeps counting during the wait, so a usage limit whose reset is hours away holds its slot for hours, until the reset or Stop.
- The count starts over when the job makes real progress (its finished milestones or its files written grew) and when the user presses Continue.
  After `maxModelRetries` retries in a row without progress the job fails with the provider's error followed by "VidAI retried N times without success.".
- The quiet limit of Claude Code (the process only stops with its limit seen on the event stream, no error result and no output) is retried the same way, waiting for the reset it announced.

### The job log

- The log of a job is one entry per thing the agent did, kept in `<data dir>/logs/<jobId>.jsonl` (one JSON object per line, appended in batches) and sent to the browser as `job-log` events, at most one batch per 150 ms.
  An entry has `seq` (increasing per job), `ts`, `kind` (`status`, `assistant`, `tool`, `toolResult`, `user`, `error`), `text`, `detail` (full command, input or output, cut to 4000 characters) and `nested` (made by a sub-agent); `getJobLog` returns at most the last 5000 entries.
- Entries are readable: a tool call becomes one line of at most 160 characters (for example "Bash: Render graphics at 1080", using the tool's description when there is one) with the full input in `detail`.
  The agent's own messages are kept as written, and the UI renders their Markdown, never as HTML.
  Thinking blocks are not logged.
  A tool result that is an error reads "Error: <first line of the output>", except one that VidAI itself cut short: when a pause or stop asked the agent to stop the current step, the steps still running end with an error result that is only the answer to that request, and it reads "Stopped by the pause" ("Stopped when the job was stopped" after a stop) with the output so far in `detail`; the server decides this from having sent the interrupt, never from the text.
- Absolute paths in tool lines and results are shown relative to the video folder (`CLAUDE_VE/timeline.py`), or to the channel directory or the video's server folder (`<data dir>/projects/<videoKey>/`); whole path prefixes only, on Windows in all spellings (`C:\...`, `C:/...`, `/c/...`); `detail` keeps the original.
- Every API key given to a job is registered with the scrubber and replaced by `[api key]` in every entry, in the file and in the events, also in its JSON-escaped form; text is scrubbed before it is cut to a length, so a cut can never leave half a secret.
- Lines that name the program say "Claude Code" or "OpenCode 2" ("OpenCode 2 is running (model vidai/glm-5.3)", "Sent the edit instructions to OpenCode 2", "Pausing: asking OpenCode 2 to stop the current step").

### The edit queue

- Slots: `maxEdits`; running, pausing and stopping jobs hold a slot; paused and queued jobs do not.
- The line of waiting jobs is ordered: Urgent jobs first, in the order they joined the line; then the others, in the order they joined.
- So an Urgent job is behind the running ones and behind earlier Urgent ones, and ahead of everything else.
- "Joined the line" is the time of Start Editing or Re-Edit; a paused job that is continued gets its old place back (its original time).
- When a slot is free the first job in the line starts, skipping jobs of a user who already has `maxEditsPerUser` edits running (when that limit is set).
- `startDelayMinutes` is kept between two launches of new sessions in this queue (a Continue that resumes a session is not a launch); `startNow` skips it for one job.
  The delay does not hold a job while nothing in the queue holds a slot, and the time of the last launch is kept in the database, so it survives a restart.
  While the delay holds the first waiting launch the launches behind it wait too and start one delay apart; Continues behind it may pass it when a slot is free.
  `startsAt` is set only while a queued job waits because of the delay (the first waiting launch gets the last launch plus the delay, the next one more delay, and so on) and is null otherwise; its `lastActivity` says "Waiting for the start delay", "Waiting for a free slot" or "Waiting to continue".
  The queue is looked at again exactly when that delay runs out (a timer measured on the wall clock), when a setting changes and whenever a job ends; a last launch in the future counts as now.
  `startNow` (admin only) works only for a queued edit held by nothing but the delay (otherwise `conflict`: "This edit is not waiting for the start delay."), starts it at once and restarts the delay clock, and the other waiting jobs get their new `startsAt`.
- The per-user limit counts only that user's jobs that hold a slot.
- Urgent is a checkbox in Start Editing and Re-Edit, shown only to users who may use it (`mayMarkUrgent`, default yes); an admin can switch Urgent on and off for any waiting job; a user who may not use it and asks for it gets `forbidden`.
- Every waiting job has a position (1 = next, counted among waiting jobs only; a job skipped for the per-user limit keeps its number); users see "Waiting, position 3" for their own jobs and the count of jobs ahead; the admin's Queue page lists every job of all three queues with user, channel, video, kind, state, Urgent and position.

### The timeline queue and the render queue

Both are plain first-in first-out lines with their own slots (`maxTimelineEdits`, `maxRenders`), no Urgent and no start delay.
The newest 50 ended jobs of a video are kept, with their logs; older ones are removed.
A `timelineEdit` job resumes the video's session; when the session cannot be resumed it starts a new session with the full instructions plus the change requests.

### What a job keeps and puts back

- A job keeps the setup, program, model and effort it started with. A Re-Edit or a timeline edit goes on in the video's session when the same program made it; otherwise it starts a new session with the full instructions.
- When a session's setup is no longer ready, the job starts a new session on the current setup and the log says so.
- Before a job that finds a project, the server saves a revision when the files differ from the current one ("Existing project" for the first, "Changed outside VidAI" later), once per job.
- A Re-Edit or timeline edit that fails or is stopped puts the project back as it was before the job when it changed, and its change requests become failed. A failed first edit leaves its files.
- A completed job saves a revision ("Edit", "Re-Edit", "Change request"); revisions of jobs carry the job and no user.
- The job's owner, the owner of the video and an admin may pause, continue and stop it; for everybody else it does not exist.
- Start Editing is refused without an A-roll, with an existing project (that is Re-Edit) and while the video has an active job; Re-Edit needs an edit to change.
- When the server shuts down, running edits are paused and running renders are stopped, so nothing is lost and nothing goes on by itself after the next start.

### Recovery

On start, jobs that were running, pausing or stopping become paused (agent jobs with a session) or stopped (no session, and every render); queued jobs stay queued and keep their place.
The time the server was down is not counted as working time of a job.
Every agent process is started in its own process group (macOS) or its own Job Object (Windows), so the whole tree (the agent, shells, ffmpeg, Python, Whisper, sub-agents) can be ended.
Ending a tree on macOS sends SIGTERM to every member, waits a grace period of 3 seconds and then sends SIGKILL to what is left, never touching the server itself; on Windows closing the Job Object ends every process at once, and the same Job Object ends the tree when the server dies.
Pause and Stop first ask the agent politely (interrupt, close stdin) and end the tree only when it does not go idle.
The server keeps `<data dir>/processes.json`, written by temporary name and rename, with the id, command line and job of every process of a running job.
At the next start the trees recorded there are ended before any job starts, but only a process that still exists with the same command line, so a process id that the system gave to another program is never touched; an entry whose command line could not be read is kept in the file and never ended, and a damaged file counts as empty.

### Prompt

The first message of an edit is the only message that carries the whole instructions; follow-up messages to a resumed session stay short.
The parts, in order, are separated by blank lines: the header, `PRODUCT_LINKS =` (and the PRODUCT_LINKS STEP when there is a link), `NOTES FOR THIS VIDEO:` (when not empty), the channel prompt of the video type and slot exactly as written, `CHANNEL_STYLE (<Long 16:9 | Short 9:16>):`, the "VidAI:" paragraph, the OpenCode 2 block (program OpenCode 2 only), the keep-working paragraph (every setup except `claudeSubscription`), and the progress markers of the kind (milestones below).
The header has one line each, in this order: `MAIN_FOLDER` (the video folder, also the agent's working directory), `CHANNEL_FOLDER`, `TOOLKIT_FOLDER` (`<data dir>/toolkit/CLAUDE_VE_ALL`), `PYTHON` (the toolkit's Python), `Channel Name`, `VIDEO_TYPE` (Long or Short), `BROLL_FOLDER`, `PROJECT_FOLDER` (`<video>/output/<video folder name>.hf`), `CHECK_COMMAND`, `MACHINE:` and `LIMITS:`.
All paths are absolute.
`CHECK_COMMAND` runs the server's own check of section 10 on the project (`server/src/timeline/checkCli.js` with the server's Node.js and the project folder); it prints each error on its own line and ends with code 1 when there is one.
On Windows the paths inside `CHECK_COMMAND` and inside the toolkit command line of the "VidAI:" paragraph are written with forward slashes (the other header lines keep the backslashes of the system), because every Windows shell accepts them in double quotes and a backslash before a closing quote breaks PowerShell arguments.
`MACHINE:` names the operating system and version, the processor model and its logical processors, the memory and the graphics adapter; a part that cannot be found is left out.
`LIMITS:` says in words how many processor cores and GPU tasks the job may use (section 9) and that the toolkit already obeys it.
The "VidAI:" paragraph says: nobody can answer; the toolkit is called as `"<PYTHON>" "<TOOLKIT_FOLDER>/ve.py" <command> "<MAIN_FOLDER>"` (on Windows one more sentence says that PowerShell needs `&` in front of the line, Git Bash and cmd.exe must not get it, and that `CHECK_COMMAND` follows the same rule; the server knows it runs on Windows from the drive letter of the Python path), and `CLAUDE.md` and `MEMORY.md` next to `TOOLKIT_FOLDER` are read first; the style rule; the result is the project of section 10 in `PROJECT_FOLDER`, written by `ve.py hf`, which must pass `CHECK_COMMAND`; originals are linked, never copied or changed; every motion graphic is its own file in `compositions/`; the agent never renders a video file of the edit; and the agent ends with `[OUTPUT COMPLETED]`.
A start is refused with `invalidInput` when the selected prompt of the channel for the video's type is empty or a slot is outside 0 to 4.
Only a message that starts a new session carries the header (with `MACHINE:` and `LIMITS:`) and the VidAI paragraph: the first message of an edit and the fallback below; a resumed session read them already.
The channel prompt and style are copied exactly as the user wrote them, and the first message tells the agent that nobody can answer questions.
Follow-up messages: Continue says that background tasks (OpenCode 2: commands and sub-agents) were stopped by the pause, asks to check what finished and to work until the project passes `CHECK_COMMAND`, adds what was missing when the last attempt failed, and repeats the progress-marker reminder; Re-Edit starts with "RE-EDIT REQUEST", carries the user's text and the rules (change only that, update the project in `PROJECT_FOLDER` in place, run `CHECK_COMMAND`, never render, write the marker); timeline changes as in section 11 (per request: number, time as `m:ss.mmm` and seconds, frame, area in words and pixels, picture files, clips under the frame from the top down, words spoken around that time, the user's text; then the fixed rules; when two requests conflict the later one wins).
When a session cannot be resumed, the new session gets the full first message, a paragraph about the earlier work and then the follow-up.
After `[OUTPUT COMPLETED]` the server checks the project; when it fails, the agent gets the errors and is asked to fix them and write the marker again, at most twice.
The fixed texts are in `server/src/jobs/promptTexts.js`.

### Progress

`JobView.progress` drives the completion bar of every video row and of the activity panel: `percent` (0 to 100) and `stage`, one short label of what the job works on now.
It is computed by `server/src/jobs/progress*.js` (a pure engine that takes the job's active milliseconds, wrapped by `progressTracker.js` with the clock and the file probes) and published by the job's driver.

Each agent job kind has a model: a weighted checklist of milestones, not a strict sequence (the work after the edit plan runs in parallel, so milestones can finish in any order).
The percent is the sum of the weights of the finished milestones plus an estimate from active time for the unfinished ones.
The stage is the label of the first unfinished milestone in the order of the model, "Finishing up" when all are finished, and "Done" once the job is `completed`.
Two more labels are not milestones: "Getting the tools ready" while the job installs or tests its tools, and "Working on the edit" (re-edit and timeline edit: "Working on the changes") once the bar is ahead of what the evidence confirms.
The weights follow the share of the active time at which each milestone ends in real edits: for a Short of about 25 minutes the transcript is ready at about 3.5, the plan at 7, the graphics at 20.5 and the project at 23.5 minutes; a Long of about 40 minutes reaches them at about 8, 15, 34 and 40.
The calibration is written next to the models in `progressModels.js`.

A finished milestone implies the ones that must be done before it: `transcribed` implies `inspected`, `planned` implies `transcribed`, every milestone after the plan implies `planned`, and `project_saved` implies the graphics, b-roll, timeline and checks (and `changes_applied` for a re-edit or timeline edit).

Evidence, most reliable first:

1. Markers: a line in a normal message of the main session that holds only `[VIDAI_PROGRESS <name>]` (Markdown emphasis or code around it is allowed, case and `-` / `_` do not matter); a marker inside a sentence is prose, and markers of sub-agents never count.
   The log shows each marker line as a compact status entry with the milestone's done text (for example "Transcription done"), and an unknown name as "Progress: <name>".
2. Files in the project's output folder written after the job started, looked at about every 5 seconds: the project (`project_saved`) and a thumbnail together with `meta.txt` (`extras_written`).
   Files that were already there, unchanged, when the run started never count.
3. Kinds of files in the video folder outside `output/` (an edit only; `jobs/work*.js`): written since the job started, down to 8 levels, at most 20000 entries and 300 ms, never following a link and skipping `.git`, `node_modules`, `__pycache__`, `.venv`, `.hyperframes` and caches.
   Only names count, never content, and only the part after the working folder `CLAUDE_VE`:
   - an audio file: `inspected`;
   - a transcript (a text file in a folder or with a name that says transcript, or any `srt` / `vtt`): `transcribed`;
   - a plan (a text or script file whose name has the word plan, timeline, spec, cue, EDL, storyboard or shot list), once the footage was looked at: `planned`;
   - anything in a folder named `gfx...`, `graphic...`, `hyperframes`, `remotion`, `compositions`, `cards` or `overlays`, once the footage was looked at: `planned`;
   - anything named `qa`, `qa_...` or `...-qa`: `graphics_built`, `broll_ready` and `assembled`, which are implied and never learned from.
   The number of such files also counts as work done for the stuck-model rule (section 8, "Keeping a job going").
4. The stream, keyword based and not tied to one toolkit: a command or task about Whisper or transcribing (`inspected`); the main session reading a transcript data file or writing a plan-like or graphics file (`transcribed`, `planned`); a transcription sub-agent completing (`transcribed`; the completion of a shell command that only starts Whisper in the background is not); a sub-agent or task about graphics, HyperFrames, animations or cards starting (`planned`); every such graphics sub-agent started after the plan completing (`graphics_built`); every b-roll, conform, stabilization or product image sub-agent started after the plan completing (`broll_ready`); a thumbnail or meta sub-agent completing (`extras_written`).
   Only a `completed` task notification counts; a stopped or failed task is done again later.
5. Time (Pacing below).

Setup is not the work.
A command or task that installs, creates an environment, smoke-tests, downloads a model or tool, or asks for `--help` or `--version` is setup, however often it names Whisper: it never counts as transcription, never starts a step, and its time is not counted by the estimate.
While one runs the stage is "Getting the tools ready"; before the footage was looked at, once any setup was seen, the stage stays that and the bar stays in its first 2 points until real work starts.

Pacing (evidence 5):

- A model has a typical timeline: the active time at which each milestone is typically finished (the defaults below, or learned from history) and the stretch each takes from the milestone whose end it follows (the b-roll and the graphics both follow the plan; the timeline follows both).
- The job is put on that timeline at its anchor: the finished milestone that is typically reached last, at the active time it was finished (the start of the job when nothing is finished).
  The thumbnails and the b-roll are not anchors, because they run beside the main work.
  The job's pace is that milestone's active time over its typical time, between 0.5 and 6; without such a milestone it is 1.
  Setup time is left out of the time since the anchor.
- Each unfinished milestone is credited the share of its weight that the typical timeline has reached since the anchor, in its own stretch.
- The stage stays one point short of its value until the typical end of its stretch.
  When the job is later than that without evidence, the estimate goes on into the following milestones with a slow-down that never stops: the time past the typical end counts at 30% of the typical speed at first and then logarithmically less (the scale is 10% of the typical total time), and once the bar is 2 points past the value of the stage the stage reads "Working on the edit" until a step is confirmed.
- Never past the files: a milestone that only a file confirms (the project, the thumbnails) is never credited by time, and the bar never goes above the value of everything before the first of them that is unfinished plus all but one point of its weight (an edit without a project: 95; re-edit and timeline edit: 94).
- The bar never goes backwards, so evidence that the job is behind its estimate holds the bar until the estimate catches up.

Typical times: the defaults are the active minutes in `progressModels.js` (an edit: about 25 for a Short and 42.5 for a Long; a re-edit: 7.5 and 12.5; a timeline edit: shorter).
From the last 10 completed jobs of the same kind and video type (`progress_history`, section 15) the median total replaces the default once at least 3 of them exist, and every default milestone time is scaled by it.

Rules:

- A new job has `progress` null while it waits in the queue and starts from 0 with its own model when it runs.
- Progress never goes backwards within a job and stays at 99 at most until the job is `completed`; then it is exactly 100 with the stage "Done".
- It freezes while the job is pausing, paused, stopping, stopped or failed, and goes on from the same value and the same finished milestones on Continue, also after a restart of the server (`videos.progress_memory`); pauses do not count as time.
- It is published with `job-updated` when the percent or the stage changes, at most about once a second per job (a new stage at once).
Milestones: `edit`: inspected 3, transcribed 12, planned 15, graphics_built 34, broll_ready 10, assembled 9, checked 8, project_saved 5, extras_written 3; `reEdit`: changes_applied 65, project_saved 30; `timelineEdit`: changes_applied 70, project_saved 25; `render`: from the renderer's own progress lines (section 12).

## 9. Resource limits

### CPU

Let `N` be the number of logical processors.
`perEdit = max(1, floor(N * cpuPerEditPercent / 100))` and `total = max(1, floor(N * cpuTotalPercent / 100))` processors.
With `R` heavy jobs running (agent jobs, renders, preview-copy jobs), each has the budget `min(perEdit, total / R)` processors; budgets are recomputed whenever a heavy job starts or ends.

The budget is applied in two ways:

1. Told to the tools: every job process gets `VE_CPU_CORES` (the budget rounded up), from which the toolkit derives its parallel jobs, ffmpeg threads and HyperFrames workers (`vekit/resources.py`); renders get `--workers`.
2. Enforced by the server on the job's process tree:
   - macOS: every half second the server sums the CPU time of the job's descendant processes (not the agent program itself, so its connection to the model never stalls) and suspends them (SIGSTOP) while they are ahead of their budget, resuming them (SIGCONT) when they are within it again; all are resumed before a pause, stop or end. Unused budget is saved up for at most 2 seconds, so a long idle spell is not spent as one burst. A render or a preview-copy job is limited including its first process.
   - Windows: the job's process tree runs in a Job Object with a hard CPU rate limit, set and changed through one long-lived helper started by the server (PowerShell with an inline type, no extra program to install); the Job Object also ends the tree when the job is stopped.

A budget at or above the number of processors means no limit.

### GPU (approximate)

No operating system offers a GPU percentage limit, so the share is turned into a number of GPU tasks that may run at once; the UI says "approximate".
A GPU task is one hardware video encode or decode, one speech recognition run, or one HyperFrames capture or render.
`gpuSlotsTotal = max(1, round(8 * gpuTotalPercent / 100))` and `gpuSlotsPerEdit = min(gpuSlotsTotal, max(1, round(8 * gpuPerEditPercent / 100)))`.
The toolkit and the render runner take a slot before a GPU task and give it back after; a job never holds more than `gpuSlotsPerEdit`.
Work that runs in software only (a software encode, speech recognition on a computer without an NVIDIA GPU) takes no slot; speech on an NVIDIA computer is always a GPU task.
The slots are files, so that programs in any language can take part:

- `<data dir>/locks/gpu/limits.json` is `{ "total": n, "perJob": n }`, rewritten by the server (write to a temporary name, then rename) whenever the settings change; a program reads it every time it wants a slot, and takes a missing or damaged file as one slot in all and one per job.
- A slot is the file `slot-<i>` with `i` from 0 to `total - 1`, created with exclusive create and holding `{ "jobId", "pid", "at" }`; the first name that can be created is the slot taken, and when none is free the program waits and tries again every second.
- The holder sets the file's modified time every 60 seconds; a slot not renewed for 15 minutes, or whose process no longer runs, may be taken over by renaming it to a unique name first (`slot-<i>.gone-<unique>`) and deleting that (so two programs never both believe they freed it); only names that are exactly `slot-<number>` count as slots.
- A job's programs get `VE_GPU_SLOTS_DIR` and `VE_JOB_ID`; a program that does not find them runs without asking (the toolkit used by hand).

The server removes slots held by processes of ended jobs, slots with a number at or above `total`, and leftover `slot-<i>.<anything>` names.
At 5 percent everything that uses the GPU runs one task at a time.

### Graphics in the browser (Windows with an NVIDIA GPU)

HyperFrames draws graphics and frames in headless Chrome, which on Windows starts ANGLE on Direct3D 11 without choosing an adapter and so gets the default one: often the processor's integrated GPU (Task Manager shows its "3D" and "Video Processing" engines busy while the NVIDIA card idles).
No HyperFrames option or environment variable adds a Chrome argument that chooses the adapter, so the server uses the operating system's own per-program preference (Settings, System, Display, Graphics, "High performance").
`server/src/platform/gpuPreference.js` writes `GpuPreference=2;` with `reg.exe` as the value named by the full path of each browser program, under `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` (no administrator rights, the preference of the account the server runs as).
The programs are the browser `hyperframes browser ensure` found (Prepare, step "browser"), every installed headless shell in HyperFrames' cache (`<HYPERFRAMES_CACHE_DIR or ~\.cache\hyperframes>\chrome\chrome-headless-shell`) and in Puppeteer's cache (`~\.cache\puppeteer\chrome-headless-shell`), and Google Chrome, so the server's renders, the timeline's pictures and the toolkit's `ve.py gfx` and `thumbs.py` all start the same programs on the NVIDIA card.
It is done only on Windows when `nvidia-smi` names a GPU, at every server start (before any job runs) and after the browser step; a program that already has "High performance" is not written again, and a choice of "Power saving" or "Let Windows decide" for such a program is replaced.
A failure is one log line and never fails Prepare or the start.
The Prepare log line of the browser step says that the NVIDIA GPU is set for it.
Video encoding is separate: `ffmpeg` tries NVENC before Quick Sync and AMF (section 7), so Quick Sync is used only when NVENC does not start.

## 10. The project

The result of an edit is the folder `<video>/output/<video folder name>.hf/`, a HyperFrames project that also follows VidAI's own rules (the profile), so that it can be played, edited by hand and rendered without the agent.

| Path | Content |
|---|---|
| `index.html` | the root composition: every clip of the video |
| `compositions/<id>.html` | one file per motion graphic on the timeline |
| `shared/` | the channel's design kit and GSAP, copied in |
| `assets/media/<name>` | the original A-roll and B-roll files, as links (symbolic link, else hard link, else a copy) |
| `assets/` | files made for this edit (stabilised B-roll, product pictures, sound effects, a levelled voice track) |
| `edit.json` | facts for tools: frame rate, size, the sources (link name, original path, frames, rate), the graphics (id, template, variables, label), the toolkit version |
| `transcript.json` | the spoken words with times |
| `hyperframes.json`, `meta.json` | what the HyperFrames CLI expects |

### The profile

1. The root is `<div id="root" data-composition-id="main" data-start="0" data-width data-height data-fps data-duration>`; width and height are 1920x1080 (Long) or 1080x1920 (Short).
2. Every clip is a direct child of the root and is a `<video>`, `<audio>`, `<img>` or a motion graphic host (`<div data-composition-src="compositions/<id>.html">`).
3. Every clip has a unique `id`, `class="clip"`, numeric `data-start` and `data-duration` in seconds that fall on frame boundaries and are written with 9 decimals at most (6 are too few: the renderer then shows a wrong frame at some cuts), `data-track-index`, `data-vidai-kind` (`aroll`, `broll`, `graphic`, `overlay`, `hit`, `fade`, `sfx`, `music`) and `data-vidai-label` (the text the timeline shows).
4. Tracks: 0 A-roll; 1 B-roll and full-screen graphics; 2 overlays; 3 keyword hits; 4 the end fade; 10 and up sound. The `z-index` in the `style` attribute of every clip that shows something equals its track (sound clips need none).
5. The A-roll track starts at 0 and has no gaps and no overlaps; the root's `data-duration` is the end of its last clip, and no clip of any track ends after it.
6. Clips on one track do not overlap.
7. A media clip's `data-media-start` and duration stay inside its source file, whose length is in `edit.json`; a media clip without an entry there breaks the rule. The same holds for the video inside a B-roll with motion (below): its source is listed in `edit.json`, its in-point plus the host's length stays inside the source, and it lasts at least as long as the host.
8. A motion graphic host has `id` equal to its `data-composition-id` and its file is `compositions/<id>.html`; the file is a HyperFrames sub-composition with its own paused timeline; everything that moves is inside such a file.
9. `index.html` holds no animation: besides `<script src="shared/...">` (GSAP from the design kit) its one script is VidAI's fixed root script (`server/src/timeline/rootScript.js`), which registers a timeline with a single empty tween as long as the root's `data-duration` (read from the attribute, so hand edits never touch the script), and no `data-start` refers to another clip.
10. Every `src` and every file reference is a relative path inside the project without `..`, and names a file that is in the project (links under `assets/media/` are followed); nothing is loaded from the network.
    This holds for `index.html` and for every `compositions/*.html` (`src`, `href`, `data-composition-src`, CSS `url()`, `@import` and inline styles): drive letters and other schemes (`file:`, `http:`), backslashes, absolute paths, `//` and `..` are refused.
    In a composition file a `data:` URL and a `#fragment` are allowed (they load nothing); in `index.html` only a `#fragment` is.
11. The agent never renders a video file of the edit (this one cannot be read from the files; the prompt says it).
12. A full-screen graphic (a host of the kind `graphic`, which hides the clip under it) has an opaque background over the whole frame: the composition's root paints a background (a colour that is not transparent, a gradient or an image), or its first child is a `video`, `img` or `canvas`, or its first child paints a background and covers the frame (`inset: 0`, all four sides 0, `100%` of width and height, or the frame's size in pixels).
    A graphic that may show the video through it is an overlay, not a full-screen graphic.
    The sentence is: `The full-screen graphic "<id>" has no opaque background over the whole frame, so the video shows through it; give its page a background color or image.`

A B-roll clip that moves (a slow push, pull or drift) is a host like a motion graphic: `data-vidai-kind="broll"` on track 1, with the video and its one movement inside `compositions/<id>.html`.
That file has one fixed shape, written the same by the toolkit and by the server: the element `#<id>-motion` carries `data-vidai-motion='{"scale":[from,to],"x":[from,to],"duration":<seconds>}'`, the `<video>` inside it carries `data-media-start` (the in-point) and `data-duration` (as long as the source allows, at most 600 seconds past the host), and the file's script reads the attribute and runs one linear movement over the host's length.
A hand edit of such a clip rewrites only attribute values in that file; a host whose file has another shape (written by an agent, or by toolkit 1.2.0) is treated as a graphic.
A synced B-roll with a composed layout (a phone or tablet screen recording over a background picture, with the speaker in a round box) is one host of the same kind: `data-vidai-kind="broll"` on track 1, and its file `compositions/<id>.html` holds the background `<img id="<id>-bg">`, the muted screen recording `<video id="<id>-screen">` and, inside `<div id="<id>-pip">`, the muted round host video `<video id="<id>-host">`, all inside `<div id="<id>-zoom">`, which carries `data-vidai-layout-motion` (the same JSON as `data-vidai-motion`) when the whole picture moves.
Each video carries `data-start="0"`, its own `data-media-start` (the source time of the host's first frame; the host video is the A-roll file at the same moment, so the speaker's lips match the sound) and a `data-duration` as for a B-roll with motion; the server keeps the host video on the A-roll after hand edits (section 11), where it may become several videos.
The ids end in `-screen` and `-host`, not `-video`, so the host is not a B-roll with motion; the server edits it by what the file contains (below).
Rule 7 holds for every video of a host's file whose `src` is listed in `edit.json`: its in-point plus the host's length (times its speed) stays inside its source; for a video that follows the A-roll (section 11) the length is the part of the host it plays.

Loudness of a clip is its `data-volume`.
Fades are the clip's `data-fade-in` and `data-fade-out` (seconds, linear), set by one rule that the toolkit and the server share (`server/test/support/fixtures/fade-rule.json` is run by both):

- 8 milliseconds out and in at every cut between different sources, and 8 milliseconds in at the start of the first clip, so a cut never clicks;
- nothing at a cut that continues the same source, and nothing inside a clip;
- the last clip fades out as long as the end fade picture (the `fade` clip), at most its own length, and 8 milliseconds without one;
- a clip shorter than 32 milliseconds or without sound has none.

After every hand edit the server sets the fades of the A-roll again by this rule; a project whose A-roll carries no fades at all is left as it is, and any other `data-automation` lane (ducking, for example) is never touched.

Times are read with a tolerance of a hundredth of a frame and written within a billionth of a second of the exact frame time; frame rates are kept as exact fractions (`30`, `29.97` and `30000/1001` are all accepted in `data-fps`).
`edit.json` is `{ toolkitVersion, fps, width, height, sources: [{ name, path, originalPath, frames, fps }], graphics: [{ id, template, variables, label }] }`, where a source's `path` is the `src` its clips use and its `frames` and `fps` are the file's own.

`server/src/timeline/profile.js` checks rules 1 to 10 and 12 and returns each violation as a sentence that names the element; `hyperframes lint` must also report no errors (its warnings do not count, and a lint that cannot run is logged and is not an error of the project).
`server/src/timeline/checkCli.js <project folder>` is the same check as a command for the agent: it ends with 0 when the project is fine, 1 with one error per line, 2 for a wrong call.
The toolkit's own check (`check_project`, run by `ve.py hf`) holds the same rules 10 and 12 with the same wording, and `server/test/support/fixtures/project-rules.json` (compositions with the rules each breaks) is run by both suites, so the two checkers stay in step.
Opening a timeline runs only the profile check.
The check runs after every agent job and after every hand edit.

## 11. The timeline screen

Review opens the timeline of a video: a player on top, the tracks below, the change requests at the side.

### Preview

`openTimeline(videoId)` returns a preview address `/p/<token>/` that serves the project's files read-only for that session and video; the token is 32 random bytes and ends with the session or 12 hours after it was last opened; tokens are kept in memory, so after a restart the page asks for a new one (it does so whenever the player does not report ready).
What is served under it is written by an agent, so it is never trusted:

- every answer carries `Content-Security-Policy: sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'`, so the content runs without access to the VidAI origin, its cookie or the network, even when opened in its own tab;
- answers carry `Access-Control-Allow-Origin: *` (the content has no origin of its own), `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: SAMEORIGIN` (only VidAI's own pages may frame it), and no cookie is needed or read;
- a requested path must resolve inside the project folder, except the entries `assets/media/<name>` themselves, whose target must lie inside the video folder or the channel directory; names that start with a dot or contain `..`, a backslash or a colon are refused, and folders are never listed.

The server adds the HyperFrames runtime script to `index.html` on the way out (from the pinned package, as the first element of `<head>`), serves media with HTTP Range, and answers `no-store` for HTML.
The page plays it with the HyperFrames player element (`hyperframes-player.global.js` of the pinned package, served by VidAI) and talks to it only through its message bridge (play, pause, seek, state).
The page trusts nothing that comes back: it accepts messages only from the player's own frame, checks their types, and never acts on free text in them.
The player element matters: it switches the runtime to loading each clip's media only as the playhead approaches, without which a project of several hundred cuts needs gigabytes of browser memory (measured: 5 GB against 0.5 GB).

Preview copies: a video file is heavy for a browser when it is not H.264 with AAC in MP4 or MOV, is taller or wider than 1920, has more than 2 seconds between key frames, or has more than 12 Mbit/s.
For each heavy file of a project the server makes a preview copy in `cache/proxy/` (H.264, at most 1280 on the long side, the same frame rate at a constant rate, one key frame per second, AAC, fast start), named by the file's real path, size and time.
A request for the file through the preview address is answered with the copy when it exists.
Copies are made in the background, one file at a time, after an edit completes and whenever a timeline is opened with copies missing; the screen says "Preparing smooth preview (1 of 3)" and plays the originals meanwhile.
Every copy that comes ready reloads the player at the same frame, because a file the player already opened keeps playing from the original, and a browser plays an original without sound when it cannot decode the sound codec (measured in Chrome: AC-3, ALAC, 32-bit and float big-endian PCM; the picture plays, no error is raised).
Renders always use the originals.

- A file is also heavy when it is H.264 with 10 bits or not 4:2:0, is HDR (PQ or HLG), is interlaced, or is stored rotated; key frames are measured over the first 10 seconds, whose end counts as one.
- The copy is 8-bit SDR 4:2:0 with the rotation applied and both sides even; HDR is tone-mapped when the installed ffmpeg can (`zscale` and `tonemap`), otherwise only converted.
- The encoder is the computer's hardware H.264 encoder when one works (VideoToolbox on a Mac; NVENC, Quick Sync or AMF on Windows; each is tried once with a few tiny frames in the pixel format and profile it is used with, 8 bit for H.264 and 10 bit Main10 for HEVC, and ffmpeg's last error line is kept for the System page; `VE_HW` forces one or none) and a GPU slot is free within 100 ms, otherwise libx264; a failed hardware attempt is repeated once in software. A copy counts against the CPU and GPU limits of section 9 like any other work.
- A copy is written as `.part` and renamed when complete; leftover `.part` files are deleted at start. A file whose copy failed is not tried again until the file changes or the server restarts.
- `openTimeline` returns `previewCopies` (`{ total, done, running }`) and the event `preview-copies-changed` (`{ videoId, copies }`) brings each change to the owner.
- A file used by several videos is copied once. Copies not used for the longest time are deleted when the cache passes its size limit (checked at start, daily, and at once when an admin lowers the limit `proxyCacheGb`, where 1 GB is 1024^3 bytes); removing or archiving a video cancels its waiting copies.

### Timeline data

`getTimeline(videoId)` returns the revision number, frame rate, size, duration in frames, the tracks (listed from top to bottom as the screen shows them) with their clips (id, kind, label, start and duration in frames, track, and for media the source name, in-point and source length in frames, for graphics the file), the change requests, whether undo and redo are possible, and `locked` (`null` or the job that holds the project).
All times on the wire are whole frames.

The tracks are listed as Premiere Pro stacks them: picture tracks upward, the layer drawn on top first, then the sound.
The `z-index` of a picture clip is its track number (section 10 rule 4), so the list is track 4 (End fade, covers everything), 3 (Keyword hits), 2 (Overlays), 1 (B-roll and graphics), 0 (A-roll, the bottom picture layer), then the sound tracks 10 (Sound 1), 11 (Sound 2) and up.
The server decides this order (`toTimeline` in `server/src/timeline/model.js`) and the screen only keeps it: the track headers, the lanes, the Up and Down arrows between clips and a click on a lane all follow the list, so never rely on the A-roll being the first entry; find a track by its `index`.
The project is locked while a job of the video is active; a locked timeline plays and accepts change requests but no hand edits.

### Hand edits

`editTimeline(videoId, revision, op)` applies one operation to `index.html`, checks the profile, saves a revision and returns the new timeline; a stale `revision` or a locked project answers `conflict`.
Edits change only attributes of clip elements (and remove or add clip elements); the rest of the file is kept byte for byte.

| Operation | A-roll clip | Other clips |
|---|---|---|
| `trim` (an edge to a frame) | the video gets shorter or longer by the change and everything after the edit point shifts (ripple); limited by the source file and a minimum of 2 frames | the edge moves; limited by the neighbours on its track, the source file (media), the end of the video and a minimum of 2 frames |
| `delete` | the clip is removed and everything after it shifts earlier | the clip is removed |
| `split` (at a frame inside the clip) | two clips, the second continuing in the source | two clips; a graphic cannot be split, a B-roll with motion or layout can |
| `move` | the clip is taken out and inserted at another cut (reorder); clips of other tracks that start inside it move with it | the clip moves in time on its track, limited by its neighbours and the ends of the video |

Ripple rule for other tracks: a clip that starts after the removed or inserted part shifts by its length; a clip that starts inside a removed part now starts at the cut point; a clip that would end after the end of the video is shortened to fit, and removed if less than 2 frames remain.
The end fade picture is the exception: it always stays at the end of the video with its length (at most the video's), whatever is trimmed, deleted or inserted before it.
A B-roll with motion (section 10) is edited like any other B-roll: trimming is limited by its source file, trimming its first edge moves where it begins in the source, the movement always runs over the clip's new length, and a split gives each part its piece of the movement, the two meeting at the cut (the second part gets its own file `compositions/<id>-2.html`).
A host whose file plays timed media of the project's sources (a layout host, section 10) is edited the same way: every `<video>` or `<audio>` in the file with `data-start="0"` and a `src` listed in `edit.json` is an inner medium, and when the host's first edge moves by k frames (a trim, or the second part of a split) the `data-media-start` of every inner medium moves by k frames of its source (k times its speed), so the screen keeps showing the same source frames at the same timeline frames; the trim is limited by every inner source, and the inner `data-duration` follows the rule of a B-roll with motion.
An inner medium whose `src` is also the `src` of an A-roll clip (the round host video) follows the A-roll instead: after every edit it shows, at every frame of the host, the source frame the A-roll plays at that timeline frame, so the speaker's lips stay on the voice whatever happened (a move of the host, a trim, split, delete, reorder or speed of the A-roll under it).
For that the file holds one inner video for each stretch of the host over one A-roll clip, with its own `data-start` (seconds into the host), `data-duration`, `data-media-start` and `data-playback-rate` (absent at speed 1) and the `src` of that clip; neighbouring stretches that continue each other in the same source at the same speed are one video.
The first video is the element that was there, the others are copies of it with new ids (`<id>-2`, `<id>-3`, ...) and copies of its CSS rules by id, and surplus videos are removed; a medium counts as followed when it has any plain `data-start`, and the profile checks rule 7 for each video over the part of the host it plays.
A stretch of the host over no A-roll (only a host that reaches past the end of the video) has no video, so the picture is hidden there.
The file is rewritten after any edit whose result does not already match (the last video may last longer than needed), so a clip that was out of step is put right by the next edit; an edit that leaves the host over the same source frames leaves the file alone.
A `data-vidai-layout-motion` movement behaves like `data-vidai-motion`: it runs over the clip's new length and a split gives each part its piece.
A move or an edit of the A-roll does not change the other inner media (the screen recording moves with the clip, as a B-roll's source does), and media that `edit.json` does not list (a picture, a decorative clip) are left alone.
Such a host can be split into `compositions/<id>-2.html` (all ids of the file get the new id); a graphic that plays no such media cannot.
The files of such clips are written before `index.html`, and all are put back when the revision cannot be saved.
When shifting makes two clips of one track overlap, the later clip keeps its place and the earlier one is shortened, or removed if less than 2 frames remain.
Deleting the last A-roll clip is refused.
For an A-roll trim the clip keeps its start on the timeline: moving its first edge changes where it begins in the source, moving its last edge changes where it ends, and the difference is the change of the video's length.
An A-roll clip is moved to an existing cut (the start of an A-roll clip, or the end of the video).
Moving or trimming a clip of another track never shifts anything else.
A clip that plays at another speed than 1 can be deleted and moved but not trimmed or split.
The second part of a split clip gets the id `<id>-2` (or the next free number).

### Revisions

Every change of the project by a hand edit or a job saves a revision: a copy of `index.html`, `compositions/`, `edit.json` and `transcript.json` in `<data dir>/projects/<videoKey>/revisions/<n>/` with who, when and a label ("Trim A-roll", "Change request", "Edit", "Re-Edit").
`undoTimeline` and `redoTimeline` step through hand-edit revisions made since the last job; `listRevisions` and `restoreRevision(n)` put any earlier state back as a new revision ("Restored revision n").
The newest 200 revisions of a video are kept.

- The current revision is the newest one that is not undone; a timeline without any revision reports 0.
- A hand step is a revision made by a user's hand edit. Revisions of jobs, restores, "Existing project" and "Changed outside VidAI" are baselines, and undo never goes past one.
- Undo and redo put files back and make no revision; the next new revision of any kind drops the undone ones for good. Numbers are never used twice.
- When the project's files differ from the current revision and no job holds the project (somebody changed them outside VidAI), reading the timeline first saves a baseline: "Existing project" for the first, "Changed outside VidAI" later.
- A hand edit is applied, checked against the profile, written (temporary file, then rename) and saved as a revision; a result that breaks the profile is never written.
- A restore takes away files in `compositions/` that the revision does not have and writes `index.html` last; restoring the current revision is refused.
- Links inside a project are never read, copied or followed when a revision is saved.
- Hand edits, undo, redo and restore of one video happen one after the other.

### Change requests

A user pauses on a frame and either draws an ellipse over the area to change, or selects a clip, or neither (the whole frame), and types what to change.
`addTimelineNote(videoId, { frame, shape, elementId, prompt })`: `shape` is `null` or `{ cx, cy, rx, ry }` in fractions of the frame; `elementId` is a clip id or `null`; the prompt is 1 to 4000 characters.
The request is stored as pending and sent to editing at once: when the video has no active job a `timelineEdit` job is queued; when one is active, the request waits and a new job is queued as soon as the video is free.
A job takes all pending requests of its video when it starts.
Before it starts the server writes for each request the full frame as a picture and, with a shape, a close-up of the area (`projects/<videoKey>/notes/<id>/`), and lists the clips at that frame from the top down.

The message to the agent names, per request: the time and frame, the area in words and numbers, the picture files, the clips there with their ids and files, the words spoken around that time, and the user's text.
Its fixed rules: change only what the request needs; keep ids; when the request concerns a motion graphic, re-create only that graphic's file with the earlier instructions plus the new text and keep its id, place and length unless the request says otherwise; never render a video file; check the project and write `[OUTPUT COMPLETED]`.

A request is `pending`, `running`, `done` or `failed`; a pending one can be deleted; a failed one can be sent again.
A failed request carries `error`: the failure sentence of its job ("The job failed." when the job has none), or "The edit was stopped before it made this change." when its job was stopped; `error` is `null` in every other state and is cleared when the request is sent again.
Anyone who can open the video can add a request, and it keeps who wrote it.
The frame must lie inside the video, the ellipse's centre inside the frame and its radii above 0 and at most 1, and `elementId` must be a clip of the project.
The clips at a frame are listed from the highest track down, sound last.
When the job ends the timeline reloads at the same frame.

Pictures and words of a request:

- All pictures of one job come from one `hyperframes snapshot` run of the project at the middle of each frame, so they show exactly what the preview shows; the run is outside every job's limits, is ended after 90 seconds plus 15 per frame (at most 10 minutes), and anything it leaves in the project folder is removed again.
- `frame.png` is the whole frame at 1280 on the long side, `closeup.png` (only with a shape) the area plus a margin of 15% at full density (never less than 10% of the frame per side, moved to stay inside the frame; long side 800 to 1600), and `frame-marked.png` the whole frame with the ellipse drawn on it.
- The prompt names them under `Pictures:` in this order, leaving out a picture that does not exist: `- Full frame: <frame.png>`, `- Full frame with my ellipse drawn on it (shows where the close-up sits): <frame-marked.png>`, `- Close-up of the area (read the detail from this one): <closeup.png>`.
- When the capture fails the request is sent without pictures and says so; a failure for one request does not take the others' pictures away. Pictures of an earlier attempt are deleted first, and a note's folder is deleted when its job ends.
- The words are those of `transcript.json` from 4 seconds before to 4 seconds after the frame, with the word at the frame marked as `[at this frame: word]`, or `[at this frame: silence]` in a pause; without a usable transcript the line is left out.

## 12. Rendering

`renderFinal(videoId, { resolution })` with `resolution` `1080` (default) or `2160` queues a `render` job; it is refused while the video has an active job or pending change requests, and when the profile check of the project fails.
The runner renders the project as it is when the job starts, with one `hyperframes render` of the whole project from the server's own pinned installation (HyperFrames 0.9.80):

- `hyperframes render <project> -o <file> --fps <the project's data-fps> --workers <n>`, H.264 with AAC in MP4, `--video-bitrate 12M` at 1080 and `--resolution` 4K with `--video-bitrate 40M` at 2160; the frame rate is always passed because the renderer's default is 30;
- `--start` and `--end` are never used: they prepare the whole timeline first and fail on videos longer than about 12 minutes (`PLAN_TOO_LARGE`);
- `<n>` is the job's CPU budget of section 9 when that is 4 or more (at most 8), otherwise 1 (one worker uses the faster capture path; two workers are slower than one);
- at 2160 `<n>` is at most 4: 4 workers take the same time as 8 (17.5 s against 20.1 s for 15 seconds, 98 s against 87 to 94 s for one minute) with about 40 percent less memory (10.7 GB against 17 to 18 GB for one minute with five 4K cuts), so the cap is a ceiling on top of the CPU limits of section 9 and never raises a smaller budget;
- `--gpu` (hardware encoding) is used while the job holds a GPU slot, which it takes for the whole render;
- the environment sets `HYPERFRAMES_NO_TELEMETRY=1`, `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_RENDER_LOCK=off` (the queue is VidAI's), `HYPERFRAMES_EXTRACT_CACHE_DIR` and `TMPDIR` inside `cache/render/<jobId>/`, `HF_DE_PARALLEL_STREAM=true` (several workers pipe their frames in order straight into the one H.264 encoder instead of writing them to disk first: same time and memory, about 3.6 GB less temporary disk per minute at 2160; should the encoder not start, HyperFrames falls back to frames on disk, so the disk rule below keeps the disk-path numbers), and the browser found by Prepare (`HYPERFRAMES_BROWSER_PATH`);
- the renderer stays a child of the server and is never detached: it ends itself when its parent goes away.

A render needs room: about 10 GB of temporary files and 4.5 GB of memory for 15 minutes at 1080 (measured: 2.6 times real time with 4 workers, every frame and every cut right, sound within a tenth of a millisecond).
At 2160 the same edit needs more: measured on a 60 second project with five 4K cuts, 87 to 94 s with 8 workers, 17 to 18 GB of memory and 4.5 to 4.8 GB of temporary files (about 1 minute of 1080 needs 12.3 GB of memory and 0.87 GB of temporary files), so a 15 minute edit at 2160 takes about 22 to 24 minutes, about 18 GB of memory at 8 workers and 30 to 75 GB of temporary files.
Nothing else renders at 2160: the preview copies (section 11) are at most 1280 on the long side, and the toolkit stays at 720 or 1080 (section 7).
The final file at 2160 is 3840x2160 with the exact frame count, H.264 High and AAC; `--gpu` works but gives no speed gain at 2160.
A render is refused with a sentence that names the resolution and the numbers when the disk that holds `cache/` has less free space than the render needs: at 1080, 1 GB per minute of video plus 5 GB; at 2160, 5 GB per minute of video plus 8 GB.
The sentence reads `There is not enough free disk space to render this video at 2160p: it needs 83.0 GB (5 GB for each minute of its 15:00 plus 8 GB) and only 12.3 GB are free. Free some space on the server and try again.`
A job waits for a GPU slot (Stop ends the wait) and renders without `--gpu` only when slots cannot be had at all.
At 2160 the renderer's own names are used (`--resolution landscape-4k` or `portrait-4k`, by the shape of the project).

After the renderer finishes, the server checks the file with ffprobe (it must have a picture, and its frame count must match the project's within one frame) and then levels the sound, because the project's sound is not levelled.
A first ffmpeg pass measures it (`loudnorm`, integrated -14 LUFS, true peak -1 dBTP, loudness range 11) and a second pass applies the measured values in linear mode; only the audio is encoded again (AAC, 320 kbit/s, 48 kHz), the video stream is copied unchanged and the file is written with fast start.
The second pass is skipped when the measured loudness is within 0.5 LU of -14 LUFS and the true peak is at most -1 dBTP.
A file without sound, or with silence only, is left as it is.
When measuring or levelling fails, the render fails: a file that was not levelled is never delivered.

It writes to `cache/render/<jobId>/` and, on success, moves the file to `<video>/output/<video folder name>_final_v<n>.mp4` with the smallest free `n`; an existing file is never overwritten.
A stop that arrives after the final file began to be saved comes too late, and the job completes.
`cache/render/<jobId>/` is deleted when the job ends in any way, and folders of jobs that are not running are deleted on start (a killed renderer leaves its work files and browser profiles behind).
Progress comes from the renderer's progress lines; the log shows its stages (compile, extract, audio, capture, encode, assemble).
The renderer never continues a broken render: starting again starts at the first frame.
A failure (exit code 1) shows a sentence made from the renderer's diagnostic code (`VIDEO_SOURCE_UNRENDERABLE`: "A source file is missing: ...", `SUB_TIMELINE_SCRIPT_FAILURE`: "The graphic ... has an error: ...") and otherwise its last lines.
A render can be stopped, not paused; a stopped or failed render can be started again.
Finals are played in the page and downloaded through `GET /api/file`.

Prepare (section 7) makes rendering work without the network: it installs the renderer's browser (`hyperframes browser ensure`) and renders a two second test project once, which also fills the renderer's font cache.

## 13. Disk Cleanup

`getDiskUse()` lists the user's videos with the size of their working files (`CLAUDE_VE`), project, finals and sources; sizes are measured in the background and cached per folder time.
It answers at once with what is known (`measuring` marks a video whose numbers are still being made) and the event `disk-use-changed` brings the rest to the owner.
Folders are measured one at a time, links are never followed and count nothing, and a file with several names is counted once; a cached size is checked again against the times and sizes of the folder's first levels, and measured afresh after 10 minutes at the latest.
`cleanWorkingFiles(videoId)` deletes everything inside `<video>/CLAUDE_VE/` and keeps the empty folder.
It is refused while the video has an active job, when `CLAUDE_VE` is a link or does not resolve inside the video folder, and when there is nothing to delete.
Deleting never follows a link (a link inside is removed, what it points at stays), goes on past a file that cannot be removed, and answers how much was freed and how many items are left.
An admin may clean anybody's video; the entry then lands in the owner's edit log with "(by an admin)".
The confirmation names the video and the size and says: "The timeline, the project and rendered videos stay. A later Re-Edit takes longer because working files are made again."
The edit log records "Disk Cleanup freed 12.3 GB".
Disk Cleanup is offered in a video's menu and as a page listing all of the user's videos by size.

## 14. HTTP API

| Route | Purpose |
|---|---|
| `POST /api/rpc/<name>` | every function below; JSON body and JSON answer |
| `GET /api/events` | Server-Sent Events for the signed-in user: `data: {"event": name, "payload": ...}`, a `hello` event with the server's instance id first (the page reloads when it changes), and after 15 seconds without any event the data event `ping` (payload `null`), which is not one of the events listed below; a page that receives nothing at all for 45 seconds treats the stream as lost and connects again |
| `PUT /api/upload/<id>`, `GET /api/upload/<id>` | upload bytes, ask how far an upload got |
| `GET /api/file?video=<id>&path=<relative>` | a file of the user's video folder with Range (thumbnails, finals, `download=1` for a download) |
| `GET /p/<token>/<path>` | the project preview (section 11) |
| `GET /setup` and everything else | the UI (`dist/`), `index.html` for unknown paths |

RPC functions (`admin*` need the admin role):

- Account: `getSession`, `login`, `logout`, `changePassword`, `setupAdmin`.
- Admin: `adminListUsers`, `adminCreateUser`, `adminUpdateUser`, `adminDeleteUser`, `adminListChannels`, `adminCreateChannel`, `adminUpdateChannel`, `adminRemoveChannel`, `adminGetSettings`, `adminUpdateSettings`, `adminGetHarness`, `adminSetSetup`, `adminSetApiBaseUrl`, `adminSetApiKey`, `adminClearApiKey`, `adminSetApiModel`, `adminSetApiEffort`, `adminSetModelSelection`, `adminGetApiModels`, `adminTestApi`, `adminGetSystem`, `adminPrepareToolkit`, `adminGetQueue`, `adminSetJobUrgent`, `adminStartJobNow`.
- Workspace: `getWorkspace` (the user's channels, public settings, readiness), `getHarness` (the setup, program, model and effort in use, read-only), `getReadiness`, `getOpencodeUsage`, `updateChannel`, `reorderChannels`, `getDefaultPrompt`, `exportChannels`, `importChannels`.
- Library: `getLibrary`, `setVideoTypeOverride`, `getVideoInputs`, `setVideoInputs`, `archiveVideo`, `unarchiveVideo`, `getArchived`, `getEditLog`.
- Jobs: `startEdit`, `reEdit`, `pauseJob`, `continueJob`, `stopJob`, `getJobLog`, `getQueue`, `getUsage`.
- Timeline: `openTimeline`, `getTimeline`, `editTimeline`, `undoTimeline`, `redoTimeline`, `listRevisions`, `restoreRevision`, `addTimelineNote`, `deleteTimelineNote`, `retryTimelineNote`, `renderFinal`.
- Storage: `fsPlaces`, `fsList`, `fsCreateFolder` (admin only), `listUploads`, `createUpload`, `cancelUpload`.
- Disk: `getDiskUse`, `cleanWorkingFiles`.

Events: `library-changed`, `workspace-changed`, `job-updated`, `job-log`, `queue-changed`, `settings-changed`, `timeline-changed`, `note-updated`, `preview-copies-changed`, `usage-updated`, `system-changed`, `disk-use-changed`, `session-ended`.
`getEditLog({ before, limit })` returns the signed-in user's entries newest first in pages (100 by default, at most 500); an admin may ask for one user's or everybody's.
The words of a job's entries: "Started (Claude Code)" for an edit, "Re-Edit started (Claude Code)" and "Change request started (Claude Code)" (with "OpenCode 2" when that program does the job), "Finished (Claude Code)", "Needs attention: <reason>", "Stopped", "Paused" and "Continued"; a render names no program: "Render started" and "Render finished".
A job's closing entry is written before the job's new state is announced (`job-updated`), so a page that reloads the log on that event always finds it.
An event goes only to the sessions of the user it concerns, with these exceptions.
`queue-changed` carries only the queue's name (`{ queue }`) and goes to everybody, who then ask for their own view (`getQueue`, or `adminGetQueue` for an admin).
`job-updated` also goes to the admins for everybody's jobs.
`settings-changed` and `usage-updated` go to everybody, `system-changed` to the admins only.
`job-log`, `timeline-changed`, `note-updated`, `preview-copies-changed`, `disk-use-changed` and `library-changed` go to the owner only.

## 15. Data model

Tables (ids are random 16 byte hex strings unless stated; times are milliseconds since 1970):

- `users`: id, email, password_hash, role, disabled, may_mark_urgent, created_at, updated_at, last_seen_at.
- `sessions`: id, token_hash, user_id, created_at, last_used_at, address, user_agent.
- `settings`: key, value (JSON); one row per admin setting.
- `secrets`: name, nonce, cipher, last4.
- `channels`: id, user_id, name, dir (real path, unique), video_type, profiles (JSON), position, created_at.
- `videos`: id (the video key, random), channel_id, folder_name (unique per channel), type_override, inputs (JSON: product links, notes, prompt slot, style slot), session_id, session_harness, archived_at, progress_memory (JSON), created_at; a row is made the first time something must be remembered about a folder.
- `jobs`: id, video_id, user_id, kind, queue, state, urgent, joined_at, started_at, ended_at, setup, harness, model, effort, request (JSON), progress (JSON), error (JSON), retries; a partial unique index allows only one active job per video.
- `notes`: id, video_id, user_id, frame, shape (JSON), element_id, prompt, state, job_id, created_at.
- `revisions`: video_id, n, label, user_id (or null for a job), job_id, created_at, undone.
- `uploads`: id, user_id, channel_id, video_id (null for an upload into the channel's folder), name, size, received, created_at, touched_at.
- `edit_log`: id, at, user_id (emptied when the user is deleted), user_email, video_label, event, message (the newest 20000 kept).
- `progress_history`: kind, video_type, seconds, finished_at.
- `launches`: queue, at (for the start delay).

Job logs are files (`logs/<jobId>.jsonl`), not rows.

## 16. User interface

The main screens are: the sidebar with the user's channels, the video list with its rows and actions, the activity panel with the job log and outputs, the Start Editing, Re-Edit and Stop sheets, channel settings with prompt and style slots, history (archive, edit log), the admin's folder picker.
Theme and text size are kept per browser (local storage), not on the server.

Also:

- Sign in page; first-admin setup page; account menu (email, change password, sign out).
- Upload Files, on a video's menu and on a channel's menu in the sidebar: a dialog that names the folder (`upload` of that video or channel), lists the files already in it, and takes files from Choose Files or by dropping them, each with progress, pause, resume and cancel.
- Channel settings (the user): the video type, prompts and styles of each channel and the order of the channels; no New Channel, no rename, no remove; without channels the page says "No channels yet. An admin adds channels for you."
- Start Editing and Re-Edit: the Urgent checkbox with the hint "Starts before the other waiting videos, after those already being edited and earlier urgent ones."
- A waiting video shows its position; the sidebar status shows the server's readiness and how many edits run and wait.
- Timeline screen (section 11): player with play, pause, frame steps, time code, speed, volume, full screen; tracks with zoom, a ruler, a playhead, selection, drag to trim and move with snapping, Delete, Split, Undo, Redo, revisions; "Ask for a change" (draw the ellipse, type, Send); the list of change requests with their state, each jumping to its frame; Render Final with its progress and the finished videos.
- Disk Cleanup page and menu entry (section 13).
- Edit log: an admin chooses "Whose edits" (My edits, Everybody, or one user); the email column shows when other users' entries are listed; the choice stays for Refresh and older entries and is reset at sign-out.
- Queues and Limits: a per-edit CPU or GPU value above its total shows "Limited by the total: an edit gets at most N%." beside the field.
- Admin section: Users, Channels, Harness and Model, Queues and Limits, Storage (the upload size and the preview cache), Queue (all jobs), System.
- Admin Channels page: every channel with its name, owner, folder, number of videos and whether it can be reached; New Channel, Edit and Remove; the channel dialog has the name, the owner, the video type and the folder, chosen with the folder picker over the whole server (with New Folder).

The page fills the browser tab and its title is `VidAI`; the platform (fonts, wording, shortcut keys) is the one of the browser's operating system (`src/lib/platform.ts`).
The layout never gets less than 980 x 620 CSS px (`MIN_LAYOUT_SIZE` in `src/app/appearance.ts`).
A browser window smaller than that does not squeeze the layout: the page scrolls in both directions as needed, on the app's own background.
Dialogs, sheets, the file picker, toasts, menus and the "VidAI is not running" notice are fixed to the visible browser window, so they stay fully visible whatever the scroll position.
Text size is applied by the page itself as CSS `zoom` on the root element.
Cmd/Ctrl with `=`, `+`, `-` and `0` are left to the browser's own zoom; the other shortcuts work where the browser lets a page have the key.
Hints and tooltips leave out a shortcut the browser keeps for itself (`PlatformInfo.offersShortcut`: the zoom keys, and Cmd+`,` on a Mac).
The page also sets `--page-zoom` on the root element: popups (menus, selects, tooltips) are positioned with it so they stay at their anchor, and the size limits of dialogs, sheets and toasts divide the viewport by it so they fit a small browser window.
Under the zoom Chromium reports pointer positions and rectangles in screen px while styles and sizes are layout px, so code that moves or sizes something by a pointer distance or a measured rectangle converts with `src/lib/zoom.ts` (`screenPerLayout`, `toLayoutPx`); the scrollbars of `ScrollArea` undo the zoom for the same reason.
The library rescans when the tab becomes visible or gets focus.
When the event stream breaks, a full-page notice says that VidAI is not running and how to start it, and the page keeps trying to reconnect; when the stream is back the page reloads, so it never shows stale state (the same happens when the instance id of `hello` changes).
Closing the tab changes nothing: edits keep running on the server, and opening the address again shows their current state.
Several tabs may be open at once; all get every event.

## 17. Quality bar

- `npm run check` runs everything: Prettier, ESLint (UI and server, zero warnings), TypeScript (UI, and the server's JavaScript with `checkJs`), UI tests (`vitest`), server tests (`node --test`), toolkit tests (`python -m unittest`).
- Engine tests drive the real job engine against the fake agent programs in `server/test/support/` (`fake-claude.sh`, `fake-opencode2.py`, `fake-hyperframes.mjs`) with shortened timers.
- `npm run e2e:server` (`scripts/e2e-server/`) starts the real server with a temporary data directory and the fake programs and drives it in Chromium: sign in, admin pages, channels, upload, start, queue order with Urgent, pause, continue, stop, timeline play, hand edits, change request, render, Disk Cleanup, two users at once.
  The first scenario, `smoke`, covers sign in, the admin making a user and a channel for that user in a folder on the server, an upload into a video's `upload` folder and one into a channel's, an edit with the fake Claude Code, the timeline and a real final render; the others are still to be written.
- Every rule of section 4 that keeps users apart has a test that tries to cross it.
- Windows code paths (`server/src/platform/`) are written and unit tested where they can be on a Mac; what could not be run on a real Windows machine is listed in the README.

## 18. Open points

These are decided by measurement and then written into the sections above:

- 2160 renders and extracted frames: an earlier measurement of 13.6 GB of extracted frames for one minute at 2160 from 4K footage was not reproduced (JPEG extraction on a 60 second project with five 4K cuts used 4.5 to 4.8 GB of temporary files); PNG extraction of real 4K footage could still reach it, so measure a real full-length edit with PNG frames before the disk rule of section 12 is relied on without a margin, and consider `--video-frame-format jpg` at 2160 if it does;
- several 2160 renders at once can exceed the memory of a 32 GB server (one is 10.7 GB at 4 workers for one minute and more for a long edit); whether a 2160 render counts as two render slots or is held to a memory budget is not decided;
- a render with the network really blocked (so far only shown with warm caches).

Measured and settled (HyperFrames 0.9.80):

- a browser plays 250 A-roll clips of one project as separate elements without stalls at the cuts, given the player element's lazy loading (section 11); preview copies seek in about 30 ms against 300 ms for camera originals;
- motion graphic hosts could share one composition file, but every graphic keeps its own file so that re-creating one graphic can never change another (section 10, rule 8);
- a full-length edit is rendered by one `hyperframes render` (15 minutes, 250 cuts, 22500 frames: all right); rendering in parts and joining them gave sound that was not gapless and a doubled first frame, and ffmpeg alone was not frame exact, so neither is used (section 12);
- the preview works inside a page without an origin, with the headers of section 11 exactly as written: the player loads, the message bridge carries play, pause, seek and state both ways, and a script inside a project can read neither VidAI's cookie nor its API nor the network, also when the address is opened in its own tab (checked in headless Chromium; Safari and Firefox are not checked);
- rational frame rates such as 24000/1001 render natively when `data-fps` and `--fps` agree and times carry 9 decimals (section 10, rule 3).

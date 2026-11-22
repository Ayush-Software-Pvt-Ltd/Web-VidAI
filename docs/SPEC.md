# VidAI Server - Product and Engineering Spec

This file is the contract for VidAI Server, the multi-user web app.
If code and this file disagree, fix one of them in the same change.
The desktop apps and the single-user web version are retired; their contract is kept as `docs/SPEC-desktop.md` only as the reference for the rules that are carried over (each place below names the section), and is deleted together with the old code.
Never use the em dash character anywhere in the repository.

## 1. Product

VidAI Server runs on one Windows or Mac computer in the office.
Everybody in the office opens it in a browser over the intranet and signs in with an email and a password.
A user starts AI video edits of their own videos, follows them, reviews the result on a timeline in the browser, asks for changes on the timeline, and finally asks for the rendered video.
Each edit is done by a locally installed coding agent (Claude Code or OpenCode 2) that runs headless on the server inside the video's folder and uses the editing toolkit.

Decisions of the product owner (2026-11-22), all settled:

1. The server is Node.js in plain JavaScript (ES modules, no TypeScript, no build step, no Rust, no Tauri) with SQLite for accounts, queues and all management data.
2. The browser UI stays React + TypeScript and keeps the existing screens where they still apply.
3. Accounts are created only by an admin, with an email and a password.
4. The admin chooses the harness (the setup, which decides Claude Code or OpenCode 2), the API details and the model for everybody.
5. Every user has several channels; a channel is a directory with one folder per video, its own prompts and styles; a user sees only their own channels and videos.
6. Video files arrive both ways: they already lie in a folder the server can reach (its own disk or a network share), or the user uploads them in the browser.
7. The result of an edit is a HyperFrames project, not a Final Cut Pro or Premiere Pro file.
8. Review happens on a timeline in the browser: play, scrub, edit by hand (trim, move, delete, split) and ask for changes by circling an area of a frame and typing what to change.
9. A change asked for on the timeline is sent to editing at once and only that part is changed; a motion graphic is re-created on its own and replaced in place.
10. The final video is rendered only when the user explicitly asks for it.
11. Three separate queues exist: edits, timeline changes, renders, each with its own limit set by the admin (renders default 1).
12. A user can mark an edit Urgent when starting it.
13. The admin sets the maximum CPU and GPU share (5 to 100 percent in steps of 5) for one edit and for all edits together; the GPU share is approximate.
14. Users can free disk space with Disk Cleanup, which deletes the files in a video's `CLAUDE_VE` folder.
15. The server always speaks HTTPS and makes its own certificate on the first start.
16. The server starts with an empty database; nothing is imported from the desktop app.

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
| `media/` | the default storage folder (section 6) |
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
| `server/src/storage/` | storage folders, path safety, folder browsing, uploads, file serving with Range |
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
| `scripts/e2e/` | end-to-end suite (real server, fake agents, Chromium) |

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

The four setups, their programs, addresses, optional keys, model lists, test requests, readiness rules and the OpenCode 2 details are carried over from `docs/SPEC-desktop.md` section 7a and section 6 "Readiness of a launch", with these changes:

- the setup, API address, key, model and efforts are admin settings for everybody; users see the active setup and model read-only;
- API keys are stored in the database encrypted with AES-256-GCM under `secret.key`; the UI only ever gets "saved" plus the last 4 characters; keys are scrubbed from logs as before;
- the Claude subscription login is the login of the OS user that runs the server; the System page tells the admin to run `claude` once in a terminal on the server and shows the login state;
- when the installed Claude Code's model list changes, the saved model and effort are checked again: a model that is gone becomes Claude Code's default (`null`), an effort the model does not support becomes `null`, and a changed choice is saved and announced with `settings-changed` and `system-changed`;
- there is one decision for "can new edits start", `readiness.problem(facts)`, used by Start Editing, the status line and the System page; `server/test/support/fixtures/readiness-table.json` is run by the server tests and the UI tests;
- `gitBashMissing` applies when the server runs on Windows with a Claude Code setup; `notPrepared` means the toolkit environment of section 7 is not ready.

A job keeps the setup, program and model it started with, also for Continue, Re-Edit and timeline changes (section 8).

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

`storageRoots`: the folders on the server (or on shares it has mounted) inside which users may place channels; the default storage folder `<data dir>/media` is always one of them and can never be removed.
A change that drops a folder in which channels lie is refused (`conflict`), comparing real paths (a folder of a share that cannot be reached counts by its written path): "1 channel of 1 user is in <folder>. Move or remove it first." or "3 channels of 2 users are in <folder>. Move or remove them first.".
`maxUploadGb` (1 to 2000, default 200): the largest single file a user may upload.
`proxyCacheGb` (1 to 2000, default 50): the size at which the oldest preview copies are deleted.

### System page

Shows, each with a state and a hint how to fix it: Claude Code (path, version, login), OpenCode 2 (path, version), ffmpeg and ffprobe (path, version, hardware encoders found), Python (path, version), toolkit environment, HyperFrames (version) and its browser, speech model, free disk space of the data directory and each storage folder, the addresses of the server, the certificate (names, end date, SHA-256 fingerprint).
"Prepare" runs the toolkit preparation of section 7 and shows its log.

## 6. Storage, channels and videos

### Storage folders and path safety

Every path a user gives is resolved to its real path (links followed) and must lie inside a storage folder; otherwise `forbidden`.
A channel directory must be a directory, must not be a storage folder itself, must not lie inside the data directory except under `media/`, and must not be the same as, inside, or around a channel directory of any user (`conflict`: "This folder already belongs to a channel.").
The in-page folder picker (`fsPlaces`, `fsList`, `fsCreateFolder`) only shows storage folders and what is inside them; hidden entries (leading dot) are not listed.
Each user has a personal folder `<data dir>/media/<user id>/`, created on demand, offered as the first place.
VidAI never deletes or overwrites a file in a channel directory, with exactly two exceptions: Disk Cleanup (section 13) and its own files inside `<video>/output/<video>.hf/` (section 10).

### Channels

A channel belongs to one user and has a name (1 to 60 characters, unique for that user), a directory, a video type (`auto`, `long`, `short`) and two profiles (Long and Short), each with exactly 5 prompt slots and 5 style slots.
Slot rules, names and the default prompt are carried over from `docs/SPEC-desktop.md` section 4 (channels) with the default prompt now read from `toolkit/default_prompt.md`.
Creating a channel either makes a new folder (in the personal folder or a chosen place) or links an existing one.
Removing a channel removes only the row and its videos' rows (with their jobs, change requests, revisions and unfinished uploads, whose partial files are deleted) and the server's own folder of each of those videos (`<data dir>/projects/<videoKey>/`); the channel directory and everything in it stay, and so do the edit log's entries.
Deleting a user removes those folders of all the user's videos the same way, and at start the server removes every folder under `<data dir>/projects/` that belongs to no video (logged with the count).
While a job of one of its videos waits, runs or is paused the removal is refused (`conflict`): "Stop the running edits of this channel's videos first.".
Channels can be reordered; the order is per user.

### Videos

A video is a folder directly inside a channel directory.
Its id is `<channelId>/<folder name>`.
Reserved names, A-roll detection (largest video file directly in the folder), the B-roll folder, natural sorting and `createdAt` are carried over from `docs/SPEC-desktop.md` section 2.
`createVideo(channelId, name)` makes a new folder (name 1 to 120 characters, no path separators, not reserved, not existing).

Outputs of a video, found in `<video>/output/`:

- project: `output/<video folder name>.hf/index.html` (section 10); a video has at most one project;
- finals: `*.mp4`, `*.mov`, `*.m4v` directly in `output/`;
- thumbnails `thumbnail-*.png|jpg|jpeg` and `meta.txt`, and `info.txt` in the video folder, as before.

Long or Short comes from the A-roll's display size (container metadata through ffprobe, rotation included); the effective type order is: video override, channel setting, detected, assumed Long (`docs/SPEC-desktop.md` section 8, "Effective type").
The face-based picture check of the desktop app is not carried over.

The library is rescanned after job events, uploads and channel changes, and every 5 seconds for users with an open event stream; `library-changed` goes only to the owner and only when their result differs.

### Uploads

A user uploads files into a video folder or its B-roll folder (created as `Broll` when missing).
Allowed: video (`mp4 mov m4v mkv mts m2ts avi webm`), audio (`wav mp3 m4a aac flac`), pictures (`png jpg jpeg webp gif`), text (`txt md srt`).
`createUpload({ videoId, folder: "video" | "broll", name, size })` checks the name (no separators, no leading dot, allowed extension), the size (`maxUploadGb`, free disk space plus 1 GB) and that no file of that name exists, and returns an upload id.
The browser then sends the bytes in order with `PUT /api/upload/<id>?offset=<n>` (raw body, at most 32 MB per request); the server appends only when `offset` equals what it already has and answers with the new offset, so a broken upload continues from `GET /api/upload/<id>`.
Bytes are written to `.<name>.<id>.part` in the target folder (hidden from the scanner); when the last byte arrives the file is renamed to its name, failing with `conflict` if the name was taken meanwhile.
`cancelUpload(id)` deletes the part file; part files untouched for 24 hours are deleted on start and hourly.
A video with an upload in progress does not offer Start Editing.

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

- The steps, in order: Python (3.10 to 3.13, found by running it; the Python that comes with macOS is not used), `venv/`, the packages, ffmpeg and ffprobe, the toolkit's own check (`ve.py doctor`), the speech model, the renderer's browser, the test render. A failed step stops the later ones; the results are kept in `toolkit/prepare.json` and shown after a restart.
- Edits can start when the toolkit is installed and the steps up to the speech model are done; Render Final also needs the browser and the test render.
- Whether Prepare is needed is read from the disk: the environment's Python is missing, the packages were never installed, or `requirements.txt` differs from the one last installed. A toolkit upgrade with the same requirements keeps the environment.
- Prepare starts by itself at every server start while edits could not start otherwise; only one runs at a time, and edits cannot start while it runs.
- A crash during an upgrade leaves a usable toolkit: the next start puts the old programs back or finishes the swap. `VERSION` is written last. A failed install is shown on the System page and never stops the server.
- The copy never contains the toolkit's tests or Python cache folders.

The toolkit is portable: it runs on Apple Silicon and Intel Macs and on Windows.
Speech recognition uses `mlx-whisper` on Apple Silicon and `faster-whisper` elsewhere; hardware video encoders are chosen from what ffmpeg offers on the machine (VideoToolbox, NVENC, Quick Sync, AMF) with a software fallback.
The toolkit takes the video folder as an absolute path; nothing in it depends on where the toolkit lies.
Each video's working files are in `<video>/CLAUDE_VE/`; everything there can be rebuilt, and nothing the project needs to play or render lies there (section 10).
The toolkit obeys the resource limits of section 9 through `vekit/resources.py`.
It writes only inside `<video>/CLAUDE_VE/`, `<video>/output/` and `<video>/info.txt`, never into its own folder; jobs run with `PYTHONDONTWRITEBYTECODE=1`.
Paths it stores (`timeline.json`, `recon.json`) are relative to the video folder, so a moved video folder keeps working.
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
The state machine, "one session per video", the setup of a job and its fallback, how Claude Code and OpenCode 2 are driven, keeping a job going, retrying after a model error, error texts and the log format are carried over from `docs/SPEC-desktop.md` section 6 and section 7a, with these changes:

- the agent's working directory is the video folder; the prompt gives the video folder, the channel directory and the toolkit folder as absolute paths;
- sessions are remembered per video in the database; a session is resumed only by the program that created it;
- "review file" becomes "the project", "review saved" becomes the milestone `project_saved`;
- the completion marker stays `[OUTPUT COMPLETED]`; after it the server runs the profile check (section 10): when it fails the agent is told the errors and asked to fix them (at most twice), then the job fails with "The project has errors: ..." and, for `reEdit` and `timelineEdit`, the project is put back to the revision from before the job;
- before every agent job that can change an existing project, a revision is saved (section 11); the `backup-output-N` copy of the desktop app is not carried over;
- Render Final no longer talks to the agent;
- the machine paragraph that asked the agent to adapt a Mac-only toolkit is gone; the prompt names the machine (OS, CPU, memory, GPU) in one line;
- the cooperative `cpu.lock` and `gpu.lock` files are replaced by section 9.

Which actions a video offers is computed by the server (`VideoView.actions`): `startEdit`, `pause`, `continue`, `stop`, `reEdit`, `review` (open the timeline; offered when a project exists), `renderFinal` (a project exists and no job is active), `upload`, `diskCleanup` (no job is active and `CLAUDE_VE` holds files), `archive`, `unarchive`, `startNow` (admin only, a queued edit held only by the start delay).

### The edit queue

- Slots: `maxEdits`; running, pausing and stopping jobs hold a slot; paused and queued jobs do not.
- The line of waiting jobs is ordered: Urgent jobs first, in the order they joined the line; then the others, in the order they joined.
- So an Urgent job is behind the running ones and behind earlier Urgent ones, and ahead of everything else.
- "Joined the line" is the time of Start Editing or Re-Edit; a paused job that is continued gets its old place back (its original time).
- When a slot is free the first job in the line starts, skipping jobs of a user who already has `maxEditsPerUser` edits running (when that limit is set).
- `startDelayMinutes` is kept between two launches of new sessions in this queue (a Continue that resumes a session is not a launch); `startNow` skips it for one job.
  The delay does not hold a job while nothing in the queue holds a slot, and the time of the last launch is kept in the database, so it survives a restart.
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
Process trees left over from a crashed server are ended (the registry of started processes is carried over from `docs/SPEC-desktop.md` section 6 and section 11 "Process trees").

### Prompt

The first message of an edit is composed as in `docs/SPEC-desktop.md` section 6 "Prompt composition", with these differences.
The parts, in order, are separated by blank lines: the header, `PRODUCT_LINKS =` (and the PRODUCT_LINKS STEP when there is a link), `NOTES FOR THIS VIDEO:` (when not empty), the channel prompt of the video type and slot exactly as written, `CHANNEL_STYLE (<Long 16:9 | Short 9:16>):`, the "VidAI:" paragraph, the OpenCode 2 block (program OpenCode 2 only), the keep-working paragraph (every setup except `claudeSubscription`), and the progress markers of the kind (milestones below).
The header has one line each, in this order: `MAIN_FOLDER` (the video folder, also the agent's working directory), `CHANNEL_FOLDER`, `TOOLKIT_FOLDER` (`<data dir>/toolkit/CLAUDE_VE_ALL`), `PYTHON` (the toolkit's Python), `Channel Name`, `VIDEO_TYPE` (Long or Short), `BROLL_FOLDER`, `PROJECT_FOLDER` (`<video>/output/<video folder name>.hf`), `CHECK_COMMAND`, `MACHINE:` and `LIMITS:`.
All paths are absolute.
`CHECK_COMMAND` runs the server's own check of section 10 on the project (`server/src/timeline/checkCli.js` with the server's Node.js and the project folder); it prints each error on its own line and ends with code 1 when there is one.
`MACHINE:` names the operating system and version, the processor model and its logical processors, the memory and the graphics adapter; a part that cannot be found is left out.
`LIMITS:` says in words how many processor cores and GPU tasks the job may use (section 9) and that the toolkit already obeys it.
The "VidAI:" paragraph says: nobody can answer; the toolkit is called as `"<PYTHON>" "<TOOLKIT_FOLDER>/ve.py" <command> "<MAIN_FOLDER>"`, and `CLAUDE.md` and `MEMORY.md` next to `TOOLKIT_FOLDER` are read first; the style rule; the result is the project of section 10 in `PROJECT_FOLDER`, written by `ve.py hf`, which must pass `CHECK_COMMAND`; originals are linked, never copied or changed; every motion graphic is its own file in `compositions/`; the agent never renders a video file of the edit; and the agent ends with `[OUTPUT COMPLETED]`.
A start is refused with `invalidInput` when the selected prompt of the channel for the video's type is empty or a slot is outside 0 to 4.
Follow-up messages: Continue as before, naming the project and `CHECK_COMMAND` instead of a review file; Re-Edit as before with "update the project in PROJECT_FOLDER"; timeline changes as in section 11 (per request: number, time as `m:ss.mmm` and seconds, frame, area in words and pixels, picture files, clips under the frame from the top down, words spoken around that time, the user's text; then the fixed rules; when two requests conflict the later one wins).
When a session cannot be resumed, the new session gets the full first message, a paragraph about the earlier work and then the follow-up.
After `[OUTPUT COMPLETED]` the server checks the project; when it fails, the agent gets the errors and is asked to fix them and write the marker again, at most twice.
The fixed texts are in `server/src/jobs/promptTexts.js`.

### Progress

The progress engine (never backwards, 99 until done, evidence tiers, typical times) is carried over from `docs/SPEC-desktop.md` section 6 "Progress".
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
Work that runs in software only (a software encode, speech recognition on the CPU) takes no slot.
The slots are files, so that programs in any language can take part:

- `<data dir>/locks/gpu/limits.json` is `{ "total": n, "perJob": n }`, rewritten by the server (write to a temporary name, then rename) whenever the settings change; a program reads it every time it wants a slot, and takes a missing or damaged file as one slot in all and one per job.
- A slot is the file `slot-<i>` with `i` from 0 to `total - 1`, created with exclusive create and holding `{ "jobId", "pid", "at" }`; the first name that can be created is the slot taken, and when none is free the program waits and tries again every second.
- The holder sets the file's modified time every 60 seconds; a slot not renewed for 15 minutes, or whose process no longer runs, may be taken over by renaming it to a unique name first (`slot-<i>.gone-<unique>`) and deleting that (so two programs never both believe they freed it); only names that are exactly `slot-<number>` count as slots.
- A job's programs get `VE_GPU_SLOTS_DIR` and `VE_JOB_ID`; a program that does not find them runs without asking (the toolkit used by hand).

The server removes slots held by processes of ended jobs, slots with a number at or above `total`, and leftover `slot-<i>.<anything>` names.
At 5 percent everything that uses the GPU runs one task at a time.

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
10. Every `src` and every file reference is a relative path inside the project without `..`; nothing is loaded from the network.
11. The agent never renders a video file of the edit (this one cannot be read from the files; the prompt says it).

A B-roll clip that moves (a slow push, pull or drift) is a host like a motion graphic: `data-vidai-kind="broll"` on track 1, with the video and its one movement inside `compositions/<id>.html`.
That file has one fixed shape, written the same by the toolkit and by the server: the element `#<id>-motion` carries `data-vidai-motion='{"scale":[from,to],"x":[from,to],"duration":<seconds>}'`, the `<video>` inside it carries `data-media-start` (the in-point) and `data-duration` (as long as the source allows, at most 600 seconds past the host), and the file's script reads the attribute and runs one linear movement over the host's length.
A hand edit of such a clip rewrites only attribute values in that file; a host whose file has another shape (written by an agent, or by toolkit 1.2.0) is treated as a graphic.

Loudness of a clip is its `data-volume`.
Fades are the clip's `data-fade-in` and `data-fade-out` (seconds, linear), set by one rule that the toolkit and the server share (`server/test/support/fixtures/fade-rule.json` is run by both):

- 8 milliseconds out and in at every cut between different sources, and 8 milliseconds in at the start of the first clip, so a cut never clicks;
- nothing at a cut that continues the same source, and nothing inside a clip;
- the last clip fades out as long as the end fade picture (the `fade` clip), at most its own length, and 8 milliseconds without one;
- a clip shorter than 32 milliseconds or without sound has none.

After every hand edit the server sets the fades of the A-roll again by this rule; a project whose A-roll carries no fades at all is left as it is, and any other `data-automation` lane (ducking, for example) is never touched.

Times are read with a tolerance of a hundredth of a frame and written within a billionth of a second of the exact frame time; frame rates are kept as exact fractions (`30`, `29.97` and `30000/1001` are all accepted in `data-fps`).
`edit.json` is `{ toolkitVersion, fps, width, height, sources: [{ name, path, originalPath, frames, fps }], graphics: [{ id, template, variables, label }] }`, where a source's `path` is the `src` its clips use and its `frames` and `fps` are the file's own.

`server/src/timeline/profile.js` checks rules 1 to 10 and returns each violation as a sentence that names the element; `hyperframes lint` must also report no errors (its warnings do not count, and a lint that cannot run is logged and is not an error of the project).
`server/src/timeline/checkCli.js <project folder>` is the same check as a command for the agent: it ends with 0 when the project is fine, 1 with one error per line, 2 for a wrong call.
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
Renders always use the originals.

- A file is also heavy when it is H.264 with 10 bits or not 4:2:0, is HDR (PQ or HLG), is interlaced, or is stored rotated; key frames are measured over the first 10 seconds, whose end counts as one.
- The copy is 8-bit SDR 4:2:0 with the rotation applied and both sides even; HDR is tone-mapped when the installed ffmpeg can (`zscale` and `tonemap`), otherwise only converted.
- The encoder is the computer's hardware H.264 encoder when one works (VideoToolbox on a Mac; NVENC, Quick Sync or AMF on Windows; each is tried once with two tiny frames; `VE_HW` forces one or none) and a GPU slot is free within 100 ms, otherwise libx264; a failed hardware attempt is repeated once in software. A copy counts against the CPU and GPU limits of section 9 like any other work.
- A copy is written as `.part` and renamed when complete; leftover `.part` files are deleted at start. A file whose copy failed is not tried again until the file changes or the server restarts.
- `openTimeline` returns `previewCopies` (`{ total, done, running }`) and the event `preview-copies-changed` (`{ videoId, copies }`) brings each change to the owner.
- A file used by several videos is copied once. Copies not used for the longest time are deleted when the cache passes its size limit (checked at start, daily, and at once when an admin lowers the limit `proxyCacheGb`, where 1 GB is 1024^3 bytes); removing or archiving a video cancels its waiting copies.

### Timeline data

`getTimeline(videoId)` returns the revision number, frame rate, size, duration in frames, the tracks with their clips (id, kind, label, start and duration in frames, track, and for media the source name, in-point and source length in frames, for graphics the file), the change requests, whether undo and redo are possible, and `locked` (`null` or the job that holds the project).
All times on the wire are whole frames.
The project is locked while a job of the video is active; a locked timeline plays and accepts change requests but no hand edits.

### Hand edits

`editTimeline(videoId, revision, op)` applies one operation to `index.html`, checks the profile, saves a revision and returns the new timeline; a stale `revision` or a locked project answers `conflict`.
Edits change only attributes of clip elements (and remove or add clip elements); the rest of the file is kept byte for byte.

| Operation | A-roll clip | Other clips |
|---|---|---|
| `trim` (an edge to a frame) | the video gets shorter or longer by the change and everything after the edit point shifts (ripple); limited by the source file and a minimum of 2 frames | the edge moves; limited by the neighbours on its track, the source file (media), the end of the video and a minimum of 2 frames |
| `delete` | the clip is removed and everything after it shifts earlier | the clip is removed |
| `split` (at a frame inside the clip) | two clips, the second continuing in the source | two clips; a graphic cannot be split |
| `move` | the clip is taken out and inserted at another cut (reorder); clips of other tracks that start inside it move with it | the clip moves in time on its track, limited by its neighbours and the ends of the video |

Ripple rule for other tracks: a clip that starts after the removed or inserted part shifts by its length; a clip that starts inside a removed part now starts at the cut point; a clip that would end after the end of the video is shortened to fit, and removed if less than 2 frames remain.
The end fade picture is the exception: it always stays at the end of the video with its length (at most the video's), whatever is trimmed, deleted or inserted before it.
A B-roll with motion (section 10) is edited like any other B-roll: trimming is limited by its source file, trimming its first edge moves where it begins in the source, the movement always runs over the clip's new length, and a split gives each part its piece of the movement, the two meeting at the cut (the second part gets its own file `compositions/<id>-2.html`).
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
- the environment sets `HYPERFRAMES_NO_TELEMETRY=1`, `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_RENDER_LOCK=off` (the queue is VidAI's), `HYPERFRAMES_EXTRACT_CACHE_DIR` and `TMPDIR` inside `cache/render/<jobId>/`, and the browser found by Prepare (`HYPERFRAMES_BROWSER_PATH`);
- the renderer stays a child of the server and is never detached: it ends itself when its parent goes away.

A render needs room: about 10 GB of temporary files and 4.5 GB of memory for 15 minutes at 1080 (measured: 2.6 times real time with 4 workers, every frame and every cut right, sound within a tenth of a millisecond).
At 2160 the same edit needs more: measured on a 60 second project with five 4K cuts, 87 to 94 s with 8 workers, 17 to 18 GB of memory and 4.5 to 4.8 GB of temporary files (about 1 minute of 1080 needs 12.3 GB of memory and 0.87 GB of temporary files), so a 15 minute edit at 2160 takes about 22 to 24 minutes, about 18 GB of memory at 8 workers and 30 to 75 GB of temporary files.
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
- Admin: `adminListUsers`, `adminCreateUser`, `adminUpdateUser`, `adminDeleteUser`, `adminGetSettings`, `adminUpdateSettings`, `adminGetHarness`, `adminSetSetup`, `adminSetApiBaseUrl`, `adminSetApiKey`, `adminClearApiKey`, `adminSetApiModel`, `adminSetApiEffort`, `adminSetModelSelection`, `adminGetApiModels`, `adminTestApi`, `adminGetSystem`, `adminPrepareToolkit`, `adminGetQueue`, `adminSetJobUrgent`, `adminStartJobNow`.
- Workspace: `getWorkspace` (the user's channels, public settings, readiness), `getHarness` (the setup, program, model and effort in use, read-only), `getReadiness`, `getOpencodeUsage`, `createChannel`, `updateChannel`, `removeChannel`, `reorderChannels`, `getDefaultPrompt`, `exportChannels`, `importChannels`.
- Library: `getLibrary`, `createVideo`, `setVideoTypeOverride`, `getVideoInputs`, `setVideoInputs`, `archiveVideo`, `unarchiveVideo`, `getArchived`, `getEditLog`.
- Jobs: `startEdit`, `reEdit`, `pauseJob`, `continueJob`, `stopJob`, `getJobLog`, `getQueue`, `getUsage`.
- Timeline: `openTimeline`, `getTimeline`, `editTimeline`, `undoTimeline`, `redoTimeline`, `listRevisions`, `restoreRevision`, `addTimelineNote`, `deleteTimelineNote`, `retryTimelineNote`, `renderFinal`.
- Storage: `fsPlaces`, `fsList`, `fsCreateFolder`, `createUpload`, `cancelUpload`.
- Disk: `getDiskUse`, `cleanWorkingFiles`.

Events: `library-changed`, `job-updated`, `job-log`, `queue-changed`, `settings-changed`, `timeline-changed`, `note-updated`, `preview-copies-changed`, `usage-updated`, `system-changed`, `disk-use-changed`, `session-ended`.
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
- `uploads`: id, user_id, video_id, folder, name, size, received, created_at, touched_at.
- `edit_log`: id, at, user_id (emptied when the user is deleted), user_email, video_label, event, message (the newest 20000 kept).
- `progress_history`: kind, video_type, seconds, finished_at.
- `launches`: queue, at (for the start delay).

Job logs are files (`logs/<jobId>.jsonl`), not rows.

## 16. User interface

The existing screens and design system stay: the sidebar with the user's channels, the video list with its rows and actions, the activity panel with the job log and outputs, the Start Editing, Re-Edit and Stop sheets, channel settings with prompt and style slots, history (archive, edit log), the in-page folder picker.
Theme and text size are kept per browser (local storage), not on the server.

New or changed:

- Sign in page; first-admin setup page; account menu (email, change password, sign out).
- New Video (name, then an upload area for the A-roll and B-roll with progress, pause, resume and cancel per file); uploads also from a video's menu.
- Start Editing and Re-Edit: the Urgent checkbox with the hint "Starts before the other waiting videos, after those already being edited and earlier urgent ones."
- A waiting video shows its position; the sidebar status shows the server's readiness and how many edits run and wait.
- Timeline screen (section 11): player with play, pause, frame steps, time code, speed, volume, full screen; tracks with zoom, a ruler, a playhead, selection, drag to trim and move with snapping, Delete, Split, Undo, Redo, revisions; "Ask for a change" (draw the ellipse, type, Send); the list of change requests with their state, each jumping to its frame; Render Final with its progress and the finished videos.
- Disk Cleanup page and menu entry (section 13).
- Edit log: an admin chooses "Whose edits" (My edits, Everybody, or one user); the email column shows when other users' entries are listed; the choice stays for Refresh and older entries and is reset at sign-out.
- Queues and Limits: a per-edit CPU or GPU value above its total shows "Limited by the total: an edit gets at most N%." beside the field.
- Admin section: Users, Harness and Model, Queues and Limits, Storage, Queue (all jobs), System.
- Removed: onboarding for an Editing Folder, the toolkit choice, review software, no-sleep, the desktop window chrome and quit dialogs.

The layout floor, text zoom, popups and dialogs under zoom, and shortcut hints that leave out keys the browser keeps, are carried over from `docs/SPEC-desktop.md` section 12 "User interface in the browser".

## 17. Quality bar

- `npm run check` runs everything: Prettier, ESLint (UI and server, zero warnings), TypeScript (UI, and the server's JavaScript with `checkJs`), UI tests (`vitest`), server tests (`node --test`), toolkit tests (`python -m unittest`).
- Engine tests drive the real job engine against the fake agent programs in `server/test/support/` (`fake-claude.sh`, `fake-opencode2.py`, `fake-hyperframes.mjs`) with shortened timers.
- `npm run e2e` starts the real server with a temporary data directory and the fake programs and drives it in Chromium: sign in, admin pages, channels, upload, start, queue order with Urgent, pause, continue, stop, timeline play, hand edits, change request, render, Disk Cleanup, two users at once.
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

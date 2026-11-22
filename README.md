# VidAI Server

VidAI Server runs on one Windows or Mac computer in your office.
Everybody in the office opens it in a browser over the intranet and signs in with an email and a password that an admin created.
A user starts AI video edits of their own videos, follows them, reviews the result on a timeline in the browser, asks for changes there, and finally asks for the rendered video.
Each edit is done by a coding agent (Claude Code or OpenCode 2) installed on the server computer, running headless inside the video's folder.
The full product and engineering contract is [docs/SPEC.md](docs/SPEC.md).

## Requirements

On the computer that runs the server:

- Node.js 22.13 or newer ([nodejs.org](https://nodejs.org)).
- ffmpeg and ffprobe.
- Python 3.10 to 3.13 (the Python that comes with macOS is not used; install one, for example from [python.org](https://www.python.org) or Homebrew).
- The agent program of the setup you will choose: Claude Code, or OpenCode 2 (`opencode2`).
  On Windows, Claude Code also needs Git for Windows (Git Bash).
  The Claude subscription setup needs `claude` to be logged in once, in a terminal, as the same operating system user that runs the server.
- Internet access for the first start, when the server prepares its editing toolkit (Python packages, the renderer's browser, the speech model).
- Disk space for the videos: the default storage folder is inside the data directory, and the admin can add other folders (also network shares the computer has mounted).

The browsers of the colleagues need nothing installed.

## Install and start

Copy or clone this folder onto the server computer, then start it:

```sh
./start.sh          # Mac
start.cmd           # Windows
```

The script checks that Node.js is new enough, runs `npm install` when needed, builds the interface when it is out of date, and starts the server.
Without the script, run `npm install`, `npm run build` and `npm start`.

Options (they go after the script name, for example `./start.sh --port 15000`):

| Option             | Environment variable | Default                                           |
| ------------------ | -------------------- | ------------------------------------------------- |
| `--port <n>`       | `VIDAI_PORT`         | `14200`                                           |
| `--host <address>` | `VIDAI_HOST`         | `0.0.0.0` (every network interface)               |
| `--data <dir>`     | `VIDAI_DATA_DIR`     | see [Where the data lives](#where-the-data-lives) |
| `-h`               |                      | prints the options                                |

When it is up, the terminal prints every address the server can be reached at: `https://<host name>:14200` and one address per network address of the computer.
Colleagues open one of those in their browser.
Make sure the computer's firewall lets the port in from the office network.

Stop the server with Ctrl+C in its window.
Running edits are paused first (a user can continue them after the next start) and running renders are stopped; a second Ctrl+C stops at once.

## First start and admin setup

A new server has no accounts.
There are two ways to create the first admin; the server uses the first that applies.

1. Set `VIDAI_ADMIN_EMAIL` and `VIDAI_ADMIN_PASSWORD` before the first start.
   The server creates that admin when it finds no enabled admin, and the terminal says so (without the password).
   The password needs 8 to 200 characters.
   Remove the variables afterwards; they are only read while no enabled admin exists.

   ```sh
   VIDAI_ADMIN_EMAIL=admin@example.com VIDAI_ADMIN_PASSWORD='choose-a-long-password' ./start.sh
   ```

2. Otherwise the terminal prints a one-time setup address like `https://localhost:14200/setup#<token>`.
   Open it in a browser on the server computer, and enter the admin's email and password.
   The token is made fresh at every start, is kept only in memory, and stops working when it was used or when the server stops.
   If no admin exists at the next start, a new address is printed.

After you sign in as the admin:

1. Open the System page (Admin area) and press Prepare if it was not done yet; edits cannot start before the toolkit is prepared.
   The page also shows what is missing (Claude Code, OpenCode 2, ffmpeg, Python) and how to fix it.
2. Choose the setup (Claude Code with the Claude subscription, OpenCode 2 with OpenCode Go, or an Anthropic-compatible or OpenAI-compatible API with its address, key and model).
3. Review the queue and resource limits, and add storage folders if the videos live elsewhere than the default folder.
4. Create the accounts of your colleagues (email and password; they can change their own password).

If an admin forgets their password, run this on the server computer, in the repository folder (it asks for the new password twice, works while the server runs, and ends that account's sessions):

```sh
node server/src/main.js admin-reset --email admin@example.com
```

## HTTPS and the certificate

The server only speaks HTTPS.
On the first start it makes a self-signed certificate (valid 825 days) for `localhost`, the host name, the host name with `.local` and every network address of the computer at that moment.
It is replaced at a start when it is within 30 days of its end or when it lacks a current address of the computer.

Because nothing vouches for a self-signed certificate, every browser warns once on the first visit.
Each colleague can accept the warning for the site, or you can make their computers trust the certificate: copy `tls/cert.pem` from the data directory and add it as a trusted certificate (macOS: Keychain Access, set to Always Trust; Windows: import it into "Trusted Root Certification Authorities").
The System page shows the certificate's names, end date and SHA-256 fingerprint to compare.

To use a proper certificate (for example one from your own company authority, for a name like `vidai.office.example`), stop the server and put your two files into `tls/` in the data directory as `cert.pem` (the certificate, with its chain) and `key.pem` (its private key), replacing the ones there.
The server uses a certificate that it did not make exactly as it is and never replaces it; if `cert.pem` is there without `key.pem`, or cannot be read, the server refuses to start and says which file.
To go back to a self-signed certificate, delete both files and start the server.

## Where the data lives

The data directory is `~/Library/Application Support/VidAI Server` on a Mac and `%LOCALAPPDATA%\VidAI Server` on Windows; `--data` or `VIDAI_DATA_DIR` moves it.
Only one server can use a data directory at a time.
Back it up together with the storage folders.

| Path         | Content                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `vidai.db`   | accounts, queues and all management data (SQLite)                            |
| `secret.key` | encrypts the API keys in the database; keep it private and with the database |
| `tls/`       | `cert.pem` and `key.pem`                                                     |
| `logs/`      | one log file per job                                                         |
| `server.log` | the server log (rotated at 10 MB, 5 files kept)                              |
| `toolkit/`   | the editing toolkit and its Python environment                               |
| `media/`     | the default storage folder for channels and videos                           |
| `projects/`  | timeline revisions and change-request pictures of each video                 |
| `cache/`     | preview copies and render caches                                             |

VidAI never deletes or overwrites a user's video files; Disk Cleanup removes only the files in a video's `CLAUDE_VE` folder, which can be rebuilt.

## Security notes

All users are colleagues on a private network.
The agent runs as the operating system user that runs the server, with permission checks switched off, so an edit can read and write whatever that user can; run the server as a user that has access to nothing else.
VidAI keeps users apart in its own interface, not at the operating system level.
Do not expose the port to the internet.

## Windows

The Windows code paths (process trees, CPU limits with a Job Object, launching programs, paths) are tested on a Mac as far as that is possible and have not all run on a real Windows computer yet; report anything that behaves differently there.

## Development

```sh
npm install
npm run dev     # the interface alone on http://localhost:1420, against an in-memory mock backend
npm run check   # every gate
```

`npm run dev` accepts `?scenario=<name>` (several, comma-separated, for example `busy,usage-critical`; the list is in `src/lib/mock/scenarios.ts`), `?as=admin` or `?as=user`, `?latency=600`, `?speed=3`, `?minute=` and `?ticks=off`.
Add `?backend=http` to use a running server instead of the mock (it is found at `https://127.0.0.1:14200`, or at `VIDAI_SERVER`).

| Command                    | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `npm start`                | starts the server (`npm run server` is the same)      |
| `npm run build`            | type-checks and builds the interface into `dist/`     |
| `npm run format:check`     | Prettier                                              |
| `npm run lint`             | ESLint on the interface and the server, zero warnings |
| `npm run typecheck`        | TypeScript of the interface                           |
| `npm run server:typecheck` | TypeScript `checkJs` of the server's JavaScript       |
| `npm test`                 | interface tests (vitest)                              |
| `npm run server:test`      | server tests (`node --test`)                          |
| `npm run toolkit:test`     | editing toolkit tests (Python `unittest`)             |
| `npm run check`            | all of the gates above                                |

Tests use a temporary data directory, `VIDAI_SECRETS=memory` and fake agent programs, never the real data.
The code layout is section 3 of [docs/SPEC.md](docs/SPEC.md), and the rules for working on the code are in [CLAUDE.md](CLAUDE.md).

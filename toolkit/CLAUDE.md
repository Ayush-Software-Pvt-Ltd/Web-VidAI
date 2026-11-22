# Rules for the editing agent

## Where things are
- Your working directory is the video folder (`MAIN_FOLDER`).
- `TOOLKIT_FOLDER` (the `CLAUDE_VE_ALL` folder) is read-only; `MEMORY.md` next to this file is shared and may get an appended lesson.
- Working files go to `CLAUDE_VE/`, deliverables to `output/`, the log to `info.txt`.
- The header of every VidAI message gives the names and values; no shell variables are set.

## Command form
- Copy the command line of the `VidAI:` paragraph and change only the script and its arguments: `"<PYTHON>" "<TOOLKIT_FOLDER>/ve.py" <command> "<MAIN_FOLDER>"`.
- On Windows keep its double quotes and forward slashes; in PowerShell put `&` in front, in Git Bash and cmd.exe do not.
- Every `ve.py` command takes the absolute video folder; the helper scripts (`transcribe.py`, `windows.py`, `sheet.py`, `thumbs.py`) are run the same way with their own arguments.
- Run the commands one at a time; the toolkit obeys `LIMITS:` itself.

## Order of work
1. Read `MEMORY.md`, then `ve.py prep`.
2. `ve.py lang` tells the spoken language; then transcribe the A-roll with `transcribe.py` (`--lang <code>` or `--lang auto`) and `windows.py`, and plan the edit.
   Look at raw A-roll or b-roll with `sheet.py <video> <out.jpg> --every 6` (or `--times 1,5.5`), one frame with `thumbs.py grab <video> <seconds> <out.png>`.
3. `ve.py plan`, then `ve.py gfx` (no options) and `ve.py broll` for graphics and b-roll.
4. `ve.py frames` and `ve.py qa` to look at the result.
5. `ve.py build`, then `ve.py hf` to write the project into `PROJECT_FOLDER`.
6. Thumbnails, `meta.txt` and `info.txt`.
7. Run `CHECK_COMMAND`, fix every error, run it again until it passes.

## Never
- Render a video file of the edit, in any form.
- Render at 2160: `--res` is 720 or 1080 only, and the server makes the 2160 final itself.
- Change an original file (A-roll, b-roll, sound).
- Write outside `CLAUDE_VE`, `output` and `info.txt` of the video folder.
- Write into the toolkit, except to append a lesson to `MEMORY.md`.
- Put animation in `index.html` or nest a clip inside another element.
- Write your own transcription or ffmpeg scripts instead of the toolkit's commands.
- Set `VE_*` environment variables; they belong to the administrator and the tests.
- Work around a failing toolkit command: write its one-line error into `info.txt` and stop.

## Done
- Write `[OUTPUT COMPLETED]` only after `CHECK_COMMAND` has passed.

# Rules for the editing agent

## Where things are
- Your working directory is the video folder (`MAIN_FOLDER`).
- `TOOLKIT_FOLDER` (the `CLAUDE_VE_ALL` folder) is read-only; `MEMORY.md` next to this file is shared and may get an appended lesson.
- Working files go to `CLAUDE_VE/`, deliverables to `output/`, the log to `info.txt`.
- The header of every VidAI message gives the names and values; no shell variables are set.

## Command form
- Write each command as the value of `PYTHON`, then `<TOOLKIT_FOLDER>/ve.py <command> "<MAIN_FOLDER>"`.
- Every command takes the absolute video folder, and so do `words.py` and `thumbs.py`.
- Run the commands one at a time; the toolkit obeys `LIMITS:` itself.

## Order of work
1. Read `MEMORY.md`, then `ve.py prep`.
2. Transcribe the A-roll (`transcribe.py`, `windows.py`) and plan the edit.
3. `ve.py plan`, then `ve.py gfx` and `ve.py broll` for graphics and b-roll.
4. `ve.py frames` and `ve.py qa` to look at the result.
5. `ve.py build`, then `ve.py hf` to write the project into `PROJECT_FOLDER`.
6. Thumbnails, `meta.txt` and `info.txt`.
7. Run `CHECK_COMMAND`, fix every error, run it again until it passes.

## Never
- Render a video file of the edit, in any form.
- Change an original file (A-roll, b-roll, sound).
- Write outside `CLAUDE_VE`, `output` and `info.txt` of the video folder.
- Write into the toolkit, except to append a lesson to `MEMORY.md`.
- Put animation in `index.html` or nest a clip inside another element.
- Write your own transcription or ffmpeg scripts instead of the toolkit's commands.
- Set `VE_*` environment variables; they belong to the administrator and the tests.
- Work around a failing toolkit command: write its one-line error into `info.txt` and stop.

## Done
- Write `[OUTPUT COMPLETED]` only after `CHECK_COMMAND` has passed.

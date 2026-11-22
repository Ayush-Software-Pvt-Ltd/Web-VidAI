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
1. Read `MEMORY.md` and the section "Writing the edit" of `README.md` next to this file (the `timeline.py` contract, graphic templates, layouts); then `ve.py prep`.
2. `ve.py lang` tells the spoken language; then transcribe the A-roll with `transcribe.py` (`--lang <code>` or `--lang auto`) and `windows.py`.
   Look at raw footage with `sheet.py <video> <out.jpg> --every 6` (or `--times 1,5.5`), one frame with `thumbs.py grab <video> <seconds> <out.png>`.
3. Write `CLAUDE_VE/timeline.py`: a full-screen graphic or b-roll about every 20 to 30 seconds over the whole video, keyword `HITS` on key terms, several templates, no repeats.
4. Make graphics with `ve.py graphic "<MAIN_FOLDER>" <name> --template <t> --var key=value` (`ve.py graphic --list`); hand-write a page only when no template fits.
5. `ve.py plan` writes `CLAUDE_VE/plan.txt`; fix the cause of every `WARN` line in `timeline.py` and plan again.
6. `ve.py hf` writes the project into `PROJECT_FOLDER`; `ve.py gfx`, `broll` and `build` are not needed.
7. `ve.py frames --project` shows what the user will see: look at its contact sheet and `WARN` lines, fix your own edit (graphic, timeline, layout) and repeat steps 5 to 7 until it looks right.
8. Thumbnails, `meta.txt` and `info.txt`.
9. Run `CHECK_COMMAND`, fix every error, run it again until it passes.

## Never
- Render a video file of the edit, in any form.
- Render at 2160: `--res` is 720 or 1080 only, and the server makes the 2160 final itself.
- Change an original file (A-roll, b-roll, sound).
- Write outside `CLAUDE_VE`, `output` and `info.txt` of the video folder.
- Write into the toolkit, except to append a lesson to `MEMORY.md`.
- Put animation in `index.html` or nest a clip inside another element.
- Write your own transcription, ffmpeg or debug scripts instead of the toolkit's commands.
- Set `VE_*` environment variables; they belong to the administrator and the tests.
- Read or run the toolkit's internal modules (`vekit/`) or redirect command output into files; the commands, their `--help`, `README.md` and `plan.txt` are the interface.
- Work around a failing toolkit command: write its one-line error into `info.txt` and stop.

## Done
- Write `[OUTPUT COMPLETED]` only after `CHECK_COMMAND` has passed.

# VidAI editing toolkit

The Python programs, design kits, graphics templates and sound effects the editing agents use.
The server copies this folder to `<data dir>/toolkit/` and installs its packages into `<data dir>/toolkit/venv`.
The toolkit is only ever read after that: nothing is written into it while it runs.

## Layout

- `CLAUDE_VE_ALL/` is the code and the shared material.
  - `ve.py` is the driver (`doctor`, `prep`, `lang`, `plan`, `gfx`, `broll`, `build`, `hf`, `review`, `fcp`, `premiere`, `import`, `frames`, `audio`, `qa`, `hardware`).
  - `transcribe.py`, `windows.py`, `words.py`, `timing.py`, `sheet.py` and `thumbs.py` are small helper programs.
  - `vekit/` is the library: `paths.py` (folder layout), `resources.py` (CPU budget, GPU slots, hardware choice), `asr.py` (speech recognition), `tools.py` (ffmpeg and friends), and the editing code (`plan.py`, `model.py`, `render.py`, `broll.py`, `gfx.py`, `fcpxml.py`, `premiere.py`, `hfproject.py`, `qa.py`).
  - `gfx/_shared/` is the one copy of the design kits and fonts, `gfx/templates/` the graphics templates, `sfx/` the sound effects.
  - `requirements.txt` lists the Python packages, with platform markers for the speech package.
  - `requirements-cuda.txt` lists the CUDA 12 libraries (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`, a recent `ctranslate2`) that the server installs only on a Windows or Linux computer with an NVIDIA GPU.
- `MEMORY.md`, `CLAUDE.md` and `default_prompt.md` are the editing agents' standing instructions and are not code.
- `VERSION` is the toolkit version the server compares with the installed copy.
- `tests/` holds the unit and end-to-end tests (see below).

## Calling it

Every command takes the video folder as an absolute path.
A relative path is resolved against the current directory, and the folder may lie anywhere.
The program is found from its own location, so any working directory is fine.

```
<data dir>/toolkit/venv/bin/python <data dir>/toolkit/CLAUDE_VE_ALL/ve.py prep  "/path/to/Video folder"
<data dir>/toolkit/venv/bin/python <data dir>/toolkit/CLAUDE_VE_ALL/ve.py build "/path/to/Video folder" --res 720
```

On Windows the Python is `<data dir>\toolkit\venv\Scripts\python.exe`.
In PowerShell a quoted program path needs `&` in front: `& "C:/.../python.exe" "C:/.../ve.py" prep "C:/.../Video folder"`; Git Bash and cmd.exe take the same line without the `&`.
Forward slashes and double quotes work in all three, so the server writes the commands for the agent that way.
Working files go to `<video folder>/CLAUDE_VE/` and deliverables to `<video folder>/output/`.

## Language

`ve.py lang <video folder>` prints the spoken language of each A-roll (after `prep`) as `a1  language: hi 0.93 (en 0.05, ur 0.01)`.
`transcribe.py` and `windows.py` take `--lang <code>` (default `hi`) or `--lang auto`.
`auto` detects once, prints the same line and uses that language for every pass, chunk and window; an explicit code is never detected.
The detection is Whisper's guess on up to three windows of 30 s spread over the audio, with silent windows left out and the probabilities averaged.
The Hindi default prompt is used only when the language is `hi`, and the JSON files record the language used in `language`.

## The HyperFrames project (`ve.py hf`)

`ve.py hf <video folder>` writes `<video>/output/<video folder name>.hf/`, a HyperFrames project that follows the profile of SPEC section 10.
`ve.py review` is the same command.
The server plays the project on a timeline, lets people hand-edit it and renders it later.
`ve.py hf` itself never renders anything.
It reads `CLAUDE_VE/build/timeline.json`, so run `build` first.
Optional `--timeline <file>` reads another timeline.

The project holds:

- `index.html` with the fixed root script, one clip per element, and only the shared GSAP script.
- `compositions/<id>.html` for every graphic, from its template with the variables filled in.
- `shared/` is a real copy of the design kits and fonts.
- `assets/media/` links the media (symlink, else hardlink, else copy), `assets/sfx/` and `assets/music/` hold the sound.
- `edit.json`, `transcript.json`, `hyperframes.json` and `meta.json`.

What each element of the edit becomes:

| Element | Clip |
| --- | --- |
| A-roll | track 0 video clip `a-N`, volume as `data-volume`, the fades of its sound as `data-fade-in` and `data-fade-out` |
| B-roll | track 1 video clip `b-N`, with CSS framing (crop, scale, position, rotation, rounded box); with push, pull or drift motion it is a host `b-N` whose `compositions/b-N.html` holds the video and one GSAP zoom or slide (see below) |
| Synced B-roll | one clip per A-roll range on track 1 |
| Full-screen graphic | track 1 sub-composition `g-N` |
| Overlay graphic | track 2 sub-composition `ov-N` |
| Keyword hit | track 3 sub-composition `h-N` |
| End fade | track 4 sub-composition `fade-N` |
| Sound effects and music | audio clips `s-N` and `m-N` on tracks 10 and up |

The fades of the A-roll's sound are clip-edge fades of HyperFrames, `data-fade-in` and `data-fade-out` on the `<video>` (seconds, linear, multiplied on `data-volume`).
Since toolkit 1.3.0 they are no longer `data-automation` volume lanes.
One rule (`fade_plan` in `vekit/hfproject.py`) says where they go, and the server's `lanes.js` holds the same rule so that a hand edit writes them again exactly as the toolkit would.
`server/test/support/fixtures/fade-rule.json` is the table both sides run.
A cut between two different sources gets an 8 ms fade out and an 8 ms fade in (a de-click).
A cut that continues the same source (same file and speed, the second clip starts where the first stops) gets nothing, and neither does the inside of a clip.
The first clip fades in over 8 ms.
The tail of the last clip is the end fade: as long as the end fade picture (`fade-N`), at most the clip's own length, else 8 ms.
A clip shorter than four de-clicks, or without sound, has no fades.
An A-roll clip's own audio fade-in (only a project imported from FCPXML has one) is not carried over any more; the rule decides every fade.

A B-roll with push, pull or drift motion keeps its picture in `compositions/b-N.html`, in a shape the server edits when a person trims, splits or moves the clip:
the box `#b-N-motion` carries the movement as `data-vidai-motion='{"scale":[a,b],"x":[c,d],"duration":<seconds>}'` (a linear zoom and slide), and the `<video>` inside carries `data-media-start` (the in-point) and `data-duration` (as long as the file allows, at most 10 minutes more than the clip).
The file's script reads that attribute and runs one linear tween, so changing the attribute changes the movement.
`vekit/hfproject.py` (`broll_composition`) and the server's `editMotion.js` write the same file byte for byte, which `server/test/support/fixtures/projects/motion/` pins on both sides.
A file written by toolkit 1.2.0 or by an agent in another shape is read as a plain graphic: it can be trimmed, moved and deleted, but not split.
What cannot be represented is dropped with a plain warning:
the background and picture-in-picture of synced B-roll, a graphic resumed part-way, and the loudness levelling and limiter of the final mix (the server does that).
HyperFrames is pinned in `vekit/tools.py` (`hyperframes@0.9.80`), the same version as the server's.
HyperFrames 0.9 refuses a symbolic link that leaves the project folder, so the render work copies of `ve.py gfx` and `thumbs.py` get `shared` as a tree of hard links.
Their work folders (`vekit/scratch.py`) are removed with retries and never raise, because on Windows Chrome or ffmpeg may still hold a file for a moment; the cache key of a graphic is written as soon as its file is in place.
Every render of the toolkit (`gfx`, `build`, `frames`, `qa`) is at 720 or 1080 and refuses 2160 with one line: the final render is the server's own `hyperframes render` of the project (SPEC section 12), which never calls the toolkit, so an edit never needs the 2160 graphics.
`VE_ALLOW_2160=1` is an administrator and test override that lifts the refusal.

Writing is safe and repeatable.
The project is built in `output/.<name>.hf.new`, checked, and then swapped in, with the old copy kept as `.<name>.hf.old` until the swap succeeds.
`meta.json` keeps its first `createdAt` across rewrites.
The command ends with a self-check of rules 1 to 7 and 10 of the profile and exits non-zero with plain sentences when something is wrong.
`vekit/hf_root_script.js` is a copy of the server's root script and a test compares the two.

## Environment

All variables are optional.
Without them the programs use the whole machine and take no GPU slot, which is how they run by hand.

- `VE_CPU_CORES` is how many processors the job may use.
- `VE_GPU_SLOTS_DIR` and `VE_JOB_ID` switch on the GPU slot protocol (SPEC section 9).
- `VE_HW` is `none` (software only) or one of `videotoolbox`, `nvenc`, `qsv`, `amf`; absent means pick what the machine can really do.
- `VE_CHANNEL_DIR` is the channel folder when it is not the video folder's parent.
- `VE_FFMPEG`, `VE_FFPROBE`, `VE_NPX` and `VE_NODE` name the programs.
- `VE_HYPERFRAMES` is the HyperFrames command-line script (a `.mjs` or `.js` file) that is run with Node instead of `npx -y hyperframes@<pinned version>`.
  The server sets it to its own pinned copy so that nothing is downloaded while a job runs.
- `VE_ASR_BACKEND` (`mlx` or `faster`), `VE_ASR_DEVICE` (`cpu` or `cuda`) and `VE_FONT` override the speech backend, its device and the label font; they are for the administrator and the tests, never for the editing agent.
- On a computer with an NVIDIA GPU speech runs on CUDA and never falls back to the CPU; when CUDA cannot be used, `transcribe.py`, `windows.py` and `qa` print one line and exit with code 2.
- `ve.py doctor` shows the speech device and the video encoder, and `ve.py hardware` prints both as one JSON line for the System page of the server.

## Tests

```
python3 -B -m unittest discover -s toolkit/tests
```

They need Python 3.10 or newer with numpy, soundfile and pillow, and ffmpeg and ffprobe on the PATH.
The end-to-end tests are skipped without ffmpeg.
They use tiny generated media, a fake HyperFrames (`tests/support/fake_npx.py`) and fake speech packages, so nothing is downloaded and no hardware is needed.

# VidAI editing toolkit

The Python programs, design kits, graphics templates and sound effects the editing agents use.
The server copies this folder to `<data dir>/toolkit/` and installs its packages into `<data dir>/toolkit/venv`.
The toolkit is only ever read after that: nothing is written into it while it runs.

## Layout

- `CLAUDE_VE_ALL/` is the code and the shared material.
  - `ve.py` is the driver (`doctor`, `prep`, `lang`, `plan`, `graphic`, `gfx`, `broll`, `build`, `hf`, `review`, `fcp`, `premiere`, `import`, `frames`, `audio`, `qa`, `hardware`); the table under "The commands" says what each does.
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

## The commands

| Command | What it does |
| --- | --- |
| `ve.py doctor` | checks ffmpeg, the video encoder, Node and the speech package |
| `ve.py hardware` | prints the speech device and the video encoder as one JSON line |
| `ve.py prep` | looks at the video folder, writes `CLAUDE_VE/project.json` and extracts the audio |
| `ve.py lang` | prints the spoken language of each A-roll |
| `ve.py plan` | turns `CLAUDE_VE/timeline.py` into `build/timeline.json` and writes `plan.txt` |
| `ve.py graphic` | writes a full-screen graphic from a template with variables into `CLAUDE_VE/gfx_src/<name>/` |
| `ve.py gfx` | renders the graphics the timeline uses to video files (720 or 1080); the project does not need them |
| `ve.py broll` | conforms the b-roll the timeline uses to video files; the project does not need them |
| `ve.py build` | renders picture and sound of the whole edit to one video file at `--res 720` or `1080`; the project does not need it and the editing agent does not run it |
| `ve.py hf` and `ve.py review` | write the HyperFrames project (the deliverable); the two are the same command |
| `ve.py frames` | one composited still per shot; with `--project` stills of the real HyperFrames project |
| `ve.py audio` and `ve.py qa` | the mix alone, and contact sheets, pacing and loudness of a render |
| `ve.py fcp`, `ve.py premiere` and `ve.py import` | review files for editing programs and the reader of their exports (not part of the VidAI flow) |

## Writing the edit

The edit is data: `CLAUDE_VE/timeline.py` says which part of the A-roll is kept, what is on screen when, and which graphics, pop-ups and sounds are added.
`ve.py plan` turns it into frames, `ve.py gfx` and `ve.py broll` make the pictures, `ve.py hf` writes the project.
Every time in `timeline.py` is a raw time in seconds of an A-roll file, never a time of the output, so the anchors survive when a cut changes.
A time may start with the part name (`("a2", 12.5, "H")`); without a part it is `a1`.
A raw time that falls in removed audio moves to the next kept frame.

### The timeline.py contract

```python
SEGS = [
    (2.10, 9.84),                           # kept A-roll, in output order: first word start, last word END
    (11.20, 15.60, {"in": "exact"}),        # "exact" pins a hand-checked cut point (no snapping)
    ("a2", 0.40, 6.00, {"out": "exact"}),   # another A-roll part
]
VIS = [                                     # what is on screen from this raw time to the next entry
    (2.10, "H"),                            # host, framing alternates wide and punched-in across cuts
    (5.50, "G:stat1"),                      # full-screen graphic CLAUDE_VE/gfx_src/stat1/
    (8.00, "HW"),                           # host wide (HT is host tight, a punch-in)
    (9.20, "B:phone"),                      # b-roll BROLL["phone"]; B:phone@3.5 starts the clip at 3.5 s
    (11.20, "G:title1@1.5"),                # a graphic resumed at 1.5 s of its own clock after a cut to the host
]
BROLL = {
    "phone": {"file": "broll/phone.mp4", "in": 0.0, "lo": 0.0, "hi": 18.0, "motion": "push"},
    "tablet": {"file": "screen.mp4", "sync": {"part": "a1", "offset": 1.84},
               "box": [0.04, 0.06, 0.52, 0.88], "radius": 0.02, "bg": "CLAUDE_VE/plate.png",
               "pip": {"file": "Main.mp4", "offset": 1.84, "crop": [0.2188, 0.0, 0.7813, 1.0],
                       "box": [0.60, 0.30, 0.36, 0.36]}},
}
OVL = [(14.0, 18.0, "spec_card")]           # transparent graphic over the picture (gfx_src/spec_card/)
HITS = [(15.2, 17.0, "Qi2 charging"),       # keyword pop-up with text; an optional dict sets more variables
        (22.0, 23.5, "Rs 12,500", {"accent": "green"})]
SFX = [(20.1, "tick", -16)]                 # extra sound effect: raw time, name, dB
END_HOLD = 0.55                             # seconds of quiet after the last word, with the fade to black
```

- `SEGS` is the A-roll that stays, in output order.
  The end of an entry is the END of its last word, never the start of it.
  Pauses longer than about 0.3 s inside a take are cut by the planner.
- `VIS` entries must be in raw order and each one lasts until the next.
  A `VIS` entry in cut audio or within 8 frames of a jump cut is moved or dropped, and `plan.txt` says so (see below).
- `BROLL` keys: `file` (path in the video folder), `in` (start in the clip), `lo` and `hi` (the usable window; the planner moves the in-point earlier when the slot is longer), `motion` (`push`, `pull`, `left`, `right` or `none`), `scale` and `pos` (punch in; `pos` is percent of the frame height, +y up), `rotate` (degrees, for footage stored sideways) and `crop` `[x0, y0, x1, y1]` (fractions, same aspect as the video).
- A b-roll with `sync` is a second angle recorded with the A-roll, usually a screen recording: its source time is the A-roll raw time plus `offset`, and it follows every jump cut of the A-roll.
  Its layout keys are `crop` (part of the source, fractions), `box` `[x, y, w, h]` (where the screen goes, fractions of the frame, aspect kept and centred in the box), `radius` (rounded corners, fraction of the frame height), `bg` (a picture the size of the frame in the video folder, behind the screen) and `pip` (the host in a circle, below).
- `HITS` use the project's `hit_template` (`project.json`); `hit_pos` lifts them (percent of the frame height) clear of the host's head.
- `OVL` graphics are transparent and meant for cards over b-roll or the host; an `OVL` over a full-screen graphic is reported.
- The planner adds a whoosh into every full-screen graphic and a pop on every hit by itself; `SFX` adds more (`whoosh1` to `whoosh3`, `pop1`, `pop2`, `tick`).
- A graphic or b-roll that is used more than twice is reported; a graphic resumed with `@` counts as one use.

### Graphics

The quickest good graphic is a template:

```
"<PYTHON>" "<TOOLKIT_FOLDER>/ve.py" graphic "<MAIN_FOLDER>" stat1 --template stat --var value="98.5%" label="Battery health" --duration 4
```

`ve.py graphic --list` prints the templates and their variables.
Every template is opaque, always moving until the last frame, fits its text into the safe area and works in landscape and portrait (the project's orientation is used).

| Template | For | Main variables |
| --- | --- | --- |
| `title` | chapter or section title, hook line | `title*`, `kicker`, `subtitle`, `align` |
| `stat` | one big number that counts up | `value*`, `label*`, `kicker`, `note`, `count` |
| `list` | 2 to 6 points that arrive one after the other | `items*` (a\|b\|c), `title`, `kicker`, `style` |
| `quote` | a quote with author and role | `quote*`, `author`, `role`, `align` |
| `compare` | two columns, A against B | `a_label*`, `b_label*`, `a_items*`, `b_items*`, `title` |
| `image` | a product photo or icon with a caption, drifting slowly | `caption*`, `image`, `icon`, `kicker`, `subtitle`, `mode`, `fit` |

All of them also take `accent`, `accent2`, `bg1`, `bg2`, `text`, `font` and `seed`; take the colours from the channel style, and change `seed` for a different background so two graphics in a row do not look the same.
A variable marked `*` is required.
The command writes `CLAUDE_VE/gfx_src/<name>/` (the page and `graphic.json`), and `VIS` refers to it as `G:<name>`.
Run it again with the same name to replace the graphic.
Use several templates over a video, put a graphic or b-roll in every 20 to 30 seconds of the edit, and keep one on screen for 2 to 5 seconds.

A graphic that no template fits is a hand-written page `CLAUDE_VE/gfx_src/<name>/index.html` (use `hyperframes` and its skills for the craft).
The page contract:

- The root is `<div id="root" data-composition-id="main" data-start="0" data-duration="<seconds>" data-width="<W>" data-height="<H>">`, at 1920x1080 or 1080x1920 like the project; the duration of the page is the length of the graphic.
- The one timeline is `gsap.timeline({ paused: true })` from `shared/js/gsap.min.js`, registered as `window.__timelines["main"]`.
- A full-screen graphic has an opaque background over the whole frame (a colour, a gradient or a picture on the first child of the root), or `ve.py hf` refuses the project with rule 12: otherwise the host shows through.
  An overlay (`OVL`) has a transparent page.
- Something moves to the last frame: no exit animation, no frozen end; size the slot to at most the length of the page.
- Keep text inside the safe zone (about 6 % in from each edge, and for a Short away from the bottom 15 % and the right edge), and keep it big and bold.
- Use the design kit and fonts of `shared/` by their classes, relative paths inside the folder, and no `../` path (rule 10 refuses it).
- Values that an editor might change are declared variables of the page (`data-composition-variables`), and nothing is read from the network.

### Pop-ups and overlays

A `HITS` entry shows a keyword for 1 to 2.5 s over the host while it is said: put it on a key term, a number or a product name, with the raw time of the word.
Keep it to 2 to 5 words, anchored on a word of the first take that stays in `SEGS`.
Pop-ups sit in a zone above or beside the head; check them in the frames of the project, and use `hit_pos` when the head is high in the frame.
An `OVL` is a graphic of your own with a transparent page, for example a spec card or a highlight box over a screen recording; give each highlight its own `OVL` entry so it can be edited alone.
The planner does not move a hit, so a hit anchored inside a full-screen graphic plays over that graphic; anchor it at the first raw time after the cut.

### Screen recordings with the host in a circle

A recording of a phone or tablet screen that was made during the take is a `sync` b-roll, and the host is its `pip`:

- `offset` of `sync` is found by comparing the sound of the two files (source time = A-roll raw time plus offset); `offset` of `pip` is the same number for the A-roll file named in `pip.file` (time in the screen recording minus time in that file), so it equals the `sync` offset when `pip.file` is the A-roll part named in `sync`.
- `box` is where the screen goes and `pip.box` where the circle goes; the circle is as wide as the smaller side of its box and centred in it.
- `pip.crop` is the part of the host's video that fills the circle, in fractions: for no zoom take the full height and a square window (for a 16:9 file `[0.2188, 0.0, 0.7813, 1.0]` centred, moved to the host's face), so the full height of the host is the full height of the circle.
- Show the whole screen recording in its box and do not zoom on it; to point at something, add an `OVL` with a highlight box.
- `bg` is a picture the size of the frame (drawn with Pillow in the toolkit's Python, saved in `CLAUDE_VE/`): the background, a ring around the circle and a shadow under the screen.
- Since toolkit 1.4.0 the box, the rounded corners, `bg` and the host circle are part of the project, one host clip per kept piece.
  They show in `ve.py frames --project` exactly as the user will see them.
- Show the host alone (`H`) while the host talks to the camera, and the recording layout while the host works on the device.

### plan.txt

Every `ve.py plan` run writes the full report to `CLAUDE_VE/plan.txt` (the summary, one row per visible shot and every warning) and prints a short version.
Read the summary line first: it counts the graphics, b-roll, hits and overlays and gives the mean shot length.
A `<-- long` row is a shot over 3.2 s that needs a cutaway, a `<-- short` row one under 0.6 s.
A `WARN` names the `VIS`, `OVL` or `HITS` entry as written and says what happened to it:
an anchor in cut audio or after the last kept audio, an anchor within 8 frames of a jump cut, two entries on one frame, an unknown kind, an unknown part, a missing graphic or b-roll, a slot longer than its clip or graphic, a host piece shorter than `min_framing_frames`, a host piece under 0.6 s after a graphic (the cover runs on to the next cut), a graphic or b-roll used more than twice, and an overlay that lies over a full-screen graphic.
Fix the cause in `timeline.py` and plan again until nothing you did not intend is left.

### Reviewing what the user will see

`ve.py frames "<MAIN_FOLDER>" --project` (after `ve.py hf`) renders still frames of the real HyperFrames project, the same page the user opens on the timeline, into `CLAUDE_VE/frames_project/` together with a contact sheet.
`--times 12,40.5` picks the moments (seconds of the edit) and `--every 20` one frame every 20 seconds; without either it takes one frame inside every graphic, b-roll, overlay and hit (two in one of 5 seconds or more) and a few host frames, at most 40.
`--res` is 720 (the default) or 1080.
It prints one line per frame (`t=1.50s  g-1 graphic "Title"  -> <file>`), then the `WARN` lines, the contact sheets (`sheet: <file>`, 20 frames each) and a summary.
Its `WARN` lines say what looks wrong: a full-screen graphic or b-roll that shows the host through it, a black frame, or a full-screen frame identical to the previous one of another clip.
A `WARN` that the project is older than `build/timeline.json` means: run `ve.py hf` again first.
Look at the contact sheet and at single frames with `sheet.py` or by opening the files, then fix your own edit in `timeline.py` or in the graphic, plan, rebuild and look again, until the frames show a clean edit with graphics, hits and layouts where you meant them.
`ve.py frames` without `--project` makes one still per shot through the toolkit's own compositor; it is faster but is not the project.

## The HyperFrames project (`ve.py hf`)

`ve.py hf <video folder>` writes `<video>/output/<video folder name>.hf/`, a HyperFrames project that follows the profile of SPEC section 10.
`ve.py review` is the same command.
The server plays the project on a timeline, lets people hand-edit it and renders it later.
`ve.py hf` itself never renders anything.
It reads `CLAUDE_VE/build/timeline.json`, which `ve.py plan` writes, so run `plan` first; `gfx`, `broll` and `build` are not needed.
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
| Synced B-roll | one clip per kept A-roll piece on track 1; with a layout (box, rounded corners, `bg`, host circle) a host clip whose composition holds the background, the screen and the host in a circle |
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
What cannot be represented is dropped with a plain warning (the layout of synced B-roll, with its background and host circle, is carried since toolkit 1.4.0):
a graphic resumed part-way, and the loudness levelling and limiter of the final mix (the server does that).
HyperFrames is pinned in `vekit/tools.py` (`hyperframes@0.9.80`), the same version as the server's.
HyperFrames 0.9 refuses a symbolic link that leaves the project folder, so the render work copies of `ve.py gfx` and `thumbs.py` get `shared` as a tree of hard links.
Their work folders (`vekit/scratch.py`) are removed with retries and never raise, because on Windows Chrome or ffmpeg may still hold a file for a moment; the cache key of a graphic is written as soon as its file is in place.
Every render of the toolkit (`gfx`, `build`, `frames`, `qa`) is at 720 or 1080 and refuses 2160 with one line: the final render is the server's own `hyperframes render` of the project (SPEC section 12), which never calls the toolkit, so an edit never needs the 2160 graphics.
`VE_ALLOW_2160=1` is an administrator and test override that lifts the refusal.

Writing is safe and repeatable.
The project is built in `output/.<name>.hf.new`, checked, and then swapped in, with the old copy kept as `.<name>.hf.old` until the swap succeeds.
`meta.json` keeps its first `createdAt` across rewrites.
The command ends with a self-check of rules 1 to 8, 10 and 12 of the profile (a full-screen graphic needs an opaque background, rule 12; a path must be relative and inside the project, rule 10) and exits non-zero with plain sentences when something is wrong.
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

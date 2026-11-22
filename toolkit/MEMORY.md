# Video Editing Memory

This file is shared by everybody's edits on the server.
Any agent may append a lesson at the end.
A lesson belongs here only when it holds for every video.
Never write facts about one video or one channel here (names, numbers, products, prices, dates, creator wishes for one channel); those go in the video's own `CLAUDE_VE` folder or `info.txt`.
The rest of the toolkit folder is read-only; this is the only file in it you may change.
Keep each new lesson to a few sentences and put each sentence on its own line.

These are lessons from AI-assisted editing of talking-head + b-roll videos (English or Hindi narration, YouTube).
Read this before starting a new video.
Channel-specific choices live in the channel style that VidAI gives you, not here.
The commands and the order of work are in `CLAUDE.md`.

## Where things live

- The toolkit (`TOOLKIT_FOLDER`) keeps only what every edit needs: code (`ve.py`, `vekit/`), design kits, reusable templates, sound effects.
  It is read-only.
- The video folder (`MAIN_FOLDER`, your working directory) keeps everything for that one video in `CLAUDE_VE/` (project.json, timeline.py, transcripts, audio, its graphics, builds, plans, facts) and the deliverables in `output/`.
- Never create helper folders anywhere else.
- Per-video graphics reach the shared kit through a `shared` folder that the toolkit makes for you when it renders; the templates say `shared/...`.
- Keep the folder layout in one module (`vekit/paths.py`) and store paths relative to the video folder in timelines, so a move needs only a re-plan.
- Verify a restructure by comparing per-frame hashes (`-f framemd5`) of the rendered shots and the mix hash before and after.
- A folder name with spaces or `&` works end to end; always quote paths in shell commands.
- Another session may be editing the same channel at the same time.
  Check with `find -newer` before touching shared files, and keep per-video helpers (for example `v.css`, `v.js`) inside the video folder.
- When several sessions work in one place, a change to a shared build script by one session can silently change another video's cut.
  Keep per-video behaviour behind per-project settings (project.json or timeline flags), never by changing shared defaults.

## The result

- The deliverable is the HyperFrames project that `ve.py hf` writes into `PROJECT_FOLDER` (the profile is described in `CLAUDE.md` and in the instructions VidAI sends).
  People then play it on a timeline, change it by hand and render it later.
- Never render a video file of the edit yourself, for any reason.
  The toolkit's own short technical renders are fine: `ve.py frames`, `ve.py qa`, audio checks, thumbnails.
- Every motion graphic is its own `compositions/<id>.html` made from a template with variables, and `edit.json` records template and variables, so a graphic can be re-created later from them.
- `index.html` holds no animation, every clip is a direct child of the root, and originals are linked and never changed.
- Run `CHECK_COMMAND` after every change to the project and fix every error before you write `[OUTPUT COMPLETED]`.
- What `ve.py hf` cannot carry over is printed as a plain warning: the background and picture-in-picture of a synced b-roll layout, a graphic resumed part-way, and the final loudness levelling (the server does that).
  B-roll push, pull and drift motion and the 8 ms audio de-clicks are carried over.
  Plan around the warnings; do not try to patch them into `index.html`.
- A b-roll with motion becomes a small host composition with the video inside it; a hand trim of such a host changes where it starts but not which part of the inner video plays, so choose the in-point carefully before export.
- HyperFrames 0.9 serves the project folder to its browser and answers 404 for a file reached through a symbolic link that leaves the folder.
  The toolkit therefore makes its `shared` folder from hard links; do not replace it with a link by hand.
- A volume lane (`data-automation`) multiplies `data-volume` in HyperFrames 0.9; never write the same gain in both.
- The toolkit pins one HyperFrames version; newer "Craft" advice from an installed copy may not match the pinned one, so treat it as advisory.
  Cards under 2 s cannot satisfy a 2 s line rule.

## The machine and the limits

- The toolkit picks encoders and the speech backend for this computer by itself; do not choose them.
- It obeys the `LIMITS:` line of VidAI's message through `VE_CPU_CORES` and the GPU slot files.
- Never start heavy programs in parallel on your own (speech recognition, graphics renders, ffmpeg runs); run the toolkit's commands one at a time and let them use what they are given.
- NEVER run many speech-recognition processes at once: 8 parallel runs (about 3.6 GB each plus GPU buffers) froze a creator's computer.
  Let the toolkit limit them; a 30-minute raw take transcribed in about 13 minutes with two parts in parallel, and 23 minutes of audio in 7 minutes with the chunk pass split at a silence.
- Speech models are downloaded once, which takes a few minutes; budget for it.
- If a shared model cache loses weights to another process, transcription hangs at "Fetching ... files" with 0 % CPU; run it offline (`HF_HUB_OFFLINE=1`) so it never waits on the network, and report the missing weights in `info.txt`.
- ffmpeg builds differ: this one may have no `drawtext` (label contact sheets with Pillow), no `vid.stab` (use `deshake=rx=64:ry=64:edge=mirror` on the needed range only), and no `-vsync` (use `-fps_mode`).
- `ffprobe -count_frames` on a huge file decodes everything; compare frame counts from metadata or a short decode instead.
- Decoding a long 60 fps screen recording for a frame-difference map takes minutes even at `fps=4`; start it early (it is cached).
- Shell: zsh does not word-split unquoted `$var` in loops and `"$i:layout"` applies the `:l` modifier (write `${i}:layout`).
  Use arrays, functions or Python for multi-argument loops.
- Do not use `cd dir; rm -f dir/*` style globs; delete generated files by explicit absolute paths.

## Pipeline that worked

- Use ffmpeg for all footage work (cuts, punch-ins, b-roll conform, audio) and a browser-based renderer (HyperFrames: HTML + GSAP) for graphics.
- Rendering a long timeline entirely in a browser renderer is slow and fragile; build graphics as short clips instead.
- Graphics render as ProRes 4444 with alpha: transparent for overlays, opaque for full-screen cards.
- Author graphics at 1920x1080 (1080x1920 for vertical) and render at 2x with `--resolution landscape-4k` or `portrait-4k` when needed; one layout then serves both sizes.
- Build one template per graphic type driven by variables, plus a JSON spec of items; new text then needs no HTML edits.
- Keep the whole edit as data (a timeline of kept segments, visuals anchored to raw timestamps, overlays) and generate everything from it.
- Anchor b-roll and overlays to raw source timestamps of spoken words, not to output times; anchors then survive changes to cut points.
- Prove a shared-toolkit change is backward compatible by planning other videos with the old and the new code and comparing the JSON.
- A fast path: extract audio and start both transcription passes first, start the fact-check in parallel, and plan while they run.
- Cache rendered pieces by the command plus the size and mtime of every input file; a re-rendered graphic at the same path otherwise leaves stale results.
- `gfx.render_one` caches on the composition sources; a product image replaced after a render needs a forced re-render of the graphics that use it.
- Partial renders: filter `gfx.jobs_for()` by name and call `gfx.render_one` directly; a filter like `price_*` also catches `price_up_17`.
- Re-rendering the same composition is not always bit-identical (GPU rasterisation of gradients); skip graphics that are already up to date.
- Cutaway animations should have no exit and keep moving to the last frame; size each slot to at most the animation length so nothing freezes.

## Transcription (Hindi / Hinglish)

- Whisper falls into repetition loops ("अब अब अब...", "प्रश्न पर प्रश्न पर...") over long pauses, look-away pauses and retake gaps.
- Fix: detect silences (ffmpeg `silencedetect`, about -38 dB, 0.35 s), transcribe each speech chunk separately with `condition_on_previous_text=False`.
- Use `temperature=0.0` only; the default temperature fallback produced garbled English on Hinglish chunks.
- Pass a Hindi `initial_prompt` that contains the English tech words you expect; it fixes script and spelling a lot.
- On very short clips the initial prompt can leak into the output as hallucinated text (for example the default tech prompt); pass a neutral, video-specific prompt for short windows and do not trust short-window results blindly.
- Keep both the full first pass and the chunked pass; each recovers words the other misses.
- Latin brand and tech terms are often misheard in Hindi mode ("Qi2" became "चीटू", "MagSafe" became "maxif"); never copy them from the transcript to the screen.
- Hindi-mode Whisper mangles English sentences in a Hinglish edit; check English lines with `language="en"`, also numbers (English mode reads numbers reliably).
- Detect the language with `ve.py lang` or `--lang auto` (three windows spread over the audio), never with your own code; the first 30 s alone can say Hindi because of crew chatter between takes.
- A script or transcript from the creator speeds this up a lot: correct spellings, chapter titles, and a faster alignment pass instead of a full transcription.
- `transcribe.py` and `vekit.qa_transcribe` take `--lang en`; English synthetic voices transcribe almost perfectly, but a word can still be missing (check gaps in the energy envelope).
- Whisper output stops after about 30 s of audio per call; transcribe long edited blocks in windows under 30 s when checking a cut.
- Whisper prints words as start|word|end; the first word's start in short windows is often just the window start, and chunk-pass first words can start up to 1.3 s before the real onset.
  Take in-points from the energy envelope, not the word time.
- Whisper word end times are often early, especially before a pause and on slow decays.
- Both passes can silently drop 10+ s of continuous speech or garble a passage the other pass gets right.
  Before treating a gap as a retake or silence, check the 100 ms RMS and the other pass.
- Chunk-pass gaps longer than a few seconds were usually silence that Whisper filled with loops; confirm with RMS.
  A 100 ms RMS print of the whole file separates silence (-90 dB) from speech in seconds.
- A very long word duration in either pass (a 3.5 s "बनेगा", a 1 s "रुपए", a 0.8 s "अब") hides a whole phrase or retake.
- The chunk pass can compress a line to a few words; when a chunk line looks telegraphic, re-transcribe that raw window alone before choosing the out-point.
- `windows.py` (0.3 s silence prepended, pieces under 4.5 s, one model load) recovers looped ranges in about a minute or two; it asserts 16 kHz mono, so downmix a mix with `-ac 1 -ar 16000` first.
  Windows that start mid-number can drop lakh numbers silently; re-transcribe the straddled range directly.
- When passes disagree on a number, transcribe it alone from 2-3 staggered starts in Hindi AND English mode.
- Words that are coarticulated ("है-आप") have no clean cut point; drop the phrase or keep both words.

## Finding takes and cut points

- Raw A-roll usually contains several takes of each line; keep the last complete take unless it is clearly worse.
- A single clean take needs no take triage; a contact sheet shows whether the host looks at the camera throughout.
- Hindi retake cues to search for: "वापस लेते हैं", "रिपीट", "रिटेक", "पूरा पार्ट वापस".
- Directions to the editor spoken on camera ("यहाँ screen डालना", "next screen", "page number 7") mark where the creator wants chapter cards; use them, then cut them out.
  A part recorded at the end with such a note belongs next to the section it names; record the choice in the edit plan.
- When listing kept segments by hand it is easy to record the last word's START time as the segment end, which clips the final word.
  Decide per timeline whether segment ends are word ENDS or word STARTS and record it (`SEG_END_IS_WORD_START` in timeline.py).
- Always extend a segment end to the end of its last word.
- Robust snapping: extend the out point until the audio stays about 10 dB above the room-tone floor or below for 80 ms; do the same backwards for the in point; never cross into a neighbouring word.
- In a noisy room (a fan keeps pauses at -40 to -50 dB) the floor + 10 dB threshold finds no pauses; set project.json `energy_threshold_db` (for example -38).
  In a very quiet room (floor about -70 dB) the threshold can be about -55 dB; where two words touch, cut at the energy valley and never past the neighbouring word.
- Slow word decays run 0.3-0.8 s past Whisper's word end; put the out-point where the decay falls below about -45 dB.
  A -38 dB out-point clipped soft endings ("smartphone" lost "phone", "terms" lost its "s"); where the tail falls below about -60 dB, pin `{"out": "exact"}`.
- An onset before a stop consonant ("अपने": a short burst, then the closure) can make the planner start after the burst; pin the in-point in the silence before it.
- Where words touch, print the 5-10 ms envelope around every cut whose edge is above about -40 dB, pin the valley `exact`, and confirm by transcribing 3-4 candidate in/out points (0.3 s silence prepended).
  Transcribing every out-point at the chosen point and 0.35 s later (and every in-point 0.35 s earlier) finds clipped words in a minute.
- Check every in-point against the word's own start, not the window start; an onset can be lost when a segment begins 0.14 s late.
- A false start can hide inside a chunk ("Asus में build quality, जो इसकी build quality"); find the restart onset from the 10 ms energy envelope and pin it `exact`.
- A short word left before a join can vanish ("आप 3:31 से | आप order" heard as "331 order"); prefer cutting to the fluent second take of the whole phrase, at the quiet gap after the filler word.
- A quiet filler phrase coarticulated with a trimmed clause cannot be cut cleanly; drop it too and join at the next clean word.
- A line spoken much softer, laughing, and heard the same broken way from three staggered starts is better dropped than patched; record it in the plan with the raw range so it can be restored.
- Synthetic (TTS) voices have no room tone: planner snapping leaves only 0.07-0.15 s at joins; pin joins `exact` from the 5 ms envelope (speech bounds at -45 dB) and leave about 0.30 s within a paragraph and 0.36 s between paragraphs.
- Snap cut points to video frame boundaries and cut audio at the matching sample (48 kHz at 23.976 fps is exactly 2002 samples per frame; 1920 at 25 fps), so sync stays exact.
- The audio gets 8 ms fades at every cut (the exporter writes them as a volume lane unless the cut continues one source).
- Watch for verbal slips inside a good take (a missing "नहीं" that flips the meaning) and trim the clause when the sentence still reads naturally.
- Cut out every pause longer than about 0.3 s for Shorts; merge neighbouring segments when snapping leaves a gap under about 0.12 s, otherwise audio is doubled or a pointless jump cut appears.
- The plan merge rule reads frame gaps (`<= 3` frames), so `SPLIT_PAUSES` cuts inside a take still split.
- Never extend a host shot across a jump cut to absorb a sliver: the removed pause then plays under the next words (lip-sync error).
- The end hold needs real silence: when the closing line runs into the next sentence, end the line `exact` and append a 0.05 s piece of room tone from after the last word.
- `ve.py plan` "short host shot" warnings of a few frames are often breaths between two removed pauses; check the transcript words there and cut wordless ones out of the segments.
- A raw anchor on a part's LAST kept frame maps to the end of the edit (planner rule "next kept frame"); anchor 0.03 s inside the next segment instead, and end overlays on the last piece of a part one frame early.
- Anchors that land a few frames from a jump cut create slivers; snap anchors within about 8 frames onto the cut.
- A sentence-start host shot that the planner snaps onto a nearby jump cut moves, but a HIT anchored at the same raw time does not and can start inside the previous full-screen card.
  Anchor hits at the first raw time after the cut, or check lane overlaps in `build/timeline.json` before exporting.
  Overlays anchored 0.03 s inside a piece end 2 frames early when the piece borders a graphic.
- A cold open that reuses a line makes raw anchors ambiguous (they map to the first use); anchor the later visuals in raw time that only the second take contains.
- Back-to-back graphics with tiny host gaps create flash frames; let the earlier shot run on when the gap is under about 0.6 s.
- A 9-frame word piece between two pause cuts is absorbed by the preceding card; a pop-up anchored on it overlaps the card, so anchor it after the next cut.
- Verify the edit end to end: re-transcribe the edited voice track (in 15-20 s windows) and read it for clipped words, doubled words and leftover retake fragments.
  This found, in many edits, tails clipped by early word ends, tails of dropped words left at in-points, false starts inside kept ranges and retakes hidden in one long word.
  A window ending exactly at a snapped point hallucinates; re-transcribe with the out-point 0.3 s later before believing a word is clipped, and check the 20 ms envelope at the cut.

## Pacing rules that worked for long videos

- Average shot length around 2.5-3 s.
- At the start of each new sentence show the host for 1.5-3 s, then cut to b-roll or a graphic.
- Hide jump cuts on the host by alternating wide framing and a punch-in of about 115-120 %, centred on the face.
- Flag shots shorter than about 0.9 s (accidental flashes) and longer than about 5.5 s (needs a cutaway); deliberate holds such as data cards are fine.
- Absorb slivers under about 10 frames into the previous shot.
- Host pieces of a few frames between jump cuts flash wide/tight; project.json `min_framing_frames` (for example 12) gives them the neighbouring piece's framing.
- For a 20-minute edit, generate the shot list from rules (sentence starts, cover zones, graphic ranges) in record time instead of placing hundreds of shots by hand; keep the rules in a per-video script.
- When a host speaks without pauses, "break long graphics at sentence starts or jump cuts" finds nothing; fall back to the word start nearest the target interval.
- Long graphics can be broken by host shots at sentence starts and resumed with `G:<name>@<sec>`; the graphic's clock keeps running, so cue tables stay valid.
  Automatic breaking inside timeline.py (any piece over 7.5 s gets a 1.8 s host shot near its middle) took 50 graphic shots of 8-19 s down to 7.4 s; offsets come from the previous plan, so plan twice.
  Note that a graphic resumed part-way cannot be carried into the project; it plays from its start, so keep such graphics short.
- When a cut lands inside a graphic that agents already synced, do not edit the animation: resume it at its authored clock right after the cut (a JUMPS table in the shot generator).
- Chapter cards should have a fixed length from their anchor (about 2.8 s), not a word-to-word span.
- Phone b-roll at a higher rate than the timeline plays slowed (for example 30 fps in a 23.976 edit at 80 %); b-roll much slower than the timeline plays in real time, not "every source frame once", or it fast-forwards.
- Give locked-off b-roll a slow push-in (about 100 % to 106 %) so it never looks frozen.
- When a b-roll slot is longer than the clip, move the in-point earlier before resorting to freezing the last frame.
- Clips of phone UI animations often show the animation only briefly; sample frames to find the exact window before choosing an in-point.
- Per-clip frame-difference prints (5 fps, 64x36) give every action window of tabletop b-roll in seconds; the first couple of seconds of a handheld clip are often a camera bump, not action.
- File names of b-roll describe the clip, not the moment ("mixing ..." showed a still table for 23 s); sample every 2 s with timestamps before choosing in-points, and check that the ingredient matches the step.

## B-roll handling

- File names are only partly descriptive (camera names like `C9768.MP4` say nothing); make a contact sheet of 4 frames per clip and look at every clip before planning.
- Write a short catalogue (id, product, what happens, frame rate, duration) and plan from that.
- Check frame rate and colour transfer of every clip with ffprobe; mixed 23.976/30 fps and 8/10-bit sources are normal.
- For text cards over b-roll, shift the b-roll to the right half on a dark background with a feathered left edge (alpha mask), so text sits on the clear side.
- Name shot types in the timeline (host, b-roll, shifted b-roll, full graphic, split screen) so the code stays generic.
- Each b-roll use has its own usable window (`lo`/`hi`) in the timeline; the planner moves the in-point earlier or warns when a slot outgrows the window.
- BROLL keys: `"rotate"` (degrees, for example 180 for an upside-down overhead clip), `"crop": [x0, y0, x1, y1]` (a 9:16 window of a 16:9 frame, aspect checked), `"scale"` and `"pos"` (percent of the frame height, +y up) to punch in on the action.
  Check a punch-in does not crop a label at the frame edge.
- Stabilize only the needed range (`deshake` as above), write it as ProRes, and point the BROLL entry at the stabilized file inside `CLAUDE_VE/broll/stab/`.
- A camera can store vertical footage sideways with NO rotation flag (a landscape file with the head at the right).
  project.json `"aroll_rotate": {"a1": 270}` (clockwise degrees) handles it; B-roll uses `"rotate": 270` per entry.
  Head on the RIGHT of a raw frame needs `transpose=2` (= 270); `transpose=1` gives upside-down frames, so look at one still before briefing anyone.
  `ve.py prep` takes width and height from the raw stream, so set `"width"` and `"height"` to the upright size together with `aroll_rotate` right after prep.
  A tiny upright proxy (540x960, inspection only) makes a good contact sheet.
- Phone-shot vertical A-roll is often stored 3840x2160 with a -90 rotation tag and plays upright; check `stream_side_data` rotation before planning any reframing.
- Landscape camera A-roll for a 9:16 Short can be reframed with a full-height crop centred on the median face x; check the host's eyeline against the camera before treating looks as cover.
- Mixed A-roll rates: pick the host rate for the timeline; a slower part is conformed with `fps=<rate>:round=near` (frame repeats) so the timeline stays one rate.
- A seated desk framing: the empty backdrop above the head (top about 23 %) is the best text zone.
  Hands and products occupy the middle, and phone UIs cover the bottom part of a vertical frame.
- When the host holds products most of the time, real "b-roll" can come from the A-roll itself: crop about 2x onto the product with the crop top below the chin so mismatched lips never show, plus a slow push-in.
  For a close-up of the same moment, use a synced crop so any visible lips stay in sync.
- A close-up of the live host (about 1.3x) must keep the face below the caption zone; compute the crop top from the face position.
- Tablet / phone screen recordings with a host: use synced layouts (`pip` key: A-roll file, sync offset, face crop, box) with the host in a circle next to the screen; ring, bezel and chapter label live in a background plate rendered once per layout.
  Show the full screen, do not zoom on the tablet, highlight what the host talks about, and give the host circle the full video height.
- A screen recording made during the take is a second camera angle: sync it by cross-correlating 10 ms RMS envelopes of the two audio tracks, and let each b-roll slot follow the A-roll's jump cuts (`"sync"` b-roll).
- iOS screen recordings are variable frame rate (nb_frames / r_frame_rate gives a wrong length); pick frames by timestamp and take the length from the container duration.
- An iPhone-only app recorded on an iPad sits in the middle with black bars; measure the app bounds from column / row means and crop to it.
  A website opened in Safari during the recording is full width; detect such windows and give them their own crop.
- Two alternating layouts kept a 20-minute demo lively: a phone-shaped device beside a chapter label, and a zoomed band chosen from where the screen changes (frame-difference energy per horizontal band; ticking prices give about 0.1, real taps and scrolls above 0.3).
- 4K ProRes for many minutes of screen-recording b-roll fills the disk; hardware HEVC at 50 Mbps is plenty for UI footage.
- Overhead demos can be recorded upside down; a slower, upside-down part in a faster edit gets an upright mezzanine of its own (flip both axes plus the rate conform) and project.json "aroll" points at it.
- Demo b-roll may not show the promised result (a card add that failed); check the end state of every demo before writing "done" ticks into overlays and flag it in `info.txt`.
- B-roll may not show the product being reviewed (compare it with official photos); keep it out of the product sections.
- Privacy pass on screen b-roll before planning: names on cards and in Settings, card numbers and CVV, notes apps with logins, Wi-Fi names, desk clips showing other channels' thumbnails.
  Give the catalogue the job of listing unusable ranges and pass them to the thumbnail work too.
  Cover personal data with colour-matched patches inside the overlay (under any dim layer), timed to the exact screen-change frames.
  Verify privacy on the COMPOSITED frames (OCR of every 2nd composited frame of every demo shot, searching for the names found earlier), not on the overlay author's word.

## Hindi (Devanagari) text and fonts

- Render Devanagari through a real text-shaping engine (a browser); Pillow without libraqm cannot shape conjuncts and matras correctly.
- Mukta (Google Fonts, OFL) works very well: Devanagari and Latin designed to match, weights 200-800, clean at all sizes.
- Noto Sans Devanagari is a solid alternative; Poppins (OFL) shapes Devanagari well and gives a punchy tech look; Baloo 2 is a punchy display face for Shorts.
- System fonts like Kohinoor or Devanagari Sangam are less suited to bold video titles.
- Ship font files locally with `@font-face`; never rely on network fonts at render time.
  Use the kit classes rather than declaring `font-family` in a graphic's own style, or the compiler injects Google Fonts copies.
- Baloo 2's line box is about 1.6 em tall; size text boxes from measured glyph bounds (canvas `measureText` actualBoundingBox*), or matras and the reph poke out of solid blocks.
  Baloo 2 slabs fail `text_box_overflow` at line-height 1.15; use 1.66-2 with bottom padding.
- Check rendered frames for nukta letters (क़ फ़ ज़), conjuncts (र्ड, क़्क़, ज्ञ, र्भ) and matras; zoom in on a 4K crop.
- Give Devanagari headlines a line-height of at least about 1.12 (1.22-1.25 for most fonts) and some padding so top matras and descenders are not clipped.
- Keep tech terms, units and brand names in Latin script (Qi2, MagSafe, mAh, W, USB-C); viewers read and search them that way.
- Avoid glyphs the font may lack (emoji, circled digits); the middle dot "·" is fine in Mukta.
- Do not let titles break at a hyphen; for "A: B" titles, break after the colon.
- Keep pop-ups to 2-5 words and auto-shrink long ones (for example 72 to 60 px, then two balanced lines).
- Place overlays in the lower third or the empty top zone, away from the host's face; full-width layouts belong on full-screen cards.
- Never rotate a plus sign (at 45 degrees it reads as "x"); pulse it.
- Word-stagger titles built with a generic `words()` helper can trip `content_overlap` and lose coloured spans; write the word spans in the HTML and tween those, colouring the spans after splitting.
- `document.fonts.ready` can resolve before a weight that is only used by JS-built text has loaded; call `document.fonts.load("900 100px <family>")` for each weight before measuring or fitting text.
- Fit helpers must measure an inline-block text span, not a padded slab; `white-space: nowrap` on a fitted title is essential, or a wrapped long name never shrinks.
- Canva (when a creator asks for it) can pick a thin condensed font that garbles Devanagari; read every export at full size.

## HyperFrames gotchas

- Never put a CSS `transform` on a property that GSAP animates; use `fromTo` (lint error `gsap_css_transform_conflict`).
- Center with flex or inset, not `translate(-50%)`, on animated nodes.
- GSAP shifts an SVG element when the transform origin is given only in the end values of a scaled `fromTo`; put the same `svgOrigin` in both.
- `snapshot` overwrites the snapshots folder each run; copy frames you want to keep.
- Lint rejects `../` asset paths.
- Renders are cancelled if the parent process exits; run them from a live shell or a background job with stdin detached.
- Root `data-duration` is fixed at compile time; give each template type a fixed duration, and plan slot lengths with placeholder compositions (`data-duration` 12) before the final duration is known.
- When a graphic must stay on screen longer than its animation, freeze a frame just BEFORE the exit animation and play the exit at the end; freezing the last frame holds a faded-out card.
- `render` takes any frame rate natively (`--fps 25`, `24000/1001`); 23.976 graphics render at 24 and are re-timed 1:1 by the toolkit with a lossless two-step remux.
- `--format mov` gives ProRes 4444 with alpha (yuva444p12le); a 4 s 1080x1920 graphic renders in about 2 s, and in about 6 s at `portrait-4k`.
- A single-scene graphic needs no timed clips: a plain wrapper avoids the `nested_structure_needs_subcomposition` warning.
- Each render runs in its own temp copy of the project, so parallel renders never collide on `.hyperframes/`.
- Clean up only inside your own folders: one agent running `rm -rf */.hyperframes/artifacts/snapshots` from `gfx_src/` deleted other groups' snapshots mid-review.
- Read the full `hyperframes check` output, not only a final "OK"; layout warnings may not contain the word "warn".
- Check contrast against the kit before fanning out: white on a bright orange failed 3:1 and four agents patched it differently; fix shared colours once in the kit.
- A sheen drawn with `linear-gradient(100deg, ...)` on a tall, narrow box shows a hard vertical edge; use 90deg.
- Keep rotations of travelling elements within 20 degrees, or mark deliberate swings with `data-layout-allow-orbit`, or `check` warns `rotation_pivot_drift`.
- Background dots can drift above the frame on graphics of 4.5 s or more (`container_overflow`); change the seed.
- `clipPath` cuts off `box-shadow`, so wipe with pixel insets that include the glow (or keep the glow on its own layer).
- A caption bar over a white page needs `backdrop-filter: blur(14px)`; a caption that fades in fails the contrast check mid-fade, so slide it in; hide inactive lines with `visibility` (parked lines still fail contrast).
- A `$` drawn as SVG text inside overlapping icons fails the contrast check; draw glyph-like marks as paths.
- A highlighter bar with `z-index: -1` warns `negative_z_index`; put the text in its own positioned span.
- Labels split across `<br />` or `<span>` defeat a plain `sed`; grep the result after every text fix in a graphic.
- A camera push-in (1.06) grows edge text past the safe zone by the last frame; author text inside a slightly smaller box.
  A headline that scaled from 2x ran past both edges; entrances should grow from below 1x.
- A hook title that lands at 1.0 s is barely seen on a 1-2 s slot; write "key message readable by 0.9 s" into the spec.
- Channel kits live in `_shared/<kit>/` and enter a graphic's cache key only when it references them; never add channel material to the shared root.
- `remove-background` is a person / salient-object model: it fails on products lying on a table (kept flowers, lost the product) and drops products held in hand from a person cut-out.
  Cut rounded-rectangle products geometrically from an overhead still, and place product cut-outs into the host's empty hands for thumbnails.
- Screenshots of websites and circulars work best as HyperFrames graphics, not zoom-pan b-roll: the image on a "sheet", a camera that moves between targets, marker boxes that draw in on the words the host reads, and a one-line caption bar.
  Build one rig first (or use the kit's), then fan out; two agents building two rigs had to be aligned afterwards.
- Frames pulled for QA that are opaque ProRes 4444 graphics can be extracted directly; an `overlay` over a `color` source gave only the background colour.
  QA composites near the end of a clip need `setpts=PTS-STARTPTS` on both inputs, or the overlay silently disappears.
- ffmpeg `select` inside a filter_complex passed almost all frames and scrambled the numbering of an "every 2nd frame" dump; write every frame in order and pick files by index.
- `ffmpeg -sseof` is an INPUT option (before `-i`).

## Graphics at scale (several helpers)

- Building 30+ graphics with 4-7 parallel helpers worked with one written spec (contract + a table of slot, duration, spoken line, visual), a shared design kit, and one reference graphic built first.
- Plan with placeholder compositions first, then write the cue table (record-time offset of every word inside each slot, from the segment map) so helpers sync reveals to the voice without running the planner.
  A cue table needs hand-corrected words wherever the chunk pass hallucinated, and must map words through record time, not by raw offset from the slot start.
  Keep it up to date after trimming; a removed filler can move cues by 0.4 s.
- Write into the spec: no numbers on screen that the host does not say, spoken amounts pop to their value (no count-ups), no unsaid claims, never rotate plus signs.
- Helpers sharing the scratchpad overwrite each other's scripts; give each its own `scratchpad/<group>/`.
- Render each group at about 1080 as it lands and review a 4-frame strip per graphic; it catches label and fact problems early.
- A copied per-video script (for example `cues.py`) can carry the previous video's dropped-range filter or constants; check copied scripts for video-specific values.
- Write the spec's dates and rule names exactly (the live date of an old and a new rule next to the document date).
- Helpers can die mid-run on a usage limit; keep the critical path finishable by the lead.
- Tell research helpers never to send personal data (names, email addresses) in headers or queries, and to use the normal fetch and search tools (and the brand's own site as fallback), never a disguised browser identity.
- Give helpers exact paths (for example `assets/products.md`), or they finish without reading the fact flags.

## Pop-ups and text over the host

- Text over the A-roll must NEVER touch the host's head, hair or body.
  Never estimate the head top from a contact sheet: measure it with a person mask on every few frames under each pop-up, and compare with the pop-up's alpha extent over its slot (shadow included).
- Use a pop-up template with a zone above the head (`kc_hit_hi`-style, y 70-280 of 1920) and project `"hit_pos"` (position of all pop-up clips, percent of frame height, +y up) to lift them; force wide framing (`"HW"`) on every host VIS anchor that carries a HIT, since a punch-in pushes the head up.
  For a new set, put `"tight_anchor": [x, head_top]` in project.json so the punch-in keeps the head at the wide shot's height.
- Check the first `ve.py frames` sheet for pop-ups over hair before exporting; verify per frame, not per shot.
- Labels over ingredient b-roll: a hand and spoon enter from the top, so put labels below the bowl; look at a conformed frame before writing label placement into the spec, and check 3 composited frames per label (start, middle, end).
- Composite every overlay over the frame under it (spine frame at 15 % and 80 % of the overlay) before export: it catches boxes outliving their screen, boxes on the wrong icon and screens showing personal data.
- Define marks on a filmed phone screen in RAW time of the part (screen-change times measured from frame differences), never in record time; record-time marks drift after later cut-point fixes.
- Highlights "on what the host is talking about": map spoken terms to app elements with a short rule list, look the element up in the OCR of the frame that is on screen at that moment, and make each highlight its own transparent overlay clip (box plus slight dim) so people can edit them.
  Rules need context ("market 75-76 पर चल रहा" is the price, not the Market button).
- When the tablet takes priority over graphics, keep title and chapter cards whole and drop graphic pieces shorter than 2 s.

## Shorts (9:16)

- Treat phone-shot vertical A-roll as 2160x3840 after autorotate.
- Build graphics at 1080x1920 and render at `portrait-4k` only when asked; a 720 check can use the 1080x1920 renders scaled down.
- In a seated desk framing the empty backdrop above the host's head is the best text zone: tags and hits at y 90-330, captions at y 340-470 (1080x1920 layout).
- Full captions work best as one overlay track for the whole video, generated from phrases anchored to raw times.
- Cut out every pause longer than about 0.3 s; keep the video fast paced and under three minutes.

## Audio

- Lavalier A-roll is often the same signal on both channels; a mono signal duplicated to stereo measures about 3 LU louder, so measure loudness on the final stereo file.
- ffmpeg `loudnorm` silently switches to dynamic mode when the true-peak target cannot be met with a linear gain, which flattens the voice.
- The server does the final loudness levelling of the voice later; do not normalise, compress or clean the voice in the edit, and do not add background music.
- Keep sound effects subtle: whoosh into chapter cards, soft pop on pop-ups, click on a subscribe button; sound-effect levels are absolute, so keep them well below the voice.
- Sound effects can be synthesised with numpy/scipy (filtered noise sweeps, pitch-dropping sines) with a fixed random seed; no downloads needed.
- Audio QA needs no picture build: `ve.py audio` makes the mix and `vekit.qa_transcribe` reads it back.
- A very hot A-roll can be lowered with project.json `voice_gain_db`; it is applied at plan time, so re-plan after changing it.

## Facts and claims

- Check every number shown on screen against the official product page and recent launch coverage.
- When the host's claim disagrees with the official spec, flag it with sources in `info.txt` and let the creator decide; never silently change or add facts.
  A trimmed clause keeps its graphic ready for a restore.
- Check scope words too: a rule that applies only to some stocks is not "all shares".
- Compare every on-screen text with the spoken line: official product and feature names are fine, an unsaid claim is not.
- Show prices only when the host says them, with "लगभग" (approx.) when the host says "around".
- Mark illustrative charts clearly (for example "सांकेतिक") so they are not read as measured data.
- Spec claims depend on the exact listing; fact-check against the linked listing, not the model family.
- Product links can be stale or point to another brand than the host names; use them only when the video is about those products, report mismatches first, keep the spoken brand on screen and flag it in `info.txt`.
  When links change mid-edit, move the old set to `assets/products_old_links/` (never delete) and reuse cut-outs only for an identical product and variant.
- Hosts may say "this" about products they never hold up; check frames before planning host shots over product lines.
- Hosts name a pack type the listing contradicts; keep the audio, use the listing's name on screen, flag it.
- Ask fact checks for dates and document numbers, not only for the host's claims; old rules and new rules both help the thumbnail and description.
- A pasted brief can arrive truncated; fill the rest from channel defaults and say so at the top of `info.txt`.

## Thumbnails and meta

- Author thumbnails as 1920x1080 HyperFrames pages in `CLAUDE_VE/thumb_src/<n>/index.html`, render with `thumbs.py`, scale to 1280x720 (720x1280 for Shorts).
- Host cut-outs from `remove-background` need a cleanup pass (plant fragments on the shoulders, coloured hair fringe from the backdrop).
- Check numbers on thumbnails and titles against the transcript; helpers copy spoken ranges loosely.
- YouTube tags are limited to 500 characters in total.
- Thumbnails and `meta.txt` make good parallel work right after transcription.
- Read every thumbnail export at full size (Hindi text especially).

## Tools that exist only on some machines

- On a Mac (see the `MACHINE:` line) Apple Vision is available through small Swift programs.
  Head pitch per frame (`VNDetectFaceRectanglesRequest` revision 3, about 135 fps on 960x540 JPEGs): looking at the camera is about -7 to +4 degrees, looking down at a tablet about +15 to +25; pitch of 12 or more for at least 1 s finds "looking at the tablet" spans.
  Wrap every iteration of a long Vision loop in `autoreleasepool`; without it Vision silently returned no faces after about 4,400 frames.
  OCR (`VNRecognizeTextRequest`, accurate) reads app UIs almost perfectly; 1,600 frames in under a minute as 4 processes.
  Person segmentation (`VNGeneratePersonSegmentationRequest`, accurate, includes hair) AND-ed with a pop-up's alpha (`scale,format=rgba,alphaextract`) verifies text never touches the host; 532 frames in about 27 s.
- Without Vision use a person-segmentation model (for example rembg `u2net_human_seg`) and compare the pop-up alpha box with the top row of dark hair pixels (luminance below 45, at least 30 px per row, every 4th frame).
- Whatever the machine, never assume these tools exist; try them and fall back.

## Working with the creator

- The creator is not available to answer questions; make your best guess and record the choice in `info.txt`.
- Keep a timing log per step and exclude time spent waiting.
- Things the creator can do to speed up the next edit: record each section as its own clip and keep only the good take, name files by section, share the script with the screen titles, pause briefly before each retake.
- Parallel helpers work well for independent pieces (graphic templates, custom animations, sound effects, fact-check, thumbnails) once the shared spec and style are written down.
- Reuse templates, the build script and the sound-effect set across videos; most of the first video's time goes into building them.
- A sibling video with nearly the same recipe (same set, same channel) makes the whole pass fast: copy its project.json settings, scripts and spec structure, but strip anything video-specific.
- Edits that go into a note for the creator (`info.txt`) must say what was trimmed and where it can be restored.

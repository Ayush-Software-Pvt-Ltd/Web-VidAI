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
The commands and the order of work are in `CLAUDE.md`; the `timeline.py` contract, the graphic templates and the layouts are in `README.md`, section "Writing the edit".

## Graphics craft (read first)

- A full-screen graphic has an opaque background over the whole frame; otherwise the host shows through it and `ve.py hf` refuses it (rule 12).
  The templates of `ve.py graphic` already do this; a hand-written page must set a colour, gradient or picture on its first child.
- Motion goes on to the last frame: no exit animation, no frozen end, so a card never sits still and never fades out to nothing.
  Size the slot to at most the length of the graphic.
- Keep text inside the safe zone and BIG and BOLD; a push-in or a scale from 2x ends past the edges, so entrances grow from below 1x and text sits in a slightly smaller box.
- The key message must be readable within 0.9 s; a 1-2 s slot has no time for a slow title.
- Density wins: one full-screen graphic or b-roll about every 20 to 30 seconds over the whole video, not all in the first minutes.
  A long talking head with only a few graphics at the start reads as a failed edit.
- Use several templates (title, stat, list, quote, compare, image) and change `seed` and the accent so two graphics in a row never look alike.
- Show only numbers and claims the host says: spoken amounts appear at their value, no unsaid claims, never rotate a plus sign (at 45 degrees it reads as "x").
- Look at the graphic in `ve.py frames --project` before you call it done: a graphic that shows the host through it, a black frame or a graphic that stops moving before its last frame is your bug.

## Density, pacing and keyword hits

- Average shot length about 2.5-3 s; flag shots under 0.9 s (accidental flashes) and over 5.5 s (they need a cutaway); a deliberate hold such as a data card is fine.
- At the start of each new sentence show the host for 1.5-3 s, then cut to b-roll or a graphic.
- Hide jump cuts on the host by alternating wide framing and a punch-in of about 115-120 %, centred on the face.
- Put a keyword hit (`HITS`) on every key term, number or product name while it is said: 2 to 5 words, 1 to 2.5 s, anchored on a word of the take that stays in `SEGS`.
- Anchor everything on raw timestamps of spoken words, never on output times; anchors then survive changes to cut points.
- The planner moves a sentence-start host shot onto a nearby jump cut but not a hit at the same raw time, which can start inside the previous full-screen card; anchor hits at the first raw time after the cut.
- Anchors a few frames from a jump cut create slivers; put them on the cut.
  An anchor on a part's last kept frame maps to the end of the edit; anchor 0.03 s inside the next segment instead.
- Back-to-back graphics with tiny host gaps create flash frames; let the earlier shot run on when the gap is under about 0.6 s.
- Never extend a host shot across a jump cut to absorb a sliver: the removed pause would play under the next words (lip-sync error).
- Cut every pause longer than about 0.3 s for a Short; a Short stays fast and under three minutes.
- Long graphics can be broken by host shots at sentence starts and resumed with `G:<name>@<sec>`; the project plays a resumed graphic from its start, so keep graphics short instead.

## Text and graphics over the host

- Text over the A-roll must NEVER touch the host's head, hair or body; look at `ve.py frames --project` stills for every hit, not at one frame per video.
- Use a hit template with a zone above the head and lift it with project `hit_pos` when the head is high; a punch-in pushes the head up, so force wide framing (`HW`) where a hit sits.
- In a seated desk framing the empty backdrop above the head (top about 23 %) is the best text zone; hands and products fill the middle, and phone UIs cover the bottom of a vertical frame.
- Check an overlay over the frame under it at 15 % and 80 % of its length: it catches boxes outliving their screen, boxes on the wrong icon and screens showing personal data.

## Screen recordings and the host circle

- A phone or tablet recording made during the take is a second camera angle: make it a `sync` b-roll with a layout (`box`, `radius`, `bg`) and the host in `pip`, a circle next to the screen.
- Show the whole screen and do not zoom on it; the host circle gets the full height of the host video (a square crop of the full height, no zoom); point at things with a transparent `OVL` highlight box.
- Find the sync offset by comparing the loudness envelopes (10 ms RMS) of the two sound tracks.
- Show the host alone while the host talks to the camera, and the layout while the host works on the device.
- Define marks on a filmed screen in RAW time of the part, never in output time, which drifts after later cut fixes.
- A privacy pass comes before planning: names on cards and in Settings, card numbers, logins, Wi-Fi names, other channels' thumbnails; cover them with colour-matched patches and check the composited frames, not the author's word.
- A demo may not show the promised result; check the end state before writing ticks into overlays, and flag it in `info.txt`.

## The result

- The deliverable is the HyperFrames project that `ve.py hf` writes into `PROJECT_FOLDER`; people play it on a timeline, change it by hand and render it later.
- Never render a video file of the edit yourself; the toolkit's own `ve.py frames --project`, thumbnails and audio checks are fine.
- Every graphic is its own `compositions/<id>.html` with its template and variables in `edit.json`, so it can be re-created later.
- `index.html` holds no animation, every clip is a direct child of the root, originals are linked and never changed, and paths are relative and inside the project (rule 10).
- Run `CHECK_COMMAND` after every change to the project and fix every error before you write `[OUTPUT COMPLETED]`.
- `ve.py hf` prints a plain warning for what it cannot carry over: a graphic resumed part-way and the final loudness levelling (the server does that).
  Plan around the warnings; do not patch them into `index.html`.
- A b-roll with motion is a small host composition with the video inside; a hand trim changes where it starts, so choose the in-point carefully.
- HyperFrames serves the project folder to its browser and answers 404 for a file reached through a symbolic link that leaves the folder; the toolkit makes `shared` from hard links, so never replace it by a link.
- The toolkit pins one HyperFrames version; newer advice from an installed copy may not match, so treat it as advisory.

## The machine and the limits

- The toolkit picks encoders and the speech backend for this computer; do not choose them, and it obeys the `LIMITS:` line of VidAI's message.
- Never start heavy programs in parallel on your own (speech recognition, renders, ffmpeg); 8 parallel speech runs froze a creator's computer.
- Quote every path (folder names with spaces or `&` work end to end), and delete generated files only by explicit absolute paths inside your own folders.

## Transcription

- Whisper falls into repetition loops over long pauses, look-away pauses and retake gaps; `transcribe.py` and `windows.py` already split at silences and run each speech chunk alone.
- Latin brand and tech terms are misheard in Hindi mode ("Qi2" became "चीटू"); never copy them from the transcript to the screen, and check English lines and numbers in English mode.
- The language comes from `ve.py lang` or `--lang auto`, never from your own code; the first 30 s alone can mislead because of crew chatter.
- Word times lie: starts of the first word in a window are often the window start, ends come early before a pause, and a very long word duration hides a whole phrase or retake.
  Take in-points and out-points from the energy envelope.
- Both passes can silently drop 10+ s of speech; before treating a gap as silence, check the 100 ms RMS and the other pass.

## Finding takes and cut points

- Raw A-roll often holds several takes of each line; keep the last complete take unless it is clearly worse.
- Hindi retake cues: "वापस लेते हैं", "रिपीट", "रिटेक", "पूरा पार्ट वापस".
- The end of a `SEGS` entry is the END of its last word; extend it until the audio stays about 10 dB above the room-tone floor or below for 80 ms, and never into a neighbouring word.
- In a noisy room set project.json `energy_threshold_db` (for example -38); in a very quiet room it can be about -55.
- Slow word decays run 0.3-0.8 s past Whisper's word end; where a soft ending clips, pin `{"out": "exact"}` at the valley of the 5-10 ms envelope.
- Where words touch, cut at the energy valley, and check by transcribing 3-4 candidate points with 0.3 s of silence prepended.
- A line spoken much softer or garbled from three starts is better dropped than patched; note the raw range in `info.txt` so it can be restored.
- Snap cut points to frame boundaries so sync stays exact; the audio gets 8 ms fades at every cut that does not continue one source.
- The end hold needs real silence: end the closing line `exact` and keep about 0.05 s of room tone after the last word.
- Verify the edit end to end by re-transcribing the edited voice (`ve.py audio` then a 15-20 s window pass) for clipped words, doubled words and leftover retakes; re-transcribe with the out-point 0.3 s later before believing a word is clipped.

## B-roll handling

- File names only partly describe a clip (camera names say nothing, "mixing" showed a still table for 23 s); look at a contact sheet of every clip (`sheet.py`) and write a short catalogue (id, what happens, duration) before planning.
- Each use has its own usable window (`lo`, `hi`); the planner moves the in-point earlier or warns when a slot outgrows it.
- Give locked-off b-roll a slow push (`"motion": "push"`) so it never looks frozen, and move the in-point earlier before freezing a last frame.
- `rotate` fixes footage stored sideways with no rotation flag (look at one still first); `ve.py prep` takes the size from the raw stream, so set `width` and `height` to the upright size with `aroll_rotate`.
- Phone-shot vertical A-roll is often stored with a rotation tag and plays upright; landscape A-roll for a 9:16 Short can be reframed with a full-height crop centred on the face.
- When the host holds products most of the time, a 2x crop onto the product (below the chin, with a slow push) is real b-roll; use a synced crop for a close-up of the same moment.
- Websites and circulars work best as a graphic: the image on a sheet, a camera that moves between targets and marker boxes on the words the host reads.
- `remove-background` is a person model and fails on products on a table; cut rounded products geometrically.

## Hindi (Devanagari) text and fonts

- Render Devanagari through a browser; Pillow without libraqm cannot shape conjuncts.
- Mukta (OFL) matches Latin and Devanagari at weights 200-800; Noto Sans Devanagari and Poppins are good alternatives, Baloo 2 is a punchy display face.
- Ship fonts locally with `@font-face`, use the kit classes instead of declaring `font-family` yourself, and never rely on network fonts.
- Size text boxes from measured glyph bounds; give Devanagari headlines a line-height of at least 1.12-1.25 (Baloo 2 needs 1.66-2) and padding so matras are not clipped.
- Call `document.fonts.load("900 100px <family>")` for each weight before measuring or fitting text, and fit an inline-block span with `white-space: nowrap`.
- Check nukta letters, conjuncts and matras in a zoomed crop; keep tech terms, units and brand names in Latin script.

## HyperFrames gotchas

- Never put a CSS `transform` on a property GSAP animates; use `fromTo`, and center with flex or inset.
- Lint rejects `../` asset paths; read the full `hyperframes check` output, not only a final "OK".
- Root `data-duration` is fixed at compile time; every template has a fixed duration.
- Keep rotations of travelling elements within 20 degrees, or mark swings with `data-layout-allow-orbit`.
- `clipPath` cuts off `box-shadow`; wipe with pixel insets that include the glow.
- Clean up only inside your own folders.

## Audio

- Do not process the voice and add no background music; the server levels the loudness later.
- Keep sound effects subtle: whoosh into graphics, soft pop on hits, a click on a button; the planner adds whooshes and pops itself.
- A very hot A-roll can be lowered with project.json `voice_gain_db`, applied at plan time.

## Facts and claims

- Check every number on screen against the official product page; when the host's claim disagrees, flag it with sources in `info.txt` and never silently change facts.
- Compare every on-screen text with the spoken line: official names are fine, an unsaid claim is not; show prices only when the host says them.
- Mark illustrative charts clearly so they are not read as measured data.
- A pasted brief can arrive truncated; fill the rest from channel defaults and say so at the top of `info.txt`.

## Thumbnails, meta and the creator

- Author thumbnails as 1920x1080 pages in `CLAUDE_VE/thumb_src/<n>/index.html`, render them with `thumbs.py`, scale to 1280x720 (720x1280 for Shorts), and read every export at full size.
- Host cut-outs from `remove-background` need a cleanup pass (shoulder fragments, backdrop-coloured hair fringe); YouTube tags are limited to 500 characters in total.
- The creator is not available; make your best guess, record the choice in `info.txt`, and say what was trimmed and where it can be restored.
- On a Mac only (see the `MACHINE:` line), small Swift programs can use Apple Vision for face pitch, text reading and person masks; never assume they exist, and without them use a person-segmentation model and compare the pop-up box with the top row of dark hair pixels.

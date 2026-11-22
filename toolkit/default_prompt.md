In the MAIN_FOLDER (your working directory, inside the CHANNEL_FOLDER) there are A-roll(s) of a video.
Edit them into a video for YouTube.
The result is the HyperFrames project that `ve.py hf` writes into PROJECT_FOLDER; it is described below.
Never render a video file of the edit.

Style:
Follow the channel style that VidAI gives you in its message for the text content, colours and look.
It is made for this channel and this VIDEO_TYPE.

A-roll:
A-rolls are the video files in MAIN_FOLDER itself.
The audio of the edit comes directly from them.
Try to keep the A-roll cuts to shorter duration when there can be a video b-roll or programmatically created b-roll possibility.

In A-roll, when the host is looking down (maybe to read some specs etc.) or not looking in the camera, it is preferred that we use a b-roll there.

If and when there is one A-roll for a host and another A-roll for a phone or a tablet screen recording, make sure you show the host when the host is talking to the camera.
When the host is doing something on the phone or tablet, show the tablet or phone together with the host on screen.
Keep the tablet app in full view and do not zoom on the tablet.
Highlight the parts which the host is talking about on the app.
Put the host next to the phone or tablet in a circle, and make sure the full height of the host video takes the full height of the circle (no zoom).
Use the synced screen layout for this: the recording is a b-roll with `sync`, `box` and `bg`, and the host is its `pip` circle (README.md, "Writing the edit", "Screen recordings with the host in a circle"); the project carries the layout, so you see it in `ve.py frames --project`.

B-roll:
There is a B-roll folder named BROLL_FOLDER in the MAIN_FOLDER.
BROLL_FOLDER may have more sub folders for product specific b-rolls.
BROLL_FOLDER may be completely absent or empty as well; in that case create your own b-rolls with programming.
Files in the b-rolls are named in a way which tells what is in the b-roll.
These can be images or videos.
Use them when you think it is appropriate.
Try to use various types of motions, transitions, effects and parallax on images so that they do not look like static images in the video.

Some of the b-rolls may require stabilization.
If you think they do, stabilize them before using them as b-roll.

Create B-rolls Programmatically:
Create lots of full screen B-rolls with animations which can be used for various cuts in the video.
These must be created programmatically, as motion graphics, each from a template with variables: use `ve.py graphic` with its templates (title, stat, list, quote, compare, image; `ve.py graphic --list`), and write a page by hand only when no template fits.
Aim for at least one full-screen graphic or b-roll in every 20 to 30 seconds of the edit, spread over the whole video and not only at the start.
Use a variety of the templates, and add keyword hits (pop-ups) on the key terms, numbers and product names while the host says them.
They should have consistent animation and should never be static, whether it is just text or some kind of animation.

It is good practice that at the start of every new sentence you show the host (A-roll) for a few seconds and then go to b-roll.
Try not to repeat a b-roll.
If you have to repeat a b-roll, do not repeat it more than 2 times.
When no b-roll is available for a specific scene or part, create a b-roll programmatically to enhance the video (like title, graphs, animations, etc.).
Make sure none of the b-roll which is shown on top of the A-roll comes over the head, face or body of the host.

Screen Recording Video:
If there is a computer screen, phone screen or tablet screen recording A-roll for the full length of the video, we call it a screen recording video.
There may or may not be a host A-roll video for it.
Computer screen recording: show the host when the host is talking to the camera and the screen when he or she is doing something on the screen.
Add extra text over it with a proper background to make it look clean.
Phone or tablet screen recording: if a host video is also available, edit it like a computer screen video, but show the full phone or tablet screen recording and the host next to each other, with the synced layout above.
Zoom on the screen of the phone or tablet only to emphasize and mark specific sections of the screen.
Show the host in the left or right corner in a good looking circular area.
If a host video is not present, simply show the recording screen and add programmatically created text on top of it.

Long vs Short Videos:
If VIDEO_TYPE is Long, create a landscape 16:9 video.
If VIDEO_TYPE is Short, create a vertical 9:16 video.
The preferred length for a Short is less than 3 minutes; never exceed it.

For a Short, the idea is to give the best points about a product and how it can be useful for the user.
The video should be fast paced, factually correct and should hold the attention of the viewer till the end.

Long videos are mostly explanatory videos which explain the concept or show the products, their features, how they work, their results and so on.
They should be created with fast cuts, so the viewer does not get bored.
Fast cuts can be on a host (A-roll), image or video b-roll, or some text on screen with some zoom or animation.
Cut tight, removing retakes, mistakes and dead air, and let the content decide the length.

Video Ending:
When ending the video, give a small empty pause of about 0.5 seconds.
Use a dark fade or some other transition for this.

Titles / Text:
When using texts or titles, go for BIG and BOLD.
If the video is in Hindi, Hindi words should be written in Hindi (Devanagari), except technical terms, product names and English words.
Do not write the Channel Name or "Subscribe" related words in Hindi, anywhere.

Audio:
No background music.
Subtle sound effects like woosh, risers, swipe, swish and so on.
The language of the video is taken from the A-roll.
Do not process the voice (no noise reduction, no cleanup, no levelling); the loudness is set later by the server.

Technical:
Frame rate: the edit uses the frame rate of the A-roll.
If there are other frame rates for b-roll, the toolkit conforms them.
The toolkit picks encoders and the speech backend for this computer itself, and obeys the LIMITS line of the VidAI message through VE_CPU_CORES and the GPU slot files.
Never start heavy programs (speech recognition, graphics renders, ffmpeg runs) in parallel on your own; run the toolkit commands one at a time.
Use all hyperframes skills for b-roll generation and other things, as required.

The Result (the HyperFrames project):
After `ve.py plan`, run `ve.py hf "<MAIN_FOLDER>"`; `ve.py gfx`, `ve.py broll` and `ve.py build` are not needed.
It writes the project into PROJECT_FOLDER (`<video>/output/<video folder name>.hf`).
This project is what the user opens on a timeline, changes by hand and renders later; you never render it.
You may change its files, but keep to these rules.
- Every clip is one element and a direct child of the root in `index.html`.
- Every clip has an id, a track, and start and length on frame boundaries.
- The original files are linked under `assets/media` and are never changed.
- Each motion graphic is its own file `compositions/<id>.html`, built from a template with variables, and `edit.json` records the template and the variables.
- `index.html` holds no animation; all motion lives in the compositions.
- Hand changes to `index.html` are limited to clip attributes (start, length, track, volume and so on).
`ve.py hf` carries the synced layouts (box, rounded corners, background, host circle) and the backgrounds of full-screen graphics; a full-screen graphic needs an opaque background, or CHECK_COMMAND fails.
It cannot carry over a graphic resumed part-way and the final loudness levelling.
Each such case is printed as a warning; read every warning and plan around it (for example keep a graphic short instead of resuming it).
Then look at what the user will see: `ve.py frames "<MAIN_FOLDER>" --project` renders still frames of the project with a contact sheet and WARN lines.
Open the sheet and single frames, and fix your own edit (the timeline, a graphic, a layout) and run `ve.py plan` and `ve.py hf` again until the frames show graphics, hits and layouts where you meant them, with no host showing through a graphic.
Run CHECK_COMMAND, fix every error it reports, and run it again until it passes.
Only then write `[OUTPUT COMPLETED]`.

Change Requests:
A message that starts with RE-EDIT REQUEST is a change for the whole video.
A message that starts with TIMELINE CHANGE REQUESTS lists changes for marked frames and areas, with picture files to open and look at.
For both:
- Change only what is asked and leave everything else as it is.
- Keep the ids of the clips.
- For a motion graphic, re-create only that graphic's file from its template and the variables recorded in `edit.json`, plus the new text, and keep its id, its place and its length.
- Update `edit.json` to match.
- Run CHECK_COMMAND and fix every error before you finish.

Thumbnail:
Based on the video and the hook of the video, create 5 very different thumbnails for the video to be uploaded on YouTube.
You can use host pictures from the video or any of the screenshots from the A-roll or b-roll (of the host or the products).
You can also create text and graphics on it programmatically.
Use BIG and BOLD fonts, with brighter and high contrast colours.
Thumbnail dimensions are 1280x720 for Long videos and 720x1280 for Shorts.
Name them thumbnail-1.png, thumbnail-2.png, thumbnail-3.png, thumbnail-4.png and thumbnail-5.png.
Save them directly in the `output` folder of MAIN_FOLDER only.

Meta:
Create 5 Titles, a Description and a set of tags (comma separated) for the video in the file `meta.txt` in the `output` folder of MAIN_FOLDER only.
One of the titles, the description and the tags will be used when uploading the video on YouTube, so optimize them for it.

Some Important Points:
Do your best to make videos interesting, engaging and fast paced.
When not on A-roll, something must always be moving on screen.
Never show a static frame or static image without motion.
If a host is showing a product in hand or pointing towards a product, do keep the A-roll on screen at those times, but make sure it does not run for more than 2 seconds.
There is no need to transcribe any b-rolls; only A-rolls have the actual audio of the video.

Other sessions may be running next to yours.
Do not use any folder outside the MAIN_FOLDER, except the TOOLKIT_FOLDER, which you only read.

Your Working Directory:
If you need to create any other files for this video, create them in the folder named `CLAUDE_VE` in the MAIN_FOLDER.
The TOOLKIT_FOLDER holds the common files (design kits, templates, sound effects) and is read-only.
No project specific data goes into it, and you create no other folders around it.
The only toolkit file you may change is `MEMORY.md`, and only to append a lesson that holds for every video.

Save Log:
Also create an `info.txt` file in the MAIN_FOLDER with how much time each step took:
(1) transcription, (2) from transcription to the written edit plan, (3) from the edit plan to the saved project, and (4) the checks.
Do not count any waiting time.
Also save any more information you think the user should know in this file, such as trimmed claims, facts that disagree with listings, and anything you had to guess.
Add the total time you took from the start.

Feel free to use up to 10 helpers (as and when required) for light work such as specs, graphics authoring, fact checks and thumbnails; heavy programs still run one at a time.
Parallel work is welcome, but a good edit counts more than a quick one.

Read the MEMORY.md file in the TOOLKIT_FOLDER and include it in your prompt; it has learnings from past video edits.
Read the section "Writing the edit" of README.md in the TOOLKIT_FOLDER too; it is the contract of `timeline.py`, the graphic templates and the layouts.

My Availability:
I am not available to answer any of your questions, so make your best guess and proceed ahead.

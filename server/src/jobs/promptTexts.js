// Every fixed text of the messages VidAI sends to the editing agent (docs/SPEC.md section 8
// "Prompt" and section 11 "Change requests"), in one file so they are easy to review. The reader is
// an AI agent: sentences are plain and exact. Names such as MAIN_FOLDER and PROJECT_FOLDER refer
// to the header lines of the first message (`promptHeader.js`). Texts that need a value are
// functions here; nothing else in `server/src/jobs/prompt*.js` writes prose.

/** The completion marker the agent writes when its work is done. */
export const COMPLETION_MARKER = "[OUTPUT COMPLETED]";

// ---------------------------------------------------------------------------------------------
// The first message of an edit
// ---------------------------------------------------------------------------------------------

/**
 * Follows the product links when there are any: without it the model reads them as plain data
 * and ignores them.
 */
export const PRODUCT_LINKS_STEP =
  'PRODUCT_LINKS STEP (required):\nFor every link in PRODUCT_LINKS, fetch the page (the WebFetch tool if you have it, otherwise curl in the shell) and find the product images: the og:image and JSON-LD "image" entries and the images of the product gallery, at full resolution, never icons, logos or sprites. Download them into CLAUDE_VE/product_images/ inside MAIN_FOLDER, never into CHANNEL_FOLDER or anywhere else. Use them as b-roll where the video talks about that product, and take product names and facts from the page text. If a page cannot be fetched (for example the shop blocks bots), say so in info.txt and carry on without it.';

/** The style rule of the VidAI paragraph when the channel has a style for this video type. */
export const STYLE_GIVEN =
  "The channel style lives only in CHANNEL_STYLE above. Never create a Style folder, a Details folder or a STYLE.md, and never write the channel style into any file in CHANNEL_FOLDER; older notes and the toolkit's design kits that mention <channel>/Style/STYLE.md do not apply.";

/** The style rule when the channel has none. */
export const STYLE_EMPTY =
  "CHANNEL_STYLE above is empty, so design a fitting style yourself, use it for this video, and save it in CHANNEL_FOLDER/Style/STYLE.md (create the Style folder when it is missing) so it can be used for future videos.";

/** What the first message of a session in the OpenCode 2 program adds. */
export const OPENCODE2_PROGRAM =
  "OPENCODE:\nThis edit runs in the OpenCode 2 program, not in Claude Code. Where the instructions or MEMORY.md name Claude Code's tools, use OpenCode's: the shell tool for commands, the read, write and edit tools for files, and the subagent tool for sub-agents (agent general; start several in one step when their work can run in parallel). Sub-agents always run in the background and report back with a <subagent> message when they finish. The shell tool moves a command that is still running after its timeout (2 minutes unless you give a longer one) to the background, where it goes on and reports back with a <shell> message when it ends; so give long commands such as transcription, encoding and downloads a timeout in milliseconds that is long enough (for example 3600000 for an hour), and never start a command again while it still runs. When nothing is left to do but wait for sub-agents or background commands, end your turn: their reports wake you, and the edit goes on from there.";

/**
 * The paragraph that asks a model on an API setup not to stop before the work is done (the
 * Claude subscription never gets it).
 */
export const KEEP_WORKING = `Keep working until the job is done: VidAI cannot answer and only sees your tool calls and files, so do not end your turn until the work is complete and ${COMPLETION_MARKER} is written. Never end a turn with only a sentence about what you will do next: do that step with tool calls in the same turn, then go on to the next one. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, never several together at the end.`;

/** The first sentences of the VidAI paragraph. */
export const VIDAI_INTRO =
  "This edit was started from the VidAI app. There is no terminal and nobody can answer questions, so make your best guess and never wait for input.";

/**
 * How a command is typed on Windows: PowerShell needs `&` in front of a quoted program path (without
 * it the line is a string followed by garbage), Git Bash and cmd.exe must not get it.
 * @param {string} example A complete command line.
 * @returns {string}
 */
function windowsShell(example) {
  return `In PowerShell write the same line with & in front (& ${example}); in Git Bash or cmd.exe write it without. Keep the double quotes and forward slashes as they are, and do the same for CHECK_COMMAND.`;
}

/**
 * The toolkit sentences of the VidAI paragraph: which program to use, how to call it, where its
 * standing instructions are.
 * @param {{ example: string, home: string, sep: string, windows: boolean }} p `example` is a
 *   complete command line with the real values (on Windows with slashes and double quotes),
 *   `home` the folder that holds TOOLKIT_FOLDER, `sep` its path separator, `windows` whether the
 *   server runs on Windows, where the shell decides how a quoted program is started.
 * @returns {string}
 */
export function toolkitSentences(p) {
  const then = p.windows ? `. ${windowsShell(p.example)} Do not use` : "; do not use";
  return `The toolkit is in TOOLKIT_FOLDER and runs with the Python in PYTHON. Every command takes the absolute video folder, so call it as ${p.example} (replace "hf" with the command you need)${then} any other Python or toolkit folder and never write into TOOLKIT_FOLDER. Where older notes (for example MEMORY.md) say CLAUDE_VE_ALL, they mean TOOLKIT_FOLDER. Read ${p.home}${p.sep}CLAUDE.md (short rules), the section "Writing the edit" of ${p.home}${p.sep}README.md (the timeline.py contract, the graphic templates and the layouts) and ${p.home}${p.sep}MEMORY.md (lessons from earlier edits; append a new lesson to it only when you learned one worth keeping) before you start.`;
}

/**
 * The project sentences of the VidAI paragraph (docs/SPEC.md section 10): where the result goes,
 * what it must satisfy, and that the agent never renders.
 * @param {{ hfCommand: string }} p `hfCommand` is the command line that writes the project.
 * @returns {string}
 */
export function projectSentences(p) {
  return [
    `The result of this edit is a HyperFrames project in PROJECT_FOLDER (the folder output/<video folder name>.hf inside MAIN_FOLDER). ${p.hfCommand} writes it following the channel profile; you may then change its files. Keep working files in CLAUDE_VE inside MAIN_FOLDER, and make sure nothing the project needs to play lies there.`,
    "The project must pass CHECK_COMMAND: run it before you finish, and fix every error it reports.",
    "Original footage is linked into the project under assets/media, never copied, and the original files are never changed, moved or deleted. Every motion graphic is its own file compositions/<id>.html; index.html holds no animation.",
    "Never render a video file of the edit (no hyperframes render, no ffmpeg export of the timeline, no screen capture): VidAI renders it from the project later.",
  ].join("\n");
}

/** The last sentence of the VidAI paragraph of an edit. */
export const COMPLETE_EDIT =
  'When the project in PROJECT_FOLDER is fully done and passes CHECK_COMMAND, clearly write "[OUTPUT COMPLETED]" in your last message.';

// ---------------------------------------------------------------------------------------------
// Follow-up messages of a session that goes on
// ---------------------------------------------------------------------------------------------

/** Continue, in Claude Code: it has background tasks, which a pause stops. */
export const CONTINUE =
  "Continue the video edit from where it was paused. Background tasks that were running were stopped, so check what finished and redo what did not. Work until the project in PROJECT_FOLDER is complete and passes CHECK_COMMAND.";

/** Continue, in the OpenCode 2 program: what a pause stops are the commands and sub-agents. */
export const CONTINUE_OPENCODE =
  "Continue the video edit from where it was paused. The commands and sub-agents that were running were stopped, so check what finished and redo what did not. Work until the project in PROJECT_FOLDER is complete and passes CHECK_COMMAND.";

/** The progress reminder of a Continue message. */
export const CONTINUE_MARKERS =
  "Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, also for steps that finished before the pause and were not marked yet.";

/** What was missing when the last attempt of a job of this kind failed (appended to Continue). */
export const MISSING_OUTPUT = Object.freeze({
  edit: "The last attempt ended without a project in PROJECT_FOLDER that passes CHECK_COMMAND.",
  reEdit:
    "The last attempt ended without a changed project in PROJECT_FOLDER that passes CHECK_COMMAND.",
  timelineEdit:
    "The last attempt ended without a changed project in PROJECT_FOLDER that passes CHECK_COMMAND.",
});

/** The start of the Re-Edit message, before the user's text. */
export const RE_EDIT_INTRO = "RE-EDIT REQUEST. I reviewed the edit and want these changes:";

/** The rules of the Re-Edit message, after the user's text. */
export const RE_EDIT_RULES = `Apply these changes and keep everything else as it is. Update the project in PROJECT_FOLDER in place (keep the ids of the clips that stay, and do not make a second project folder), update the thumbnails and meta.txt only if the changes affect them, add the re-edit to info.txt, and run CHECK_COMMAND until it reports no errors. Never render a video file. Write ${COMPLETION_MARKER} when done.`;

/**
 * The paragraph that tells a new session about the earlier work, when the old session could not
 * be resumed.
 * @param {boolean} hasProject Whether a project already exists in PROJECT_FOLDER.
 * @returns {string}
 */
export function earlierWork(hasProject) {
  return hasProject
    ? "This video was already edited in an earlier session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, and the current project is in PROJECT_FOLDER. Build on that work instead of starting over."
    : "This video was already worked on in an earlier session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, but there is no project yet. Reuse the work that is there instead of starting over.";
}

// ---------------------------------------------------------------------------------------------
// After the completion marker: the project check failed
// ---------------------------------------------------------------------------------------------

/** How many times the agent is asked to fix the errors of the project check. */
export const PROFILE_FIX_ATTEMPTS = 2;

/** At most this many errors are listed in one message. */
export const PROFILE_FIX_LISTED = 40;

/**
 * The message after a failed project check.
 * @param {string[]} violations One sentence per error.
 * @param {number} attempt 1 for the first request to fix, up to `PROFILE_FIX_ATTEMPTS`.
 * @returns {string}
 */
export function profileFix(violations, attempt) {
  const listed = violations.slice(0, PROFILE_FIX_LISTED).map((v) => `- ${v}`);
  const hidden = violations.length - listed.length;
  const body =
    listed.length === 0
      ? "CHECK_COMMAND reported errors without details; run it yourself to see them."
      : listed.join("\n");
  const more =
    hidden > 0
      ? `\n(${hidden} more not listed: fix these first, then run CHECK_COMMAND again to see the rest.)`
      : "";
  const last =
    attempt >= PROFILE_FIX_ATTEMPTS
      ? " This is the last time you are asked: the job fails if the project still has errors."
      : "";
  return `The project in PROJECT_FOLDER does not pass CHECK_COMMAND (request ${attempt} of ${PROFILE_FIX_ATTEMPTS} to fix it).${last}\nErrors:\n${body}${more}\n\nFix every error in the project files and keep everything else as it is. Never render a video file. Run CHECK_COMMAND again until it reports no errors, then write ${COMPLETION_MARKER} again.`;
}

// ---------------------------------------------------------------------------------------------
// Change requests made on the timeline (docs/SPEC.md section 11)
// ---------------------------------------------------------------------------------------------

/**
 * The start of the timeline message.
 * @param {{ count: number, width: number, height: number, fps: string }} p
 * @returns {string}
 */
export function timelineIntro(p) {
  const what = p.count === 1 ? "one change" : `${p.count} changes`;
  return `TIMELINE CHANGE REQUESTS. I looked at the timeline of this video and want ${what} in the project in PROJECT_FOLDER. The frame is ${p.width}x${p.height} pixels and the frame rate is ${p.fps} fps. Times and frames are positions on the project's timeline, where frame 0 is the start of the video; they are not positions in the source files. Open the picture files of a request (they are images) to see the frame.`;
}

/** The line that replaces the picture list of a request that has no picture. */
export const NO_PICTURES =
  "Pictures: none could be made for this request; use the time and the clips below.";

/** The rules at the end of the timeline message (docs/SPEC.md section 11, "Change requests"). */
export const TIMELINE_RULES = `RULES FOR THESE CHANGES:
- Change only what the requests need and keep everything else as it is. Keep the ids of the clips that stay; a new clip gets a new unique id.
- Update the project in PROJECT_FOLDER in place (index.html, compositions/, edit.json, transcript.json); do not make a second project folder. Keep the project's rules: clips on frame boundaries, no overlaps on a track, original footage linked and never changed.
- When a request concerns a motion graphic, re-create only that graphic's file compositions/<id>.html from its earlier instructions (its template and variables are in edit.json, under graphics) plus the new text of the request, and keep its id, its place on the timeline and its length unless the request says otherwise. Keep its entry in edit.json in step with the file.
- A request that names a clip applies to that clip. A request with an area applies to what is shown in that area at that time. A request for the whole frame applies to what is shown at that time.
- Apply every request. When two requests conflict, the one with the higher number wins.
- Never render a video file of the edit: VidAI renders it from the project later.
- Run CHECK_COMMAND and fix every error it reports, then write ${COMPLETION_MARKER} in your last message.`;

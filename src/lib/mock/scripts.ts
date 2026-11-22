/** Simulated Claude Code activity, one step per tick, per job kind. */
import type { JobKind, JobProgress, LogKind } from "../types";

/** Where a job works, for the full paths in a step's detail. */
export interface StepPaths {
  /** The folder of the channel (what the editing agent runs in). */
  channelDir: string;
  videoDir: string;
}

export interface ScriptStep {
  kind: LogKind;
  /**
   * The log line. Like the real backend's, paths in it are relative to the video folder
   * (`CLAUDE_VE/edit_plan.json`) or else to the Editing Folder (`MEMORY.md`).
   */
  text: string;
  /** The full detail; tool inputs with absolute paths, as the real backend keeps them. */
  detail?: string | ((paths: StepPaths) => string);
  nested?: boolean;
  /** Shown as the row's last activity line while this step runs. */
  activity?: string;
  /** The progress stage that begins with this step; the steps after it stay in that stage. */
  stage?: string;
}

/** A file tool's input as the real backend shows it in `detail` (pretty JSON). */
function fileInput(file: (paths: StepPaths) => string, extra: Record<string, string> = {}) {
  return (paths: StepPaths) => JSON.stringify({ file_path: file(paths), ...extra }, null, 2);
}

const inChannel = (name: string) => (p: StepPaths) => `${p.channelDir}/${name}`;
const inVideo = (name: string) => (p: StepPaths) => `${p.videoDir}/${name}`;

const EDIT: ScriptStep[] = [
  {
    kind: "status",
    text: "Started Claude Code",
    activity: "Starting Claude Code",
    stage: "Getting started",
  },
  {
    kind: "assistant",
    text: "I'll start by reading MEMORY.md and the channel notes, then look at the A-roll.",
    activity: "Reading notes",
  },
  {
    kind: "tool",
    text: "Read: MEMORY.md",
    detail: fileInput(inChannel("MEMORY.md")),
    activity: "Reading MEMORY.md",
  },
  { kind: "toolResult", text: "412 lines" },
  {
    kind: "tool",
    text: "Bash: Probe the A-roll",
    detail: 'ffprobe -v error -show_streams -of json "A001_C003.mp4"',
    activity: "Running ffprobe",
    stage: "Transcribing",
  },
  { kind: "toolResult", text: "1 video stream, 3840x2160, 23.976 fps, 11:42" },
  {
    kind: "tool",
    text: "Bash: Transcribe the A-roll with Whisper",
    detail: "python3 CLAUDE_VE_ALL/transcribe.py --model large-v3 A001_C003.mp4",
    activity: "Transcribing with Whisper",
  },
  { kind: "toolResult", text: "Transcript written to CLAUDE_VE/transcript.json (1,804 words)" },
  {
    kind: "assistant",
    text: "The transcript is ready (**1,804 words**). Next:\n\n1. Cut the pauses and the repeated takes\n2. Plan the b-roll from `Broll/`",
    activity: "Planning the cut",
    stage: "Planning the edit",
  },
  {
    kind: "tool",
    text: "Task: Match b-roll to the script",
    detail: "Find the best b-roll clip for each of the 24 script beats in Broll/.",
    activity: "Matching b-roll",
    stage: "Preparing b-roll",
  },
  {
    kind: "tool",
    text: "Glob: Broll/**/*.mp4",
    detail: (p) => JSON.stringify({ pattern: `${p.videoDir}/Broll/**/*.mp4` }, null, 2),
    nested: true,
  },
  { kind: "toolResult", text: "37 files", nested: true },
  { kind: "assistant", text: "Matched 22 of 24 beats; 2 use stills.", nested: true },
  {
    kind: "tool",
    text: "Bash: Render graphics at 1080",
    detail: "node CLAUDE_VE_ALL/graphics/render.mjs --size 1920x1080 --out CLAUDE_VE/graphics",
    activity: "Rendering graphics",
    stage: "Building graphics",
  },
  { kind: "toolResult", text: "Rendered 9 lower thirds and 3 title cards" },
  {
    kind: "tool",
    text: "Bash: Build the review timeline",
    detail: "python3 CLAUDE_VE_ALL/timeline.py --out output/",
    activity: "Building the review project",
    stage: "Assembling the timeline",
  },
  {
    kind: "toolResult",
    text: "Wrote the HyperFrames project in output/",
    stage: "Writing the review project",
  },
  {
    kind: "tool",
    text: "Bash: Export thumbnails",
    detail: "python3 CLAUDE_VE_ALL/thumbs.py --count 3",
    activity: "Exporting thumbnails",
    stage: "Thumbnails and details",
  },
  { kind: "toolResult", text: "3 thumbnails written" },
  {
    kind: "tool",
    text: "Write: output/meta.txt",
    detail: fileInput(inVideo("output/meta.txt"), { content: "Title, description and tags" }),
  },
  {
    kind: "assistant",
    text: "The review project, thumbnails and meta.txt are in the output folder. [OUTPUT COMPLETED]",
    activity: "Finishing",
    stage: "Checking the edit",
  },
];

const RE_EDIT: ScriptStep[] = [
  {
    kind: "status",
    text: "Resumed the Claude Code session",
    activity: "Resuming session",
    stage: "Getting started",
  },
  {
    kind: "assistant",
    text: "I'll apply the requested changes and keep everything else as it is.",
    activity: "Reading the request",
  },
  {
    kind: "tool",
    text: "Read: CLAUDE_VE/edit_plan.json",
    detail: fileInput(inVideo("CLAUDE_VE/edit_plan.json")),
    activity: "Reading the edit plan",
    stage: "Planning the edit",
  },
  { kind: "toolResult", text: "24 beats, 3 graphics groups" },
  {
    kind: "tool",
    text: "Bash: Re-render the changed graphics",
    detail: "node CLAUDE_VE_ALL/graphics/render.mjs --only title,lower3",
    activity: "Rendering graphics",
    stage: "Building graphics",
  },
  { kind: "toolResult", text: "Rendered 2 graphics" },
  {
    kind: "tool",
    text: "Bash: Build the next review version",
    detail: "python3 CLAUDE_VE_ALL/timeline.py --software fcp --next-version",
    activity: "Building the review project",
    stage: "Writing the review project",
  },
  { kind: "toolResult", text: "Wrote the next review version" },
  {
    kind: "tool",
    text: "Edit: info.txt",
    detail: fileInput(inVideo("info.txt"), { new_string: "Added the re-edit notes" }),
    stage: "Thumbnails and details",
  },
  {
    kind: "assistant",
    text: "The changes are in a new review version. [OUTPUT COMPLETED]",
    activity: "Finishing",
    stage: "Checking the edit",
  },
];

// The server renders without an agent (HyperFrames' renderer, `server/src/render/runner.js`):
// its own status lines and the renderer's stages in the words of `rendererOutput.js`.
const RENDER: ScriptStep[] = [
  {
    kind: "status",
    text: "Rendering with GPU encoding",
    activity: "Compiling the project",
    stage: "Compiling the project",
  },
  {
    kind: "status",
    text: "Capturing frames",
    activity: "Capturing frames",
    stage: "Capturing frames",
  },
  { kind: "status", text: "Capturing frames: 35%" },
  { kind: "status", text: "Capturing frames: 72%" },
  {
    kind: "status",
    text: "Encoding the video",
    activity: "Encoding the video",
    stage: "Encoding the video",
  },
  {
    kind: "status",
    text: "Checking the rendered file",
    activity: "Checking the video",
    stage: "Checking the video",
  },
  {
    kind: "status",
    text: "Levelling the sound",
    activity: "Levelling the sound",
    stage: "Levelling the sound",
  },
  {
    kind: "status",
    text: "Saved the final video",
    activity: "Saving the video",
    stage: "Saving the video",
  },
];

const TIMELINE_EDIT: ScriptStep[] = [
  {
    kind: "status",
    text: "Resumed the Claude Code session",
    activity: "Resuming session",
    stage: "Getting started",
  },
  {
    kind: "assistant",
    text: "I'll apply the change requests from the timeline notes.",
    activity: "Reading the notes",
    stage: "Reading the requests",
  },
  {
    kind: "tool",
    text: "Read: output/timeline.json",
    detail: fileInput(inVideo("output/timeline.json")),
    activity: "Reading the timeline",
  },
  { kind: "toolResult", text: "31 clips, 4 notes" },
  {
    kind: "tool",
    text: "Edit: output/timeline.json",
    detail: fileInput(inVideo("output/timeline.json"), { new_string: "Moved the intro clip" }),
    activity: "Changing the timeline",
    stage: "Changing the timeline",
  },
  {
    kind: "assistant",
    text: "All notes are done and the timeline is updated. [OUTPUT COMPLETED]",
    activity: "Finishing",
    stage: "Checking the change",
  },
];

/** A step's detail with the job's real paths filled in. */
export function stepDetail(step: ScriptStep, paths: StepPaths): string | null {
  if (step.detail === undefined) return null;
  return typeof step.detail === "string" ? step.detail : step.detail(paths);
}

/** What a job reports once it completed. */
export const DONE_PROGRESS: JobProgress = { percent: 100, stage: "Done", secondsLeft: 0 };

/**
 * The progress a job of `kind` reports after `stepsDone` steps of its script: the share of steps
 * done, at most 99 until the job completes, and the stage of the last step done. `null` before the
 * first step, like the engine before it reports anything.
 */
export function progressAfter(kind: JobKind, stepsDone: number): JobProgress | null {
  if (stepsDone <= 0) return null;
  const script = scriptFor(kind);
  const done = Math.min(stepsDone, script.length);
  const stage = script.slice(0, done).findLast((s) => s.stage !== undefined)?.stage ?? null;
  const left = script.length - done;
  return {
    percent: Math.min(99, Math.round((done / script.length) * 100)),
    stage,
    // The server tells no time left for a render (only the agent's jobs have a typical pace).
    secondsLeft: kind === "render" ? null : left * 20,
  };
}

export function scriptFor(kind: JobKind): ScriptStep[] {
  switch (kind) {
    case "edit":
      return EDIT;
    case "reEdit":
      return RE_EDIT;
    case "timelineEdit":
      return TIMELINE_EDIT;
    case "render":
      return RENDER;
  }
}

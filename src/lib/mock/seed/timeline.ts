/**
 * Seed of the timeline area: HyperFrames projects as the server would read them. The default world
 * has one, on "Serum Launch" (a Long video of the Beauty channel). The scenarios `timeline`,
 * `timeline-locked`, `timeline-broken`, `timeline-notes` and `timeline-copies` add more videos with
 * `addTimelineVideo` (the ids are in `TIMELINE_VIDEOS`).
 */
import type { ClipKind, ProjectViolation, Timeline, TimelineClip, TimelineNote } from "../../types";
import { makeVideoId } from "../../videoId";
import { createErrors } from "../ctx";
import {
  NOTE_STOPPED,
  NO_COPIES,
  applyOp,
  saveRevision,
  trackName,
  type TimelineSim,
} from "../timelineEngine";
import { nextId, type World } from "../world";
import { addJob } from "./jobs";
import { makeVideo } from "./library";
import { ADMIN_EMAIL, ADMIN_ID, USER_EMAIL, USER_ID } from "./session";
import { ADMIN_CHANNEL_BEAUTY, USER_CHANNEL_TRAVEL } from "./workspace";

const DAY = 86_400_000;

/** The videos the timeline seeds and scenarios create, by what they show. */
export const TIMELINE_VIDEOS = {
  /** In the default world: a Long project with every kind of clip. */
  default: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Serum Launch"),
  /** Scenario `timeline`: the same kind of project, its own copy. */
  long: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Long"),
  /** Scenario `timeline`: a Short (9:16) project. */
  short: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Short"),
  /** Scenario `timeline`: nothing on any track yet. */
  empty: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Empty"),
  /** Scenario `timeline`: a video of the plain user (two users). */
  user: makeVideoId(USER_CHANNEL_TRAVEL, "Timeline User"),
  /** Scenario `timeline-locked`: a change request runs; hand edits are refused. */
  locked: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Locked"),
  /** Scenario `timeline-broken`: readable, but breaks rule 4 (no hand edits). */
  broken: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Broken"),
  /** Scenario `timeline-broken`: cannot be read at all (`timeline` is `null`). */
  unreadable: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Unreadable"),
  /** Scenario `timeline-notes`: change requests in every state (a job is running). */
  notes: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Notes"),
  /** Scenario `timeline-copies`: preview copies of heavy files are being made. */
  copies: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Timeline Copies"),
} as const;

const FPS = { num: 30, den: 1 };

function c(
  id: string,
  kind: ClipKind,
  track: number,
  start: number,
  duration: number,
  rest: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id,
    kind,
    label: id,
    track,
    start,
    duration,
    source: null,
    mediaStart: null,
    sourceFrames: null,
    file: null,
    ...rest,
  };
}

const media = (source: string, mediaStart: number, sourceFrames: number) => ({
  source,
  mediaStart,
  sourceFrames,
});

function project(
  clips: TimelineClip[],
  size: { width: number; height: number },
): Pick<Timeline, "fps" | "width" | "height" | "duration" | "tracks"> {
  const indexes = new Set([0, 1, 2, 3, 4, ...clips.map((x) => x.track)]);
  const tracks = [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      name: trackName(index),
      clips: clips.filter((x) => x.track === index).sort((a, b) => a.start - b.start),
    }));
  const duration = Math.max(0, ...(tracks[0]?.clips ?? []).map((x) => x.start + x.duration));
  return { fps: FPS, ...size, duration, tracks };
}

/** Four A-roll clips from two sources, B-roll (one with motion), graphics, an overlay, a hit, sound. */
export function longClips(): TimelineClip[] {
  return [
    c("a-1", "aroll", 0, 0, 300, { label: "Intro", ...media("interview-1.mp4", 0, 1800) }),
    c("a-2", "aroll", 0, 300, 420, { label: "Texture", ...media("interview-1.mp4", 420, 1800) }),
    c("a-3", "aroll", 0, 720, 360, { label: "Results", ...media("interview-2.mp4", 90, 900) }),
    c("a-4", "aroll", 0, 1080, 420, { label: "Verdict", ...media("interview-2.mp4", 600, 1400) }),
    c("b-1", "broll", 1, 60, 90, { label: "Bottle close-up", ...media("closeup.mp4", 30, 400) }),
    c("g-1", "graphic", 1, 200, 90, {
      label: "Price card",
      file: "compositions/g-1.html",
    }),
    c("b-2", "broll", 1, 330, 90, { label: "Texture swatch", ...media("swatch.mp4", 0, 300) }),
    c("b-3", "broll", 1, 760, 120, {
      label: "Slow push-in",
      file: "compositions/b-3.html",
      ...media("pan-shot.mp4", 0, 600),
    }),
    c("g-2", "graphic", 1, 1000, 70, { label: "Rating", file: "compositions/g-2.html" }),
    c("o-1", "overlay", 2, 100, 100, { label: "Logo bug", source: "logo.png" }),
    c("h-1", "hit", 3, 450, 30, { label: "serum" }),
    c("fade-1", "fade", 4, 1470, 30, { label: "End fade" }),
    c("m-1", "music", 10, 0, 1500, { label: "Music bed", ...media("bed.mp3", 0, 3000) }),
    c("s-1", "sfx", 11, 60, 15, { label: "Whoosh", ...media("whoosh.wav", 0, 60) }),
  ];
}

export function shortClips(): TimelineClip[] {
  return [
    c("a-1", "aroll", 0, 0, 240, { label: "Hook", ...media("take-1.mp4", 0, 900) }),
    c("a-2", "aroll", 0, 240, 360, { label: "Demo", ...media("take-1.mp4", 300, 900) }),
    c("b-1", "broll", 1, 90, 90, { label: "Unboxing", ...media("unbox.mp4", 0, 240) }),
    c("g-1", "graphic", 1, 300, 100, { label: "Callout", file: "compositions/g-1.html" }),
    c("fade-1", "fade", 4, 570, 30, { label: "End fade" }),
    c("m-1", "music", 10, 0, 600, { label: "Music bed", ...media("bed.mp3", 0, 1800) }),
  ];
}

export interface TimelineSpec {
  videoId: string;
  owner?: "admin" | "user";
  clips: TimelineClip[];
  size?: { width: number; height: number };
  detectedType?: "long" | "short";
  violations?: ProjectViolation[];
  unreadable?: boolean;
  copies?: { total: number; done: number; running: boolean };
  /** Hand edits to put in the history: ops applied in order, each a revision "Trim A-roll" ... */
  history?: unknown[];
  /** Requests in the history; a `failed` one should say why (`error`), the others get `null`. */
  notes?: Array<Omit<TimelineNote, "id" | "createdAt" | "jobId" | "error"> & { error?: string }>;
}

const LONG = { width: 1920, height: 1080 };
const SHORT = { width: 1080, height: 1920 };

/** A fake preview address of the shape the server builds (`/p/` and 43 URL-safe characters). */
function previewUrlOf(videoId: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = 2166136261;
  for (const ch of videoId) state = Math.imul(state ^ ch.charCodeAt(0), 16777619) >>> 0;
  let token = "";
  for (let i = 0; i < 43; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    token += alphabet.charAt(state >>> 26);
  }
  return `/p/${token}/`;
}

/** Puts a project (and the video, when the library has none of this id) into the world. */
export function addTimeline(world: World, now: number, spec: TimelineSpec): TimelineSim {
  const slash = spec.videoId.indexOf("/");
  const channelId = spec.videoId.slice(0, slash);
  const folderName = spec.videoId.slice(slash + 1);
  const owner = spec.owner ?? "admin";
  const ownerId = owner === "admin" ? ADMIN_ID : USER_ID;
  const email = owner === "admin" ? ADMIN_EMAIL : USER_EMAIL;
  if (!world.videos.some((v) => makeVideoId(v.channelId, v.folderName) === spec.videoId)) {
    world.videos.push(
      makeVideo(
        {
          channelId,
          userId: ownerId,
          folderName,
          daysAgo: 2,
          edited: true,
          detectedType: spec.detectedType ?? "long",
        },
        now,
      ),
    );
  }
  const base = project(spec.clips, spec.size ?? LONG);
  const sim: TimelineSim = {
    timeline: {
      ...base,
      revision: 0,
      notes: [],
      canUndo: false,
      canRedo: false,
      locked: null,
    },
    revisions: [],
    snapshots: {},
    notes: [],
    previewUrl: spec.unreadable === true ? null : previewUrlOf(spec.videoId),
    ownerId,
    violations: spec.violations ?? [],
    unreadable: spec.unreadable ?? false,
    copies: spec.copies ?? { ...NO_COPIES },
    lastRevision: 0,
    requestedJobId: null,
  };
  const errors = createErrors();
  const first = now - DAY;
  saveRevision(sim, { label: "Edit", userEmail: null, jobId: nextId(world, "job") }, first);
  spec.history?.forEach((op, index) => {
    const result = applyOp(sim.timeline, op, errors);
    sim.timeline.tracks = result.tracks;
    sim.timeline.duration = result.duration;
    saveRevision(
      sim,
      { label: result.label, userEmail: email, jobId: null },
      first + (index + 1) * 600_000,
    );
  });
  for (const note of spec.notes ?? []) {
    sim.notes.push({
      ...note,
      id: nextId(world, "note"),
      jobId: null,
      error: note.state === "failed" ? (note.error ?? NOTE_STOPPED) : null,
      createdAt: now - 3_600_000 + sim.notes.length * 60_000,
    });
  }
  world.timelines[spec.videoId] = sim;
  return sim;
}

/** The default world: a Long project on "Serum Launch" with two hand edits in its history. */
export function seedTimeline(world: World, now: number): void {
  addTimeline(world, now, {
    videoId: TIMELINE_VIDEOS.default,
    clips: longClips(),
    history: [
      { type: "trim", clipId: "a-1", edge: "end", frame: 280 },
      { type: "move", clipId: "b-2", frame: 340 },
    ],
  });
}

/** The scenario `timeline`: Long, Short, empty and a user's project. */
export function addTimelineScenario(world: World, now: number): void {
  addTimeline(world, now, { videoId: TIMELINE_VIDEOS.long, clips: longClips() });
  addTimeline(world, now, {
    videoId: TIMELINE_VIDEOS.short,
    clips: shortClips(),
    size: SHORT,
    detectedType: "short",
  });
  addTimeline(world, now, { videoId: TIMELINE_VIDEOS.empty, clips: [] });
  addTimeline(world, now, { videoId: TIMELINE_VIDEOS.user, owner: "user", clips: shortClips() });
}

/** The scenario `timeline-locked`: a change request is being worked on. */
export function addLockedScenario(world: World, now: number): void {
  const sim = addTimeline(world, now, { videoId: TIMELINE_VIDEOS.locked, clips: longClips() });
  const job = addJob(
    world,
    {
      channelId: ADMIN_CHANNEL_BEAUTY,
      folderName: "Timeline Locked",
      userId: ADMIN_ID,
      kind: "timelineEdit",
      state: "running",
      steps: 2,
      joinedMinutesAgo: 2,
    },
    now,
  );
  sim.notes.push({
    id: nextId(world, "note"),
    frame: 90,
    shape: { cx: 0.5, cy: 0.45, rx: 0.2, ry: 0.15 },
    elementId: "b-1",
    prompt: "Make the bottle bigger and brighten the label.",
    state: "running",
    jobId: job.view.id,
    error: null,
    createdAt: now - 120_000,
  });
}

/** The scenario `timeline-broken`: a project that breaks rule 4, and one that cannot be read. */
export function addBrokenScenario(world: World, now: number): void {
  addTimeline(world, now, {
    videoId: TIMELINE_VIDEOS.broken,
    clips: shortClips().map((x) => (x.id === "b-1" ? { ...x, track: 2 } : x)),
    size: SHORT,
    detectedType: "short",
    violations: [
      {
        rule: 4,
        elementId: "b-1",
        message: 'The B-roll clip "b-1" is on track 2, but B-roll belongs on track 1.',
      },
    ],
  });
  addTimeline(world, now, {
    videoId: TIMELINE_VIDEOS.unreadable,
    clips: [],
    unreadable: true,
    violations: [
      {
        rule: 1,
        elementId: null,
        message: "The project has no root element, so it cannot be opened.",
      },
    ],
  });
}

/** The scenario `timeline-notes`: a request in every state; a job is running, so the lock is on. */
export function addNotesScenario(world: World, now: number): void {
  const sim = addTimeline(world, now, {
    videoId: TIMELINE_VIDEOS.notes,
    clips: longClips(),
    notes: [
      {
        frame: 40,
        shape: { cx: 0.3, cy: 0.4, rx: 0.1, ry: 0.12 },
        elementId: null,
        prompt: "Remove the shadow under the chin.",
        state: "done",
      },
      {
        frame: 215,
        shape: { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.2 },
        elementId: "g-1",
        prompt: "Make the price card use the brand colour.",
        state: "failed",
        error: "The price card uses a font that is not in the project, so it could not be changed.",
      },
      {
        frame: 340,
        shape: null,
        elementId: "b-2",
        prompt: "Use a slower swatch shot here.",
        state: "running",
      },
      {
        frame: 800,
        shape: { cx: 0.7, cy: 0.3, rx: 0.08, ry: 0.08 },
        elementId: null,
        prompt: "Add a small sparkle on the bottle cap.",
        state: "pending",
      },
    ],
  });
  const job = addJob(
    world,
    {
      channelId: ADMIN_CHANNEL_BEAUTY,
      folderName: "Timeline Notes",
      userId: ADMIN_ID,
      kind: "timelineEdit",
      state: "running",
      steps: 1,
      joinedMinutesAgo: 1,
    },
    now,
  );
  for (const note of sim.notes) if (note.state === "running") note.jobId = job.view.id;
  const done = sim.notes.find((n) => n.state === "done");
  if (done) done.jobId = "job-earlier";
  // A failed request keeps the job that failed, as the server's table does.
  const failed = sim.notes.find((n) => n.state === "failed");
  if (failed) failed.jobId = "job-earlier-failed";
}

/** The scenario `timeline-copies`: three heavy files, none copied yet, the first one running. */
export function addCopiesScenario(world: World, now: number): void {
  addTimeline(world, now, {
    videoId: TIMELINE_VIDEOS.copies,
    clips: longClips(),
    copies: { total: 3, done: 0, running: true },
  });
}

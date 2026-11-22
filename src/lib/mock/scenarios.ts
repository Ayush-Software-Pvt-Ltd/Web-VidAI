/**
 * Mock scenarios, selected from the URL query so every screen can be reviewed in a browser:
 *
 *   http://localhost:1420/?scenario=as-user
 *   http://localhost:1420/?scenario=busy,usage-critical&latency=600&speed=3
 *
 * `scenario` takes a comma-separated list (later entries win where they overlap). A scenario is a
 * set of patches, one per area (`AREAS` in `world.ts`), applied to the seeded world in that area
 * order. The list below is frozen: each area's task fills in the patches of the scenarios it owns
 * (the owner is named in `SCENARIOS`); an unfilled scenario is the same as `default`.
 *
 * Other parameters: `as` (`admin` or `user`, who the browser is signed in as, overrides the
 * scenario), `latency` (ms per call, default 90), `speed` (job speed factor, default 1), `minute`
 * (ms the mock counts as one minute of the start delay, default 6000; `minute=60000` is real
 * time), `ticks=off` (freeze jobs and usage, for deterministic screenshots).
 */
import { createEmptyWorld } from "./seed/empty";
import { seedAdmin } from "./seed/admin";
import { addLargeDisk, seedDisk } from "./seed/disk";
import {
  claudeRouted,
  seedHarness,
  setupAnthropicApi,
  setupModelGone,
  setupModelsFail,
  setupOpencodeGo,
  setupOpenaiApi,
  setupReady,
} from "./seed/harness";
import { makePrepareFail, makeSystemProblems } from "./seed/prepare";
import { addJob, seedJobs, type JobSpec } from "./seed/jobs";
import { makeVideo, seedLibrary } from "./seed/library";
import { seedQueue } from "./seed/queue";
import { ADMIN_ID, seedSession, USER_ID } from "./seed/session";
import { seedStorage } from "./seed/storage";
import { makeNotReady, makeUsageCritical, seedSystem } from "./seed/system";
import {
  addBrokenScenario,
  addCopiesScenario,
  addLockedScenario,
  addNotesScenario,
  addTimelineScenario,
  seedTimeline,
} from "./seed/timeline";
import { seedUploads, uploadingPatch } from "./seed/uploads";
import {
  ADMIN_CHANNEL_BEAUTY,
  ADMIN_CHANNEL_TECH,
  seedWorkspace,
  USER_CHANNEL_TRAVEL,
} from "./seed/workspace";
import { AREAS, type Area, type World } from "./world";

export type ScenarioPatch = (world: World) => void;

export type ScenarioDef = {
  description: string;
  /** The task that fills the patches in (`session` is done). */
  owner: string;
} & Partial<Record<Area, ScenarioPatch>>;

/** Adds a video and a job on it (a scenario's way to fill the queues). */
function active(
  world: World,
  now: number,
  who: "admin" | "user",
  folderName: string,
  state: JobSpec["state"],
  rest: Partial<JobSpec> = {},
  edited = false,
  adminChannel?: string,
): void {
  const channelId =
    who === "user"
      ? USER_CHANNEL_TRAVEL
      : (adminChannel ??
        ((world.videos.length + folderName.length) % 2 === 0
          ? ADMIN_CHANNEL_BEAUTY
          : ADMIN_CHANNEL_TECH));
  const userId = who === "user" ? USER_ID : ADMIN_ID;
  world.videos.push(
    makeVideo(
      { channelId, userId, folderName, daysAgo: 1, edited: edited || rest.kind === "reEdit" },
      now,
    ),
  );
  addJob(world, { channelId, folderName, userId, state, ...rest }, now);
}

export const SCENARIOS = {
  default: {
    description: "A signed-in admin with two channels; the user account has one.",
    owner: "session",
  },
  "as-user": {
    description: "Signed in as the plain user.",
    owner: "session",
    session: (world) => {
      world.startAs = "user";
    },
  },
  "signed-out": {
    description: "Nobody is signed in: the sign-in page.",
    owner: "session",
    session: (world) => {
      world.startAs = null;
    },
  },
  "needs-setup": {
    description: "A new server without any account: the first-admin setup page.",
    owner: "session",
    session: (world) => {
      world.users = [];
      world.needsSetup = true;
      world.startAs = null;
    },
  },
  "no-channels": {
    description: "Signed in, but nobody has a channel yet.",
    owner: "workspace",
    workspace: (world) => {
      world.channels = [];
    },
    library: (world) => {
      world.videos = [];
    },
  },
  "library-error": {
    description: "getLibrary fails with an io error.",
    owner: "library",
    library: (world) => {
      world.libraryFails = true;
    },
  },
  busy: {
    description: "Many jobs running, pausing, paused and waiting.",
    owner: "jobs",
    jobs: (world) => {
      const now = Date.now();
      active(world, now, "admin", "Serum A", "running", { steps: 8 });
      active(world, now, "admin", "Serum B", "running", { steps: 3 });
      active(world, now, "admin", "Serum C", "pausing");
      active(world, now, "admin", "Serum D", "paused");
      active(world, now, "admin", "Serum E", "queued", { joinedMinutesAgo: 10 });
      active(world, now, "admin", "Serum F", "queued", { joinedMinutesAgo: 5 });
      active(world, now, "user", "Lisbon Day 2", "queued", { joinedMinutesAgo: 3 });
    },
  },
  "queue-full": {
    description: "Every slot of every queue is taken, with jobs waiting behind.",
    owner: "queue",
    queue: (world) => {
      const now = Date.now();
      active(world, now, "admin", "Edit A", "running", { steps: 4 });
      active(world, now, "admin", "Edit B", "running", { steps: 9 });
      active(world, now, "user", "Edit C", "running", { steps: 2 });
      active(world, now, "admin", "Edit D", "queued", { joinedMinutesAgo: 8 });
      active(world, now, "user", "Edit E", "queued", { joinedMinutesAgo: 4 });
      active(
        world,
        now,
        "admin",
        "Timeline A",
        "running",
        { kind: "timelineEdit", steps: 2 },
        true,
      );
      active(
        world,
        now,
        "admin",
        "Timeline B",
        "running",
        { kind: "timelineEdit", steps: 4 },
        true,
      );
      active(world, now, "user", "Timeline C", "queued", { kind: "timelineEdit" }, true);
      active(world, now, "admin", "Render A", "running", { kind: "render", steps: 3 }, true);
      active(world, now, "user", "Render B", "queued", { kind: "render" }, true);
    },
  },
  urgent: {
    description:
      "One edit running; an Urgent one waits first in line, ahead of two plain ones (the start delay holds them).",
    owner: "queue",
    queue: (world) => {
      const now = Date.now();
      const tech = ADMIN_CHANNEL_TECH;
      active(
        world,
        now,
        "admin",
        "Mechanical Keyboard Review",
        "running",
        { steps: 4 },
        false,
        tech,
      );
      world.launches["edits"] = [now - 1000];
      active(
        world,
        now,
        "admin",
        "Desk Lamp Review",
        "queued",
        { joinedMinutesAgo: 20 },
        false,
        tech,
      );
      active(world, now, "user", "Porto Food Tour", "queued", { joinedMinutesAgo: 10 });
      active(
        world,
        now,
        "admin",
        "Webcam Comparison",
        "queued",
        { joinedMinutesAgo: 2, urgent: true },
        false,
        tech,
      );
    },
  },
  "unreachable-channel": {
    description:
      "The folder of the Tech Reviews channel cannot be reached (an unplugged drive): getLibrary reports it unavailable with no videos.",
    owner: "workspace",
    workspace: (world) => {
      const channel = world.channels.find((c) => c.id === ADMIN_CHANNEL_TECH);
      if (channel) channel.available = false;
    },
  },
  "not-ready": {
    description: "The server cannot start edits (readiness problem).",
    owner: "harness",
    system: makeNotReady,
  },
  "usage-critical": {
    description: "The 5-hour limit is above 90 percent.",
    owner: "system",
    system: makeUsageCritical,
  },
  "start-delay": {
    description: "An edit just started, so the start delay holds the waiting ones back.",
    owner: "queue",
    queue: (world) => {
      const now = Date.now();
      active(world, now, "admin", "Serum A", "running", { steps: 1 });
      world.launches["edits"] = [now - 1000];
      active(world, now, "user", "Held A", "queued", { joinedMinutesAgo: 6 });
      active(world, now, "admin", "Held B", "queued", { joinedMinutesAgo: 3 });
    },
  },
  timeline: {
    description: "Videos with projects that open as a timeline (Long, Short, empty, a user's).",
    owner: "timeline",
    timeline: (world) => addTimelineScenario(world, Date.now()),
  },
  "timeline-locked": {
    description: "A timeline that a job holds (a change request is running).",
    owner: "timeline",
    timeline: (world) => addLockedScenario(world, Date.now()),
  },
  "timeline-broken": {
    description: "Projects that fail the profile check or cannot be read.",
    owner: "timeline",
    timeline: (world) => addBrokenScenario(world, Date.now()),
  },
  "timeline-notes": {
    description: "A timeline with change requests in every state.",
    owner: "timeline",
    timeline: (world) => addNotesScenario(world, Date.now()),
  },
  "timeline-copies": {
    description: "A timeline whose preview copies are still being made.",
    owner: "timeline",
    timeline: (world) => addCopiesScenario(world, Date.now()),
  },
  uploads: {
    description: "A video with an unfinished upload (its row shows the progress).",
    owner: "uploads",
    uploads: uploadingPatch,
  },
  uploading: {
    description: "A video with an unfinished upload (its row shows the progress).",
    owner: "uploads",
    uploads: uploadingPatch,
  },
  "disk-large": {
    description: "Large videos for Disk Cleanup, one with a Re-Edit running, two not measured yet.",
    owner: "disk",
    disk: (world) => {
      addLargeDisk(world, Date.now());
    },
  },
  "system-problems": {
    description: "Programs missing, Prepare needed.",
    owner: "system",
    system: makeSystemProblems,
  },
  "system-prepare-fails": {
    description:
      "Prepare is needed and fails at the Python packages (the steps that need them wait).",
    owner: "system",
    system: makePrepareFail,
  },
  "setup-ready": {
    description: "The Claude subscription with Sonnet 5.5 and a high reasoning effort chosen.",
    owner: "harness",
    harness: setupReady,
  },
  "setup-opencode-go": {
    description: "Edits run on OpenCode Go: key saved, model list kept, GLM-5.3 chosen.",
    owner: "harness",
    harness: setupOpencodeGo,
  },
  "setup-anthropic-api": {
    description: "Edits run on an Anthropic compatible API with a key and a typed model.",
    owner: "harness",
    harness: setupAnthropicApi,
  },
  "setup-openai-api": {
    description: "Edits run on an OpenAI compatible API on this computer, without a key.",
    owner: "harness",
    harness: setupOpenaiApi,
  },
  "setup-model-gone": {
    description: "OpenCode Go is selected with a model its list no longer has.",
    owner: "harness",
    harness: setupModelGone,
  },
  "setup-models-fail": {
    description: "Every request for a model list fails (Fetch Models shows the error).",
    owner: "harness",
    harness: setupModelsFail,
  },
  "claude-routed": {
    description: "The server's Claude Code is already pointed at another service.",
    owner: "harness",
    harness: claudeRouted,
  },
  "two-users": {
    description: "As default (both accounts exist); to test that users are separate.",
    owner: "session",
  },
} as const satisfies Record<string, ScenarioDef>;

export type ScenarioName = keyof typeof SCENARIOS;

export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

export function isScenario(value: string): value is ScenarioName {
  return Object.hasOwn(SCENARIOS, value);
}

/** Builds the world of a mock: empty, then every area's seed, then the scenarios' patches. */
export function buildWorld(scenarios: readonly ScenarioName[], now: number = Date.now()): World {
  const world = createEmptyWorld(now);
  seedSession(world, now);
  seedWorkspace(world);
  seedLibrary(world, now);
  seedJobs(world, now);
  seedQueue(world, now);
  seedStorage(world, now);
  seedUploads(world, now);
  seedAdmin(world, now);
  seedHarness(world, now);
  seedTimeline(world, now);
  seedDisk(world, now);
  seedSystem(world, now);
  for (const name of scenarios) {
    const def: ScenarioDef = SCENARIOS[name];
    for (const area of AREAS) def[area]?.(world);
  }
  return world;
}

export interface MockOptions {
  scenarios: ScenarioName[];
  /** Milliseconds every call takes (0 in tests). */
  latencyMs: number;
  /** Job speed factor. */
  speed: number;
  /** Run the tick timer by itself; tests call `tick()` instead. */
  autoTick: boolean;
  /** Real milliseconds that count as one minute of the start delay. */
  minuteMs: number;
  /** Who the browser is signed in as; overrides the scenario (`?as=`). */
  as?: "admin" | "user" | null;
  /** Share a world with other `MockBackend`s (each is one browser of the same server). */
  world?: World;
}

export const MOCK_MINUTE_MS = 6000;

export const DEFAULT_MOCK_OPTIONS: MockOptions = {
  scenarios: ["default"],
  latencyMs: 90,
  speed: 1,
  autoTick: true,
  minuteMs: MOCK_MINUTE_MS,
};

function positiveNumber(value: string | null, fallback: number): number {
  const number = Number(value ?? NaN);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** The mock's options from a URL query (`?scenario=a,b&latency=600&as=user`). */
export function scenarioOptionsFromSearch(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const requested = (params.get("scenario") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(isScenario);
  const isTest = import.meta.env.MODE === "test";
  const as = params.get("as");
  return {
    scenarios: requested.length > 0 ? requested : ["default"],
    latencyMs: positiveNumber(params.get("latency"), isTest ? 0 : DEFAULT_MOCK_OPTIONS.latencyMs),
    speed: Math.max(0.1, positiveNumber(params.get("speed"), 1)),
    autoTick: !isTest && params.get("ticks") !== "off",
    minuteMs: Math.max(1, positiveNumber(params.get("minute"), MOCK_MINUTE_MS)),
    ...(as === "admin" || as === "user" ? { as } : {}),
  };
}

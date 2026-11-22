/**
 * The state of the mock server: everything the areas in `areas/` read and change. One `World`
 * is one server; several `MockBackend`s (browsers) may share it (`MockOptions.world`).
 * It holds plain data only (no functions), so a test can change it before or after loading.
 *
 * Every area owns the fields named in its comment; seeds (`seed/<area>.ts`) fill them and
 * scenarios (`scenarios.ts`) patch them. Times are milliseconds since 1970.
 */
import type {
  AdminSettings,
  ArchivedVideo,
  Channel,
  DiskSizes,
  EditLogEntry,
  HarnessAdminState,
  HarnessPublicView,
  JobView,
  LogEntry,
  OutputFile,
  Readiness,
  Role,
  SystemView,
  Timeline,
  TimelineNote,
  UploadFolder,
  UsageView,
  VideoInputs,
  VideoOutput,
  VideoType,
  ApiModels,
  ApiOption,
  FsEntry,
  RevisionView,
} from "../types";

/** The areas of the mock, in the order seeds and scenario patches are applied. */
export const AREAS = [
  "session",
  "workspace",
  "library",
  "jobs",
  "queue",
  "storage",
  "uploads",
  "admin",
  "harness",
  "timeline",
  "disk",
  "system",
] as const;
export type Area = (typeof AREAS)[number];

/** An account. The password is kept in plain text: this is a fake. */
export interface MockUser {
  id: string;
  email: string;
  password: string;
  role: Role;
  disabled: boolean;
  mayMarkUrgent: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

/** A channel of one user (the wire `Channel` plus its owner). */
export interface MockChannel extends Channel {
  userId: string;
}

/** A video folder of one user. The `VideoView` is computed from this by the library area. */
export interface MockVideo {
  channelId: string;
  folderName: string;
  userId: string;
  createdAt: number;
  detectedType: VideoType | null;
  typeOverride: VideoType | null;
  arollCount: number;
  inputs: VideoInputs;
  output: VideoOutput;
  /** Set when archived (ms). */
  archivedAt: number | null;
  edited: boolean;
  finalRendered: boolean;
  /** Whether the video has working files Disk Cleanup could delete. */
  workingFiles: boolean;
}

/** What the simulated run of a job needs besides its `JobView` (the jobs area owns it). */
export interface JobSim {
  /** Steps of the script done. */
  step: number;
  /** Fractions of a step carried over between ticks (the speed factor). */
  carry: number;
  /** Set by Continue: the job goes on in its session and skips the start delay. */
  resume: boolean;
  /** Set by an admin's Start now: the job skips the start delay. */
  startNow: boolean;
  /** The step after which the run fails, or `null`. */
  failAt: number | null;
  /** The message of that failure. */
  failMessage: string | null;
  /** The next `seq` of the job's log. */
  seq: number;
}

export interface MockJob {
  /** Everything except `position` and `startsAt`, which `queue.ts` computes from the queue. */
  view: JobView;
  /** The Re-Edit text, change request or render size, whatever the job was started with. */
  request: unknown;
  sim: JobSim;
}

export interface MockUpload {
  id: string;
  userId: string;
  videoId: string;
  folder: UploadFolder;
  name: string;
  size: number;
  received: number;
  done: boolean;
}

/** The timeline of one video with its revisions (the timeline area owns it). */
export interface MockTimeline {
  timeline: Timeline;
  revisions: RevisionView[];
  /** Snapshot per revision number, so Restore and Undo can go back. */
  snapshots: Record<number, Timeline>;
  notes: TimelineNote[];
  previewUrl: string | null;
}

export interface MockFsFolder {
  path: string;
  name: string;
  videoCount: number;
  children: FsEntry[];
}

export interface World {
  // session
  users: MockUser[];
  /** Open sessions by token. */
  sessions: Map<string, { userId: string }>;
  needsSetup: boolean;
  setupToken: string;
  serverVersion: string;
  /** Who the first browser of this world is signed in as (`?as=`); `null` is signed out. */
  startAs: "admin" | "user" | null;

  // workspace
  channels: MockChannel[];
  defaultPrompt: string;
  /** Make `getWorkspace` fail with this message (scenario `workspace-error`). */
  workspaceFails: string | null;

  // library
  videos: MockVideo[];
  /** Videos whose archive state changed are in here with their time too (the archive list). */
  archived: ArchivedVideo[];
  /** Make `getLibrary` fail with an io error (scenario `library-error`). */
  libraryFails: boolean;

  // jobs and queue
  jobs: MockJob[];
  jobLogs: Record<string, LogEntry[]>;
  /** Mock launch times per queue, for the start delay. */
  launches: Record<string, number[]>;
  /** When set, every run that starts fails with this sentence after its third step. */
  failJobsWith: string | null;

  // storage and uploads
  fs: MockFsFolder[];
  uploads: MockUpload[];

  // admin and harness
  adminSettings: AdminSettings;
  harness: HarnessAdminState;
  harnessPublic: HarnessPublicView;
  readinessAdmin: Readiness;
  readinessUser: Readiness;
  apiModels: Partial<Record<ApiOption, ApiModels>>;

  // timeline
  timelines: Record<string, MockTimeline>;

  // disk
  diskSizes: Record<string, DiskSizes>;
  /**
   * By video id: how many items of its `CLAUDE_VE` folder Disk Cleanup cannot remove (a file in
   * use, no permission), with the bytes they keep; the server reports them as `leftover`.
   */
  cleanLeftover: Record<string, { items: number; bytes: number }>;

  // system and usage
  system: SystemView;
  usage: UsageView;

  // edit log
  editLog: EditLogEntry[];

  /** Counter behind `nextId`. */
  idCounter: number;
}

/** A new id for a mock record, unique within the world. */
export function nextId(world: World, prefix = "id"): string {
  world.idCounter += 1;
  return `${prefix}${world.idCounter.toString(16).padStart(8, "0")}`;
}

/** An output file (used by seeds). */
export function outputFile(
  name: string,
  path: string,
  size: number,
  modifiedAt: number,
): OutputFile {
  return { name, path, size, modifiedAt };
}

export const EMPTY_OUTPUT: VideoOutput = {
  project: null,
  finals: [],
  newestFinal: null,
  thumbnails: [],
  metaFile: null,
  infoFile: null,
};

export const EMPTY_INPUTS: VideoInputs = {
  productLinks: "",
  notes: "",
  promptSlot: 0,
  styleSlot: 0,
};

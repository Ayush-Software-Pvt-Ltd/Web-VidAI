/**
 * The frozen contract of every call and event between the UI and VidAI Server (SPEC section 14).
 *
 * `RpcMethods` has one entry per RPC function with the exact input object the server validates
 * and the answer it returns, in wire types. A function without input is called with no argument
 * (`api.getLibrary()`); the HTTP backend then posts `{}`. Fields marked `?` may be left out (the
 * server uses its default); wire types themselves never have optional fields.
 *
 * `Api` (in `api.ts`) is derived from it, so a UI, a mock and an HTTP backend cannot drift from
 * each other. `RPC_NAMES` repeats the names of SPEC section 14; a compile-time check and a test
 * fail when the two lists or the SPEC differ.
 */
/* eslint-disable @typescript-eslint/no-invalid-void-type -- `| void` makes the input of a function optional */
import type {
  AddNoteInput,
  AdminQueueView,
  AdminSettings,
  ApiModels,
  ApiOption,
  ApiTest,
  ArchivedVideo,
  Channel,
  ChannelCreate,
  ChannelsDocument,
  ChannelUpdate,
  CleanResult,
  DiskUse,
  EditLogPage,
  EditLogQuery,
  FsCreatedFolder,
  FsListing,
  FsPlace,
  GetJobLogInput,
  HarnessAdminState,
  HarnessPublicView,
  ImportResult,
  JobIdInput,
  JobLog,
  JobQueue,
  JobView,
  Library,
  NoteUpdatedPayload,
  OpenTimelineResult,
  OpencodeUsage,
  PrepareState,
  PreviewCopiesChangedPayload,
  PublicSettings,
  QueueChangedPayload,
  QueueView,
  Readiness,
  ReEditInput,
  RenderFinalInput,
  RevisionView,
  Role,
  SessionInfo,
  Setup,
  StartEditInput,
  SystemView,
  Timeline,
  TimelineChangedPayload,
  TimelineNote,
  TimelineOp,
  UploadFolder,
  UploadTicket,
  UsageUpdate,
  UsageView,
  UserAccount,
  VideoInputs,
  VideoRef,
  VideoType,
  VideoView,
  Workspace,
} from "./types";

/** One function: what it takes and what it answers. */
interface Rpc<Input, Output> {
  input: Input;
  output: Output;
}

export interface RpcMethods {
  // ---- Account (`getSession`, `login` and `setupAdmin` need no session) ----
  getSession: Rpc<void, SessionInfo>;
  login: Rpc<{ email: string; password: string }, SessionInfo>;
  logout: Rpc<void, null>;
  changePassword: Rpc<{ currentPassword: string; newPassword: string }, null>;
  /** `token` is the one in the address `/setup#<token>`. */
  setupAdmin: Rpc<{ token: string; email: string; password: string }, SessionInfo>;

  // ---- Admin (every `admin*` function answers `forbidden` to a user) ----
  adminListUsers: Rpc<void, UserAccount[]>;
  adminCreateUser: Rpc<
    { email: string; password: string; role?: Role | null; mayMarkUrgent?: boolean | null },
    UserAccount
  >;
  adminUpdateUser: Rpc<
    {
      id: string;
      email?: string | null;
      password?: string | null;
      role?: Role | null;
      disabled?: boolean | null;
      mayMarkUrgent?: boolean | null;
    },
    UserAccount
  >;
  adminDeleteUser: Rpc<{ id: string }, null>;
  adminGetSettings: Rpc<void, AdminSettings>;
  /** Any subset of the settings; the answer is the complete, clamped result. */
  adminUpdateSettings: Rpc<Partial<AdminSettings>, AdminSettings>;
  adminGetHarness: Rpc<void, HarnessAdminState>;
  adminSetSetup: Rpc<{ setup: Setup }, HarnessAdminState>;
  adminSetApiBaseUrl: Rpc<{ option: ApiOption; baseUrl: string | null }, HarnessAdminState>;
  adminSetApiKey: Rpc<{ option: ApiOption; key: string }, HarnessAdminState>;
  adminClearApiKey: Rpc<{ option: ApiOption }, HarnessAdminState>;
  adminSetApiModel: Rpc<{ option: ApiOption; model: string | null }, HarnessAdminState>;
  adminSetApiEffort: Rpc<
    { option: ApiOption; model: string; effort: string | null },
    HarnessAdminState
  >;
  /** The Claude subscription's model and effort (`null` is Claude Code's own default). */
  adminSetModelSelection: Rpc<{ model: string | null; effort: string | null }, HarnessAdminState>;
  adminGetApiModels: Rpc<{ option: ApiOption; refresh?: boolean | null }, ApiModels>;
  adminTestApi: Rpc<{ option: ApiOption }, ApiTest>;
  adminGetSystem: Rpc<void, SystemView>;
  /** Starts Prepare and answers at once; the steps follow through `system-changed`. */
  adminPrepareToolkit: Rpc<void, PrepareState>;
  adminGetQueue: Rpc<void, AdminQueueView>;
  adminSetJobUrgent: Rpc<{ jobId: string; urgent: boolean }, JobView>;
  adminStartJobNow: Rpc<JobIdInput, JobView>;

  // ---- Workspace ----
  /** `readiness` of the answer is always `null`: ask `getReadiness`. */
  getWorkspace: Rpc<void, Workspace>;
  getHarness: Rpc<void, HarnessPublicView>;
  getReadiness: Rpc<void, Readiness>;
  getOpencodeUsage: Rpc<{ refresh?: boolean | null } | void, OpencodeUsage>;
  createChannel: Rpc<ChannelCreate, Channel>;
  updateChannel: Rpc<{ id: string; update: ChannelUpdate }, Channel>;
  removeChannel: Rpc<{ id: string }, null>;
  reorderChannels: Rpc<{ ids: string[] }, Channel[]>;
  getDefaultPrompt: Rpc<void, string>;
  exportChannels: Rpc<void, ChannelsDocument>;
  importChannels: Rpc<{ document: ChannelsDocument }, ImportResult>;

  // ---- Library ----
  getLibrary: Rpc<void, Library>;
  createVideo: Rpc<{ channelId: string; name: string }, VideoRef>;
  /** `videoType: null` removes the override. The answer is the video's new `VideoView`. */
  setVideoTypeOverride: Rpc<{ videoId: string; videoType: VideoType | null }, VideoView>;
  getVideoInputs: Rpc<{ videoId: string }, VideoInputs>;
  setVideoInputs: Rpc<{ videoId: string; inputs: VideoInputs }, VideoInputs>;
  archiveVideo: Rpc<{ videoId: string }, null>;
  unarchiveVideo: Rpc<{ videoId: string }, null>;
  getArchived: Rpc<void, ArchivedVideo[]>;
  /** A user reads their own entries; `userId` and `all` are for admins. Newest first. */
  getEditLog: Rpc<Partial<EditLogQuery> | void, EditLogPage>;

  // ---- Jobs (a job is addressed by `jobId` once it exists) ----
  startEdit: Rpc<StartEditInput, JobView>;
  reEdit: Rpc<ReEditInput, JobView>;
  pauseJob: Rpc<JobIdInput, JobView>;
  continueJob: Rpc<JobIdInput, JobView>;
  stopJob: Rpc<JobIdInput, JobView>;
  /** The entries with `seq` above `after` (the whole log when `null`). */
  getJobLog: Rpc<GetJobLogInput, JobLog>;
  getQueue: Rpc<void, QueueView>;
  getUsage: Rpc<{ refresh?: boolean | null } | void, UsageView>;

  // ---- Timeline ----
  openTimeline: Rpc<{ videoId: string }, OpenTimelineResult>;
  getTimeline: Rpc<{ videoId: string }, Timeline>;
  /** `revision` is the revision the edit was made on; an older one answers `conflict`. */
  editTimeline: Rpc<{ videoId: string; revision: number; op: TimelineOp }, Timeline>;
  undoTimeline: Rpc<{ videoId: string }, Timeline>;
  redoTimeline: Rpc<{ videoId: string }, Timeline>;
  listRevisions: Rpc<{ videoId: string }, RevisionView[]>;
  restoreRevision: Rpc<{ videoId: string; n: number }, Timeline>;
  addTimelineNote: Rpc<{ videoId: string } & AddNoteInput, TimelineNote>;
  deleteTimelineNote: Rpc<{ videoId: string; noteId: string }, null>;
  retryTimelineNote: Rpc<{ videoId: string; noteId: string }, TimelineNote>;
  renderFinal: Rpc<RenderFinalInput, JobView>;

  // ---- Storage ----
  fsPlaces: Rpc<void, FsPlace[]>;
  /** `path: null` (or left out) lists the top; folders only. */
  fsList: Rpc<{ path?: string | null } | void, FsListing>;
  fsCreateFolder: Rpc<{ parent: string; name: string }, FsCreatedFolder>;
  createUpload: Rpc<
    { videoId: string; folder: UploadFolder; name: string; size: number },
    UploadTicket
  >;
  cancelUpload: Rpc<{ id: string }, null>;

  // ---- Disk ----
  getDiskUse: Rpc<void, DiskUse>;
  cleanWorkingFiles: Rpc<{ videoId: string }, CleanResult>;
}

export type RpcName = keyof RpcMethods;
export type RpcInput<K extends RpcName> = RpcMethods[K]["input"];
export type RpcOutput<K extends RpcName> = RpcMethods[K]["output"];

/** The functions of SPEC section 14, in its order. Checked against `RpcMethods` both ways. */
export const RPC_NAMES = [
  // Account
  "getSession",
  "login",
  "logout",
  "changePassword",
  "setupAdmin",
  // Admin
  "adminListUsers",
  "adminCreateUser",
  "adminUpdateUser",
  "adminDeleteUser",
  "adminGetSettings",
  "adminUpdateSettings",
  "adminGetHarness",
  "adminSetSetup",
  "adminSetApiBaseUrl",
  "adminSetApiKey",
  "adminClearApiKey",
  "adminSetApiModel",
  "adminSetApiEffort",
  "adminSetModelSelection",
  "adminGetApiModels",
  "adminTestApi",
  "adminGetSystem",
  "adminPrepareToolkit",
  "adminGetQueue",
  "adminSetJobUrgent",
  "adminStartJobNow",
  // Workspace
  "getWorkspace",
  "getHarness",
  "getReadiness",
  "getOpencodeUsage",
  "createChannel",
  "updateChannel",
  "removeChannel",
  "reorderChannels",
  "getDefaultPrompt",
  "exportChannels",
  "importChannels",
  // Library
  "getLibrary",
  "createVideo",
  "setVideoTypeOverride",
  "getVideoInputs",
  "setVideoInputs",
  "archiveVideo",
  "unarchiveVideo",
  "getArchived",
  "getEditLog",
  // Jobs
  "startEdit",
  "reEdit",
  "pauseJob",
  "continueJob",
  "stopJob",
  "getJobLog",
  "getQueue",
  "getUsage",
  // Timeline
  "openTimeline",
  "getTimeline",
  "editTimeline",
  "undoTimeline",
  "redoTimeline",
  "listRevisions",
  "restoreRevision",
  "addTimelineNote",
  "deleteTimelineNote",
  "retryTimelineNote",
  "renderFinal",
  // Storage
  "fsPlaces",
  "fsList",
  "fsCreateFolder",
  "createUpload",
  "cancelUpload",
  // Disk
  "getDiskUse",
  "cleanWorkingFiles",
] as const satisfies readonly RpcName[];

// Compile-time check, other direction: a function added to `RpcMethods` must be in `RPC_NAMES`.
export const ALL_RPC_NAMES_LISTED: Exclude<RpcName, (typeof RPC_NAMES)[number]> extends never
  ? true
  : never = true;

/** Functions that need no session (the page asks them while signed out). */
export const PUBLIC_RPC_NAMES = [
  "getSession",
  "login",
  "setupAdmin",
] as const satisfies readonly RpcName[];

// ---------------------------------------------------------------------------------------------
// Events (SPEC section 14). `hello` (the server's instance id, first on every stream) is handled
// by the transport and never reaches the UI.

/** Why a session ended without the user asking (`logout` ends only the page's own session). */
export type SessionEndReason = "passwordChanged" | "disabled" | "removed";

/**
 * `reason` is `null` when the server closed the stream without saying why. The server sends the
 * reason first and then a payload-less `session-ended` as it closes the stream; the transport
 * turns the second into `{ reason: null }`.
 */
export interface SessionEndedPayload {
  reason: SessionEndReason | null;
}

/**
 * What `settings-changed` carries. A change of the admin settings sends only the public settings;
 * a change of the harness adds `harness` (what users may see of it). Without `harness`, ask
 * `getHarness`.
 */
export type SettingsChangedPayload = PublicSettings & { harness?: HarnessPublicView };

/** Payload of each event by its name on the wire. */
export interface EventPayloads {
  /** `null` means "something changed, ask `getLibrary`" (channel and upload changes). */
  "library-changed": Library | null;
  /** Admins also get the jobs of everybody; check `job.userId`. */
  "job-updated": JobView;
  "job-log": JobLog;
  /** Only says which queue changed: ask `getQueue` (admins `adminGetQueue`). */
  "queue-changed": QueueChangedPayload;
  "settings-changed": SettingsChangedPayload;
  "timeline-changed": TimelineChangedPayload;
  "note-updated": NoteUpdatedPayload;
  /** The smooth preview copies of an open video's heavy media (SPEC section 11, Preview copies). */
  "preview-copies-changed": PreviewCopiesChangedPayload;
  /** Partial: merge what is present. */
  "usage-updated": UsageUpdate;
  /** Admins only, no payload: ask `adminGetSystem`. */
  "system-changed": null;
  /** The whole `DiskUse` of the user it concerns (the server sends it after a cleanup, SPEC section 14). */
  "disk-use-changed": DiskUse;
  "session-ended": SessionEndedPayload;
}

export type EventName = keyof EventPayloads;

export const EVENT_NAMES = [
  "library-changed",
  "job-updated",
  "job-log",
  "queue-changed",
  "settings-changed",
  "timeline-changed",
  "note-updated",
  "preview-copies-changed",
  "usage-updated",
  "system-changed",
  "disk-use-changed",
  "session-ended",
] as const satisfies readonly EventName[];

export const ALL_EVENT_NAMES_LISTED: Exclude<EventName, (typeof EVENT_NAMES)[number]> extends never
  ? true
  : never = true;

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

/** The name of an event as a member of `ApiEvents`: `library-changed` is `libraryChanged`. */
export type EventMethod<E extends EventName = EventName> = CamelCase<E>;

/** `library-changed` to `libraryChanged`. */
export function eventMethodName<E extends EventName>(name: E): EventMethod<E> {
  return name.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  ) as EventMethod<E>;
}

/** The queues, for code that lists them (`JobQueue` itself comes from the wire). */
export const JOB_QUEUES = ["edits", "timeline", "renders"] as const satisfies readonly JobQueue[];

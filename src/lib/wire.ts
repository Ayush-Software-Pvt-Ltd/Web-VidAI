// The types that cross the wire between VidAI Server and the browser (docs/SPEC.md section 3).
// Pure declarations: no imports, no runtime code. Every field is always present (`null` when
// empty); nothing is optional. The server refers to these in JSDoc, the UI imports them.

/** Why a call failed; the HTTP status follows from it (SPEC section 3). */
export type ErrorCode =
  | "invalidInput"
  | "notFound"
  | "conflict"
  | "forbidden"
  | "unauthenticated"
  | "notReady"
  | "io"
  | "internal"
  | "tooLarge"
  | "rateLimited";

/** The body of every failed call: a code to branch on and a sentence to show. */
export interface WireError {
  code: ErrorCode;
  message: string;
  /**
   * The input field the sentence is about (`email`, `password`, `currentPassword`, ...), so a form
   * can put it under that field; absent when the refusal is not about one field (for example a wrong
   * email or password at sign-in, which never says which of the two was wrong).
   */
  field?: string;
}

/** An admin can do everything a user can, plus the admin functions (SPEC section 4). */
export type Role = "admin" | "user";

/** The signed-in account as the UI needs it. */
export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  /** Whether Start Editing and Re-Edit offer the Urgent checkbox (SPEC section 8). */
  mayMarkUrgent: boolean;
}

/** What `getSession` answers; it never fails for a signed-out visitor. */
export interface SessionInfo {
  /** `null` when nobody is signed in. */
  user: SessionUser | null;
  /** True while no enabled admin exists yet: the page offers the first-admin setup (SPEC section 2). */
  needsSetup: boolean;
  serverVersion: string;
}

/** One row of the admin's account list (SPEC section 4). */
export interface UserAccount {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  mayMarkUrgent: boolean;
  /** Milliseconds since 1970. */
  createdAt: number;
  /** Milliseconds since 1970 of the last request with a session; `null` if never signed in. */
  lastSeenAt: number | null;
  /** Jobs of this account that are queued, running, pausing, paused or stopping. */
  activeJobs: number;
}

/** The four ways a new edit can run (SPEC section 5, "Harness, program and model"). */
export type Setup = "claudeSubscription" | "opencodeGo" | "anthropicApi" | "openaiApi";

/**
 * Every admin setting of SPEC section 5, always complete and already clamped.
 * The API options (address, key status, model, efforts) are added to the harness part later.
 */
export interface AdminSettings {
  setup: Setup;

  /** Edits at the same time, 1 to 8. */
  maxEdits: number;
  /** Timeline changes at the same time, 1 to 8. */
  maxTimelineEdits: number;
  /** Renders at the same time, 1 to 4. */
  maxRenders: number;
  /** Edits of one user at the same time, 0 (no limit) to 8. */
  maxEditsPerUser: number;
  /** Pause between two edit launches in minutes, 0 to 120. */
  startDelayMinutes: number;
  /** Retries after a model error, 0 to 50. */
  maxModelRetries: number;

  /** Percentages, 5 to 100 in steps of 5 (SPEC section 9). */
  cpuPerEditPercent: number;
  cpuTotalPercent: number;
  gpuPerEditPercent: number;
  gpuTotalPercent: number;

  /**
   * Absolute folders inside which users may place channels. The default storage folder
   * `<data dir>/media` is always one too and is not listed here.
   */
  storageRoots: string[];
  /** The largest single upload in GB, 1 to 2000. */
  maxUploadGb: number;
  /** Size in GB of the preview copies kept before the oldest are deleted, 1 to 2000. */
  proxyCacheGb: number;
}

/** What every signed-in user may see of the settings: the setup and the limits that show in the UI. */
export interface PublicSettings {
  setup: Setup;
  maxUploadGb: number;
  maxEditsPerUser: number;
  startDelayMinutes: number;
}

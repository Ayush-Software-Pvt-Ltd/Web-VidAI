// Wire types of the admin's System page (docs/SPEC.md sections 5, 7 and 14; written by
// `server/src/system.js` and `server/src/toolkit/`): the server, the data directory, the toolkit
// and its Prepare steps, the programs found, the CPU and GPU limits and counts. Pure
// declarations; every field is always present (`null` when empty). Times are milliseconds since
// 1970.

import type { JobState } from "./jobs.ts";

/** The steps of Prepare (SPEC section 7), in the order they run. */
export type PrepareStepId =
  "python" | "venv" | "packages" | "ffmpeg" | "doctor" | "speech" | "browser" | "render";

export type PrepareStepState = "pending" | "running" | "done" | "failed";

/** What a step that did not succeed holds back. */
export type PrepareBlocks = "editing" | "rendering";

/** One step of Prepare with its recorded result; kept across restarts. */
export interface PrepareStep {
  id: PrepareStepId;
  /** "Python", "Python packages", ... */
  label: string;
  state: PrepareStepState;
  /** A sentence for the admin: what was found, or what is wrong and how to fix it. */
  message: string | null;
  /** When the step last finished (or started, while it runs); `null` while it never ran. */
  at: number | null;
  /** `editing`: edits cannot start until the step is `done`; `rendering`: only renders cannot. */
  blocks: PrepareBlocks;
}

/** Prepare as the System page shows it. */
export interface PrepareState {
  /** A Prepare is running now. */
  running: boolean;
  steps: PrepareStep[];
  /** The last lines of what the steps printed (pip's output included), oldest first. */
  log: string[];
  startedAt: number | null;
  finishedAt: number | null;
  /** The environment must be prepared again (first start, or the packages changed). */
  needsPrepare: boolean;
  /** Why `needsPrepare` is set; `null` when it is not. */
  reason: string | null;
  /** Every step that blocks editing is done and nothing needs preparing: edits may start. */
  editReady: boolean;
  /** The steps that block rendering are done as well. */
  renderReady: boolean;
}

/** A program the server uses (Claude Code, OpenCode 2, ffmpeg, ffprobe, Python, HyperFrames). */
export interface ProgramInfo {
  /** `claude`, `opencode`, `ffmpeg`, `ffprobe`, `python`, `hyperframes`. */
  id: string;
  label: string;
  found: boolean;
  path: string | null;
  version: string | null;
  /** A sentence: what is wrong and how to fix it, or an extra fact (a login, an encoder). */
  note: string | null;
}

export interface SystemToolkit {
  /** `<data dir>/toolkit/VERSION`; `null` when nothing is installed. */
  installedVersion: string | null;
  /** The repository's `toolkit/VERSION`; `null` when the shipped toolkit cannot be read. */
  shippedVersion: string | null;
  /** Installed and the same as the shipped one. */
  upToDate: boolean;
  /** Why installing or upgrading failed, in a sentence; `null` when it did not. */
  installError: string | null;
  /** `<data dir>/toolkit/CLAUDE_VE_ALL`. */
  folder: string;
  /** The environment's Python (`venv/bin/python` or `venv\Scripts\python.exe`). */
  python: string;
  /** The previous toolkit folder (`CLAUDE_VE_ALL.previous`) exists. */
  hasPrevious: boolean;
}

export interface SystemGpuSlot {
  index: number;
  jobId: string | null;
  pid: number | null;
  /** When it was taken. */
  at: number | null;
  ageMs: number;
  state: "held" | "expired" | "holder gone" | "unreadable";
}

export interface SystemCounts {
  users: { total: number; admins: number; disabled: number };
  channels: number;
  /** Jobs by state; every state is present. */
  jobs: Record<JobState, number>;
}

/** The answer of `adminGetSystem`. */
export interface SystemView {
  server: {
    version: string;
    node: string;
    /** "macOS 15.1 (arm64)", "Windows 11 (x64)". */
    os: string;
    hostname: string;
    startedAt: number;
  };
  dataDir: {
    path: string;
    /** Free space of the disk that holds it; `null` when it cannot be read. */
    freeBytes: number | null;
    totalBytes: number | null;
  };
  /** The addresses the server can be reached at, `https://host:port`. */
  addresses: string[];
  toolkit: SystemToolkit;
  prepare: PrepareState;
  programs: ProgramInfo[];
  cpu: { processors: number; running: number; budget: number };
  gpu: { total: number; perJob: number; slots: SystemGpuSlot[] };
  counts: SystemCounts;
}

/**
 * The types of the UI. Everything that crosses the wire between VidAI Server and the browser is
 * defined once in `wire.ts` and `wire/*.ts` (the server owns them, never edit them from the UI);
 * this module re-exports all of them, so import types from here:
 *
 * ```ts
 * import type { JobView, Library, VideoView } from "@/lib/types";
 * ```
 *
 * Below the re-exports are the few UI-side constants and types that are not wire types.
 * Nothing here is generated: the wire types are plain declarations in `wire.ts` and `wire/`.
 */
export * from "./wire.ts";
export * from "./wire/channels.ts";
export * from "./wire/disk.ts";
export * from "./wire/editLog.ts";
export * from "./wire/harness.ts";
export * from "./wire/jobs.ts";
export * from "./wire/library.ts";
export * from "./wire/log.ts";
export * from "./wire/progress.ts";
export * from "./wire/render.ts";
export * from "./wire/storage.ts";
export * from "./wire/system.ts";
export * from "./wire/timeline.ts";
export * from "./wire/usage.ts";

/** States in which a video has an active job (SPEC section 8); same as `ActiveJobState`. */
export const ACTIVE_JOB_STATES = ["queued", "running", "pausing", "paused", "stopping"] as const;

/**
 * Allowed range of the text size in px (kept per browser in local storage), its default, and
 * `base`, the size the UI is designed at.
 */
export const TEXT_SIZE = { min: 11, max: 20, default: 15, base: 13 } as const;

/** Allowed range of the start delay in minutes; 0 means no delay (`AdminSettings`). */
export const START_DELAY_MINUTES = { min: 0, max: 120, default: 10 } as const;

/** How many prompts and how many styles each of Long and Short has, always exactly (server). */
export const CHANNEL_SLOTS = 5;
/** Longest name of a prompt or style, in characters (server). */
export const MAX_SLOT_NAME_CHARS = 40;

/** `getJobLog` may return a long log; the UI keeps at most this many entries per job. */
export const MAX_LOG_ENTRIES = 5000;

/** The appearance choices, kept per browser (Task 5 moves their code into `src/app/appearance.ts`). */
export type Theme = "system" | "light" | "dark";

/**
 * Legacy, used only by `platform.ts` (shortcut keys by the operating system of the browser) until
 * Task 5 replaces it. Not a wire type.
 */
export type Platform = "macos" | "windows";

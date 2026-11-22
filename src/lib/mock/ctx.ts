/**
 * What an area module gets: the world, the signed-in user, the event bus, the clock, the tick
 * registry and the error helpers. An area is `(ctx: MockCtx) => Partial<Api>`; `MockBackend`
 * merges the areas (a function nobody implements throws "not implemented in the mock yet").
 */
import type { ConnectionStore } from "../connection";
import { ApiError } from "../errors";
import type { EventName, EventPayloads, SessionEndReason } from "../rpc";
import type { ErrorCode } from "../types";
import type { MockUser, World } from "./world";

/** Who an event is for (as on the server): a user, admins too, or every signed-in session. */
export interface EventTarget {
  userId?: string | null;
  admins?: boolean;
}

export interface MockClock {
  now: () => number;
  /** Real milliseconds that count as one minute of the start delay (`?minute=`). */
  minuteMs: number;
  /** Job speed factor (`?speed=`). */
  speed: number;
}

/** Work that runs on every tick (job progress, upload chunks, usage drift). */
export interface TickRegistry {
  /** Registers `work` (called with the time of the tick); returns the function that removes it. */
  register: (name: string, work: (now: number) => void) => () => void;
  /** Runs every registered work once (tests call this; `autoTick` calls it on a timer). */
  tick: () => void;
}

export type MockErrors = Record<
  | "notFound"
  | "conflict"
  | "invalidInput"
  | "forbidden"
  | "unauthenticated"
  | "notReady"
  | "tooLarge"
  | "rateLimited"
  | "io",
  (message?: string) => ApiError
>;

export interface MockCtx {
  world: World;
  options: { latencyMs: number; autoTick: boolean };
  clock: MockClock;
  ticks: TickRegistry;
  errors: MockErrors;
  connection: ConnectionStore;
  /** Who this browser is signed in as, `null` when nobody. */
  user: () => MockUser | null;
  /** The signed-in user, or `unauthenticated`. */
  requireUser: () => MockUser;
  /** The signed-in admin, `unauthenticated` when nobody, `forbidden` for a user. */
  requireAdmin: () => MockUser;
  /** The token of this browser's session (`null` when signed out), for the session area. */
  session: { get: () => string | null; set: (token: string | null) => void };
  /**
   * Ends the sessions of an account (all but `exceptToken`): their browsers get `session-ended`
   * with `reason` and are signed out. Returns how many ended.
   */
  endSessions: (
    userId: string,
    options: { exceptToken?: string | null; reason: SessionEndReason },
  ) => number;
  /** Publishes an event to the browsers it is for. */
  emit: <E extends EventName>(event: E, payload: EventPayloads[E], to?: EventTarget) => void;
  /** Delivers an event to this browser only (what a closing event stream does). */
  emitHere: <E extends EventName>(event: E, payload: EventPayloads[E]) => void;
  /** Runs `work` the way a call does: after the latency, with the answer deep-cloned. */
  run: <T>(work: () => T) => Promise<T>;
}

export const FAILURE_MESSAGES: Record<ErrorCode, string> = {
  invalidInput: "That is not valid.",
  notFound: "That does not exist.",
  conflict: "That is not possible right now.",
  forbidden: "You are not allowed to do that.",
  unauthenticated: "Sign in to continue.",
  notReady: "This server is not ready for that yet.",
  io: "Something went wrong on the server.",
  internal: "Something went wrong.",
  tooLarge: "That is too large.",
  rateLimited: "Too many tries. Wait a little and try again.",
};

export function createErrors(): MockErrors {
  const make = (code: ErrorCode) => (message?: string) =>
    new ApiError(code, message ?? FAILURE_MESSAGES[code]);
  return {
    notFound: make("notFound"),
    conflict: make("conflict"),
    invalidInput: make("invalidInput"),
    forbidden: make("forbidden"),
    unauthenticated: make("unauthenticated"),
    notReady: make("notReady"),
    tooLarge: make("tooLarge"),
    rateLimited: make("rateLimited"),
    io: make("io"),
  };
}

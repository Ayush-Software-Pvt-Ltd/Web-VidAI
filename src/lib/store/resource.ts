import type { ApiError } from "../errors";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

/**
 * Something loaded from the server: `data` is kept while refreshing and after an error (so screens
 * do not flash), `error` is the last failure, `status` says where the load is.
 */
export interface Resource<T> {
  data: T | null;
  status: ResourceStatus;
  error: ApiError | null;
}

export const idle = <T>(): Resource<T> => ({ data: null, status: "idle", error: null });

export const ready = <T>(data: T): Resource<T> => ({ data, status: "ready", error: null });

/** The newest-wins guard for loads that can overlap: `ticket()` issues, `isCurrent` checks. */
export function createTicket() {
  let last = 0;
  return {
    next: () => ++last,
    isCurrent: (value: number) => value === last,
  };
}

/**
 * Makes a refresh safe to call from every event: at most one run is in flight, and any number of
 * calls during it cost exactly one more run afterwards (that run sees everything that happened
 * meanwhile). Every caller's promise settles when the work it asked for is done. `cancel` drops
 * the queued run (the user signed out).
 */
export function coalesced(run: () => Promise<void>): {
  (): Promise<void>;
  /** True while a run is in flight. */
  busy: () => boolean;
  cancel: () => void;
} {
  let inFlight: Promise<void> | null = null;
  let queued = false;
  // A call, so the loop below is not narrowed to "never repeats" (the trigger can set it meanwhile).
  const isQueued = () => queued;
  const trigger = async (): Promise<void> => {
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const current = (async () => {
      do {
        queued = false;
        await run();
      } while (isQueued());
    })();
    inFlight = current;
    try {
      await current;
    } finally {
      if (inFlight === current) inFlight = null;
    }
  };
  return Object.assign(trigger, {
    busy: () => inFlight !== null,
    cancel: () => {
      queued = false;
    },
  });
}

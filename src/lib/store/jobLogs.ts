import type { ApiError } from "../errors";
import { toApiError } from "../errors";
import type { JobLog, LogEntry } from "../types";
import { MAX_LOG_ENTRIES } from "../types";
import type { SliceContext } from "./ctx";
import type { ResourceStatus } from "./resource";

/** The live log of the latest job of one video. */
export interface JobLogState {
  jobId: string | null;
  entries: LogEntry[];
  status: ResourceStatus;
  error: ApiError | null;
}

export interface JobLogsState {
  /** Keyed by video id. */
  jobLogs: Record<string, JobLogState>;
}

export interface JobLogsActions {
  /** Loads the log of a job (the whole log, or only what came after what is shown). */
  loadJobLog: (videoId: string, jobId: string) => Promise<void>;
  /**
   * Appends the entries of a `job-log` event (a different job replaces the old log). Lines of a
   * video whose log nobody opened (`loadJobLog`) are ignored: they would only use memory.
   */
  appendJobLog: (log: JobLog) => void;
  /** Forgets the log of a video (the panel closed). */
  forgetJobLog: (videoId: string) => void;
}

export type JobLogsSlice = JobLogsState & JobLogsActions;

const cap = (entries: LogEntry[]) =>
  entries.length > MAX_LOG_ENTRIES ? entries.slice(entries.length - MAX_LOG_ENTRIES) : entries;

/** The shown lines plus the ones not shown yet, once each and in the order of their `seq`. */
function merge(shown: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const known = new Set(shown.map((entry) => entry.seq));
  const fresh = incoming.filter((entry) => {
    if (known.has(entry.seq)) return false;
    known.add(entry.seq);
    return true;
  });
  if (fresh.length === 0) return shown;
  const merged = [...shown, ...fresh];
  const last = shown[shown.length - 1];
  // Lines normally arrive in order; a load answered after newer lines came by event is the exception.
  return cap(
    last && fresh[0] && fresh[0].seq < last.seq ? merged.sort((a, b) => a.seq - b.seq) : merged,
  );
}

export function createJobLogsSlice({ api, set, get, generation }: SliceContext): JobLogsSlice {
  return {
    jobLogs: {},
    async loadJobLog(videoId, jobId) {
      const shown = get().jobLogs[videoId];
      const same = shown?.jobId === jobId;
      const last = same ? shown.entries[shown.entries.length - 1] : undefined;
      set((s) => ({
        jobLogs: {
          ...s.jobLogs,
          [videoId]: {
            jobId,
            entries: same ? shown.entries : [],
            status: "loading",
            error: null,
          },
        },
      }));
      const was = generation();
      try {
        const log = await api.getJobLog({ jobId, after: last?.seq ?? null });
        if (was !== generation()) return;
        set((s) => {
          const now = s.jobLogs[videoId];
          if (now?.jobId !== jobId) return {};
          return {
            jobLogs: {
              ...s.jobLogs,
              [videoId]: {
                jobId,
                entries: merge(now.entries, log.entries),
                status: "ready",
                error: null,
              },
            },
          };
        });
      } catch (error) {
        if (was !== generation()) return;
        set((s) => {
          const now = s.jobLogs[videoId];
          if (now?.jobId !== jobId) return {};
          return {
            jobLogs: {
              ...s.jobLogs,
              [videoId]: { ...now, status: "error", error: toApiError(error) },
            },
          };
        });
      }
    },
    appendJobLog({ videoId, jobId, entries }) {
      set((s) => {
        const now = s.jobLogs[videoId];
        if (!now) return {};
        const same = now.jobId === jobId;
        return {
          jobLogs: {
            ...s.jobLogs,
            [videoId]: same
              ? { ...now, entries: merge(now.entries, entries) }
              : { jobId, entries: merge([], entries), status: "ready", error: null },
          },
        };
      });
    },
    forgetJobLog: (videoId) =>
      set((s) => ({
        jobLogs: Object.fromEntries(Object.entries(s.jobLogs).filter(([key]) => key !== videoId)),
      })),
  };
}

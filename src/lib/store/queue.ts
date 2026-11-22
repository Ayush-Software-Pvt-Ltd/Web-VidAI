import type { AdminQueueEntry, ActiveJobState, JobView } from "../types";
import { ACTIVE_JOB_STATES } from "../types";
import type { QueueView } from "../types";
import type { SliceContext } from "./ctx";
import { coalesced, idle, type Resource } from "./resource";

export interface QueueState {
  /** The user's waiting and running jobs and the counts of the three queues (`getQueue`). */
  queue: Resource<QueueView>;
}

export interface QueueActions {
  /** Coalesced like `refreshLibrary`. */
  refreshQueue: () => Promise<void>;
  /**
   * Brings a job of the user's own queue list (`queue`) and of the admin's list (`adminQueue`)
   * up to date at once; the lists themselves are refetched on `queue-changed`. Does nothing for
   * a list that is not loaded.
   */
  applyJobToQueues: (job: JobView) => void;
}

export type QueueSlice = QueueState & QueueActions;

const isActive = (state: JobView["state"]) =>
  (ACTIVE_JOB_STATES as readonly string[]).includes(state);

export function createQueueSlice({ api, set, get, load, onReset }: SliceContext): QueueSlice {
  const refresh = coalesced(() => load("queue", () => api.getQueue()));
  onReset(refresh.cancel);

  return {
    queue: idle(),
    refreshQueue: refresh,
    applyJobToQueues(job) {
      set((s) => {
        const patch: Partial<typeof s> = {};
        const own = s.queue.data;
        if (own?.jobs.some((entry) => entry.job.id === job.id)) {
          patch.queue = {
            ...s.queue,
            data: {
              ...own,
              jobs: own.jobs.flatMap((entry) =>
                entry.job.id !== job.id ? [entry] : isActive(job.state) ? [{ ...entry, job }] : [],
              ),
            },
          };
        }
        const admin = s.adminQueue.data;
        if (admin?.jobs.some((entry) => entry.jobId === job.id)) {
          patch.adminQueue = {
            ...s.adminQueue,
            data: {
              ...admin,
              jobs: admin.jobs.flatMap((entry) =>
                entry.jobId !== job.id
                  ? [entry]
                  : isActive(job.state)
                    ? [adminEntryOf(entry, job)]
                    : [],
              ),
            },
          };
        }
        return patch;
      });
      // A job that is new to a loaded list needs the names of its channel and video, which only
      // the list itself has: ask for it.
      const { queue, adminQueue } = get();
      if (isActive(job.state)) {
        if (adminQueue.data && !adminQueue.data.jobs.some((e) => e.jobId === job.id)) {
          void get().loadAdminQueue();
        }
        if (
          queue.data &&
          job.userId === get().session.data?.user?.id &&
          !queue.data.jobs.some((e) => e.job.id === job.id)
        ) {
          void get().refreshQueue();
        }
      }
    },
  };
}

function adminEntryOf(entry: AdminQueueEntry, job: JobView): AdminQueueEntry {
  return {
    ...entry,
    queue: job.queue,
    kind: job.kind,
    state: job.state as ActiveJobState,
    urgent: job.urgent,
    position: job.position,
    startsAt: job.startsAt,
    joinedAt: job.joinedAt,
  };
}

/**
 * What holds the project right now. The timeline carries `locked` as it was when it was loaded;
 * a job that starts afterwards (the change request the user just sent) is seen on the video's job
 * in the library, which the server keeps current. The lock is the job's, so this is the same
 * fact, only fresher: the screen turns hand edits off at once instead of waiting for a refusal.
 */
import { useAppState } from "@/lib/appEnv";
import { findJob } from "@/lib/store";
import { ACTIVE_JOB_STATES, type Timeline, type TimelineLock } from "@/lib/types";

export function useLock(videoId: string, timeline: Timeline): TimelineLock | null {
  const job = useAppState((s) => findJob(s.library.data, videoId));
  if (timeline.locked) return timeline.locked;
  if (job && (ACTIVE_JOB_STATES as readonly string[]).includes(job.state)) {
    return { jobId: job.id, kind: job.kind };
  }
  return null;
}

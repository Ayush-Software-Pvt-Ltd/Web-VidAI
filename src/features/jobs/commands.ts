/**
 * The job commands with their ids typed apart: pause, continue, stop and start now take the id of
 * a JOB, start, re-edit and render take the id of a VIDEO (`<channelId>/<folder name>`). Both are
 * plain strings on the wire, so a mix-up would compile and fail at the server as `notFound`; the
 * two brands make it a type error. The only way to get one is `jobIdOf` and `videoIdOf`.
 *
 * Every command goes through the store's actions, which put the answer into the state and refresh
 * the library (the video's `actions` are computed by the server).
 */
import type { AppStore } from "@/lib/store";
import type { JobView, RenderResolution, VideoView } from "@/lib/types";

declare const jobIdBrand: unique symbol;
declare const videoIdBrand: unique symbol;

/** The id of a job (`JobView.id`). */
export type JobId = string & { readonly [jobIdBrand]: true };
/** The id of a video (`VideoView.id`). */
export type VideoId = string & { readonly [videoIdBrand]: true };

export function jobIdOf(job: Pick<JobView, "id">): JobId {
  return job.id as JobId;
}

export function videoIdOf(video: Pick<VideoView, "id">): VideoId {
  return video.id as VideoId;
}

export interface JobCommands {
  startEdit: (videoId: VideoId, urgent: boolean) => Promise<JobView>;
  reEdit: (videoId: VideoId, text: string, urgent: boolean) => Promise<JobView>;
  renderFinal: (videoId: VideoId, resolution: RenderResolution) => Promise<JobView>;
  pause: (jobId: JobId) => Promise<JobView>;
  continue: (jobId: JobId) => Promise<JobView>;
  stop: (jobId: JobId) => Promise<JobView>;
  /** Admin: skips the start delay of one waiting edit. */
  startNow: (jobId: JobId) => Promise<JobView>;
}

export function jobCommands(store: AppStore): JobCommands {
  const app = () => store.getState();
  return {
    startEdit: (videoId, urgent) => app().startEdit({ videoId, urgent }),
    reEdit: (videoId, text, urgent) => app().reEdit({ videoId, text, urgent }),
    renderFinal: (videoId, resolution) => app().renderFinal({ videoId, resolution }),
    pause: (jobId) => app().pauseJob(jobId),
    continue: (jobId) => app().continueJob(jobId),
    stop: (jobId) => app().stopJob(jobId),
    startNow: (jobId) => app().adminStartJobNow(jobId),
  };
}

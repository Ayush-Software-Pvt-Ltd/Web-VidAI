import type { JobView, Library, VideoView } from "../types";
import { channelIdOf } from "../videoId";
import type { SliceContext } from "./ctx";
import { coalesced, idle, type Resource } from "./resource";

export interface LibraryState {
  library: Resource<Library>;
}

export interface LibraryActions {
  /** Coalesced: at most one request in flight plus one queued, however many events arrive. */
  refreshLibrary: () => Promise<void>;
  /**
   * Takes a whole library (the payload of `library-changed`) at once; an answer of `getLibrary`
   * that is still on its way is dropped, it can only be older.
   */
  setLibrary: (library: Library) => void;
  /**
   * Puts a job returned by a call or an event into the library row of its video at once. A job of
   * another user (an admin hears of everybody's) never enters the library; it only updates the
   * queue lists (`applyJobToQueues`).
   */
  applyJob: (job: JobView) => void;
  /** Puts a video returned by a call (`setVideoTypeOverride`) into the library at once. */
  applyVideo: (video: VideoView) => void;
}

export type LibrarySlice = LibraryState & LibraryActions;

export function withJob(library: Library, job: JobView): Library {
  return {
    ...library,
    channels: library.channels.map((channel) => ({
      ...channel,
      videos: channel.videos.map((video) => (video.id === job.videoId ? { ...video, job } : video)),
    })),
  };
}

function withVideo(library: Library, next: VideoView): Library {
  const channelId = channelIdOf(next.id);
  return {
    ...library,
    channels: library.channels.map((channel) =>
      channel.channelId === channelId
        ? { ...channel, videos: channel.videos.map((v) => (v.id === next.id ? next : v)) }
        : channel,
    ),
  };
}

export function createLibrarySlice({
  api,
  set,
  get,
  load,
  invalidate,
  onReset,
}: SliceContext): LibrarySlice {
  const refresh = coalesced(() => load("library", () => api.getLibrary()));
  onReset(refresh.cancel);

  return {
    library: idle(),
    refreshLibrary: refresh,
    setLibrary(library) {
      invalidate("library");
      set({ library: { data: library, status: "ready", error: null } });
      get().reconcileNav();
    },
    applyJob(job) {
      const userId = get().session.data?.user?.id;
      if (userId === undefined || job.userId === userId) {
        set((s) =>
          s.library.data ? { library: { ...s.library, data: withJob(s.library.data, job) } } : {},
        );
      }
      get().applyJobToQueues(job);
    },
    applyVideo: (video) =>
      set((s) =>
        s.library.data ? { library: { ...s.library, data: withVideo(s.library.data, video) } } : {},
      ),
  };
}

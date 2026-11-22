import type {
  AddNoteInput,
  JobView,
  RenderFinalInput,
  ReEditInput,
  StartEditInput,
  Timeline,
  TimelineNote,
  TimelineOp,
  VideoRef,
  VideoType,
  VideoView,
} from "../types";
import type { SliceContext } from "./ctx";

/**
 * Commands of the screens that change something, each wrapped with what must follow: the answer
 * is put into the state at once and what the server computes (a video's `actions`) is fetched.
 * They reject with an `ApiError`, which the screen shows; `unauthenticated` also signs out.
 */
export interface CommandActions {
  startEdit: (input: StartEditInput) => Promise<JobView>;
  reEdit: (input: ReEditInput) => Promise<JobView>;
  pauseJob: (jobId: string) => Promise<JobView>;
  continueJob: (jobId: string) => Promise<JobView>;
  stopJob: (jobId: string) => Promise<JobView>;
  renderFinal: (input: RenderFinalInput) => Promise<JobView>;
  /** Admin: marks a waiting job Urgent or not. The job may be another user's (admin queue only). */
  adminSetJobUrgent: (jobId: string, urgent: boolean) => Promise<JobView>;
  /** Admin: skips the start delay for one waiting edit. */
  adminStartJobNow: (jobId: string) => Promise<JobView>;
  createVideo: (channelId: string, name: string) => Promise<VideoRef>;
  setVideoTypeOverride: (videoId: string, videoType: VideoType | null) => Promise<VideoView>;
  editTimeline: (videoId: string, revision: number, op: TimelineOp) => Promise<Timeline>;
  undoTimeline: (videoId: string) => Promise<Timeline>;
  redoTimeline: (videoId: string) => Promise<Timeline>;
  restoreRevision: (videoId: string, n: number) => Promise<Timeline>;
  addTimelineNote: (videoId: string, note: AddNoteInput) => Promise<TimelineNote>;
  deleteTimelineNote: (videoId: string, noteId: string) => Promise<void>;
  retryTimelineNote: (videoId: string, noteId: string) => Promise<TimelineNote>;
}

export type CommandsSlice = CommandActions;

export function createCommandsSlice({ api, get, call }: SliceContext): CommandsSlice {
  const job = async (run: () => Promise<JobView>): Promise<JobView> => {
    const result = await call(run);
    get().applyJob(result);
    // The job changes which actions its video offers; the server computes them.
    void get().refreshLibrary();
    return result;
  };
  const timeline = async (videoId: string, run: () => Promise<Timeline>): Promise<Timeline> => {
    const result = await call(run);
    get().applyTimeline(videoId, result);
    if (get().timelines[videoId]?.revisions.status !== "idle") void get().loadRevisions(videoId);
    return result;
  };
  const noteOf = (videoId: string, noteId: string) =>
    get().timelines[videoId]?.timeline.data?.notes.find((n) => n.id === noteId);
  // The server's note-updated event for a request can arrive before the answer of the call that
  // made it, and later events (running, done) can too. The wire has no revision or time of
  // change on a note, so what is newer comes from the order of its life: pending, then running,
  // then done or failed. A retry is the one way back (failed to pending), so an entry that no
  // event touched since the call began (still the very object seen before) is simply replaced.
  const NOTE_ORDER = { pending: 0, running: 1, done: 2, failed: 2 } as const;
  const note = async (
    videoId: string,
    run: () => Promise<TimelineNote>,
    seen?: TimelineNote,
  ): Promise<TimelineNote> => {
    const result = await call(run);
    const stored = noteOf(videoId, result.id);
    const newer =
      stored !== undefined &&
      stored !== seen &&
      NOTE_ORDER[stored.state] > NOTE_ORDER[result.state];
    if (!newer) get().applyNote(videoId, result, false);
    return result;
  };

  return {
    startEdit: (input) => job(() => api.startEdit(input)),
    reEdit: (input) => job(() => api.reEdit(input)),
    pauseJob: (jobId) => job(() => api.pauseJob({ jobId })),
    continueJob: (jobId) => job(() => api.continueJob({ jobId })),
    stopJob: (jobId) => job(() => api.stopJob({ jobId })),
    renderFinal: (input) => job(() => api.renderFinal(input)),
    adminSetJobUrgent: (jobId, urgent) => job(() => api.adminSetJobUrgent({ jobId, urgent })),
    adminStartJobNow: (jobId) => job(() => api.adminStartJobNow({ jobId })),
    async createVideo(channelId, name) {
      const ref = await call(() => api.createVideo({ channelId, name }));
      await get().refreshLibrary();
      return ref;
    },
    async setVideoTypeOverride(videoId, videoType) {
      const video = await call(() => api.setVideoTypeOverride({ videoId, videoType }));
      get().applyVideo(video);
      return video;
    },
    editTimeline: (videoId, revision, op) =>
      timeline(videoId, () => api.editTimeline({ videoId, revision, op })),
    undoTimeline: (videoId) => timeline(videoId, () => api.undoTimeline({ videoId })),
    redoTimeline: (videoId) => timeline(videoId, () => api.redoTimeline({ videoId })),
    restoreRevision: (videoId, n) => timeline(videoId, () => api.restoreRevision({ videoId, n })),
    addTimelineNote: (videoId, input) =>
      note(videoId, () => api.addTimelineNote({ videoId, ...input })),
    async deleteTimelineNote(videoId, noteId) {
      await call(() => api.deleteTimelineNote({ videoId, noteId }));
      const existing = get().timelines[videoId]?.timeline.data?.notes.find((n) => n.id === noteId);
      if (existing) get().applyNote(videoId, existing, true);
    },
    retryTimelineNote: (videoId, noteId) =>
      note(videoId, () => api.retryTimelineNote({ videoId, noteId }), noteOf(videoId, noteId)),
  };
}

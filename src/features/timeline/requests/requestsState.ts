/**
 * What the two request components share: whether the user is drawing, the frame and mark of the
 * request being written, its text and which request of the list is selected. The screen mounts
 * `FrameOverlay` and `RequestsPanel` separately and only gives them the playback store, so the
 * state lives in one small store per playback store (one per open timeline), found through
 * `requestsStoreFor(usePlayback())`.
 */
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand";
import type { JobView, NoteShape, Timeline, TimelineClip, TimelineNote } from "@/lib/types";
import { clipsAtFrame, isSound, kindStyle } from "../model";
import { usePlayback, type PlaybackStore } from "../playback";

export interface RequestsState {
  /** The user is marking a frame: the overlay takes the pointer and the form is open. */
  drawing: boolean;
  /** The frame of the request being written; follows the playhead while drawing. */
  frame: number;
  /** The ellipse (or point) the user drew, `null` until there is one. */
  shape: NoteShape | null;
  /** "Whole frame" was chosen: no shape on purpose. */
  wholeFrame: boolean;
  /** The clip the user chose, `null` for none; `undefined` while the guess (`defaultAbout`) stands. */
  about: string | null | undefined;
  text: string;
  sending: boolean;
  /** The server's refusal of the last Send, kept in the form. */
  error: string | null;
  /** The request of the list the user clicked. */
  selectedId: string | null;
}

export interface RequestsActions {
  /** Pauses the player and starts a request at `frame`. */
  start: (frame: number) => void;
  /** Throws away the request being written (its text too). */
  cancel: () => void;
  setShape: (shape: NoteShape | null) => void;
  chooseWholeFrame: () => void;
  setAbout: (clipId: string | null) => void;
  setText: (text: string) => void;
  setSending: (sending: boolean) => void;
  setError: (error: string | null) => void;
  select: (noteId: string | null) => void;
  /** A request was sent: closes the form and selects the new request. */
  sent: (noteId: string) => void;
}

export type RequestsStore = StoreApi<RequestsState & RequestsActions>;

const BLANK: Omit<RequestsState, "selectedId"> = {
  drawing: false,
  frame: 0,
  shape: null,
  wholeFrame: false,
  about: undefined,
  text: "",
  sending: false,
  error: null,
};

const stores = new WeakMap<PlaybackStore, RequestsStore>();

function createRequestsStore(playback: PlaybackStore): RequestsStore {
  const store = createStore<RequestsState & RequestsActions>()((set) => ({
    ...BLANK,
    selectedId: null,
    start: (frame) => {
      playback.pause();
      set((s) =>
        s.drawing ? {} : { ...BLANK, drawing: true, frame, text: s.text, selectedId: s.selectedId },
      );
    },
    cancel: () => {
      set((s) => (s.sending ? {} : { ...BLANK, selectedId: s.selectedId }));
    },
    setShape: (shape) => {
      set({ shape, wholeFrame: false, about: undefined, error: null });
    },
    chooseWholeFrame: () => {
      set({ shape: null, wholeFrame: true, about: undefined, error: null });
    },
    setAbout: (about) => {
      set({ about, error: null });
    },
    setText: (text) => {
      set({ text, error: null });
    },
    setSending: (sending) => {
      set({ sending });
    },
    setError: (error) => {
      set({ error, sending: false });
    },
    select: (selectedId) => {
      set({ selectedId });
    },
    sent: (noteId) => {
      set({ ...BLANK, selectedId: noteId });
    },
  }));
  // While drawing, the request follows the playhead: a mark belongs to one picture, so it goes.
  playback.subscribe(() => {
    const frame = playback.getState().frame;
    const s = store.getState();
    if (!s.drawing || s.sending || frame === s.frame) return;
    store.setState({ frame, shape: null, wholeFrame: false, about: undefined, error: null });
  });
  return store;
}

/** The requests store of one open timeline (created on first use). */
export function requestsStoreFor(playback: PlaybackStore): RequestsStore {
  let store = stores.get(playback);
  if (!store) {
    store = createRequestsStore(playback);
    stores.set(playback, store);
  }
  return store;
}

/** The requests store of the open timeline; only inside the timeline screen. */
export function useRequestsStore(): RequestsStore {
  return requestsStoreFor(usePlayback());
}

/** A slice of the requests state; re-renders when it changes. */
export function useRequests<T>(selector: (state: RequestsState & RequestsActions) => T): T {
  return useStore(useRequestsStore(), selector);
}

/** What a request can be about at a frame: the clips that have a picture, top track first. */
export function pictureClipsAt(timeline: Timeline, frame: number): TimelineClip[] {
  return clipsAtFrame(timeline, frame).filter((clip) => !isSound(clip.kind));
}

/**
 * The clip a mark is taken to be about when the user has not chosen one. The wire carries no
 * place or size of a clip, so the mark cannot be tested against a picture: the guess is the clip
 * that is on top at the frame (the user sees it named and can change it). No mark and no chosen
 * clip means the whole frame.
 */
export function defaultAbout(timeline: Timeline, frame: number, hasMark: boolean): string | null {
  if (!hasMark) return null;
  return pictureClipsAt(timeline, frame)[0]?.id ?? null;
}

/** The clip a request being written is about now (the user's choice, else the guess). */
export function effectiveAbout(
  state: Pick<RequestsState, "about" | "shape" | "frame">,
  timeline: Timeline,
): string | null {
  const choice =
    state.about !== undefined
      ? state.about
      : defaultAbout(timeline, state.frame, state.shape !== null);
  if (choice === null) return null;
  return pictureClipsAt(timeline, state.frame).some((clip) => clip.id === choice) ? choice : null;
}

/** "Motion graphic: Price card": a clip named with its kind. */
export function clipName(clip: Pick<TimelineClip, "kind" | "label">): string {
  return `${kindStyle(clip.kind).label}: ${clip.label}`;
}

/** What a failed request says when neither it nor its job has a sentence. */
export const FAILED_FALLBACK = "This change could not be made.";

/** Why a failed request failed: its own sentence first, then its job's, then the fallback. */
export function failureSentence(note: TimelineNote, job: JobView | null): string {
  return note.error ?? job?.error ?? FAILED_FALLBACK;
}

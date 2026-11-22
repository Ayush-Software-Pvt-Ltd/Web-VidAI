/**
 * What the timeline screen shares with the panels beside the player: where the playhead is and
 * how to move it. The screen owns one store per open timeline and wires it to the player; the
 * change request panel and the frame overlay only read it and call its commands.
 *
 * The frame changes many times a second while playing, so it lives in an external store and each
 * reader subscribes to the part it shows (`usePlaybackFrame`, `usePlaybackStatus`).
 */
import { createContext, useContext, useSyncExternalStore } from "react";

export interface PlaybackState {
  /** The whole frame under the playhead. */
  frame: number;
  playing: boolean;
  /** False until the player has reported that it can show frames. */
  ready: boolean;
}

/** What the store asks of whoever drives the player. */
export interface PlaybackDriver {
  seek: (frame: number) => void;
  play: () => void;
  pause: () => void;
}

export interface PlaybackStore extends PlaybackDriver {
  getState: () => PlaybackState;
  subscribe: (listener: () => void) => () => void;
  /** For the owner of the player only: what the player reported. */
  report: (change: Partial<PlaybackState>) => void;
}

export const INITIAL_PLAYBACK: PlaybackState = { frame: 0, playing: false, ready: false };

/**
 * A store over a driver. `seek` shows the new frame at once (the player confirms it later through
 * `report`), so the playhead never lags behind the pointer.
 */
export function createPlaybackStore(
  driver: PlaybackDriver,
  initial: PlaybackState = INITIAL_PLAYBACK,
): PlaybackStore {
  let state = initial;
  const listeners = new Set<() => void>();

  function set(change: Partial<PlaybackState>): void {
    const next = { ...state, ...change };
    if (
      next.frame === state.frame &&
      next.playing === state.playing &&
      next.ready === state.ready
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report: set,
    seek: (frame) => {
      set({ frame });
      driver.seek(frame);
    },
    play: () => {
      driver.play();
    },
    pause: () => {
      driver.pause();
    },
  };
}

export const PlaybackContext = createContext<PlaybackStore | null>(null);

/** The playback store of the open timeline; only inside the timeline screen. */
export function usePlayback(): PlaybackStore {
  const store = useContext(PlaybackContext);
  if (!store) throw new Error("usePlayback is used outside the timeline screen");
  return store;
}

const frameOf = (store: PlaybackStore) => () => store.getState().frame;
const playingOf = (store: PlaybackStore) => () => store.getState().playing;
const readyOf = (store: PlaybackStore) => () => store.getState().ready;

/** The frame under the playhead; re-renders on every frame while playing. */
export function usePlaybackFrame(): number {
  const store = usePlayback();
  return useSyncExternalStore(store.subscribe, frameOf(store));
}

/** Whether it plays and whether the player is ready; does not re-render per frame. */
export function usePlaybackStatus(): { playing: boolean; ready: boolean } {
  const store = usePlayback();
  const playing = useSyncExternalStore(store.subscribe, playingOf(store));
  const ready = useSyncExternalStore(store.subscribe, readyOf(store));
  return { playing, ready };
}

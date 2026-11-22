/**
 * The one place that knows the HyperFrames player element (`<hyperframes-player>`, script
 * `/assets/hyperframes-player.js`). The screen talks to a `PlayerBridge` in frames; tests give it a
 * fake.
 *
 * How the element is driven (read from `hyperframes-player.global.js`, see the task report):
 * - attribute `src` (the preview address); `disable-click-to-play` because the frame carries the
 *   change request overlay; no `controls` (the screen has its own transport);
 * - methods `play()`, `pause()`, `seek(seconds)`; properties `volume` (0 to 1), `muted`,
 *   `playbackRate` (0.1 to 5);
 * - DOM events on the element: `ready`, `timeupdate` (`detail.currentTime` in seconds), `play`,
 *   `pause`, `ended`, `error`.
 * The element itself exchanges `postMessage` messages with the framed project and ignores any
 * message that does not come from its own frame or does not carry `source: "hf-preview"`; the page
 * never listens to window messages. What the element reports is checked here (finite numbers only)
 * and free text from it (an error message) is dropped: the screen words every failure itself.
 */
import type { TimelineFps } from "@/lib/types";

/** What the player tells the screen; frames are whole numbers on the timeline. */
export type PlayerEvent =
  | { type: "ready"; duration: number }
  | { type: "frame"; frame: number }
  | { type: "playing"; playing: boolean }
  | { type: "ended" }
  | { type: "failed" };

export type PlayerListener = (event: PlayerEvent) => void;

export interface PlayerBridge {
  /** Whether `setRate` has an effect (J and L change the speed only then). */
  readonly supportsRate: boolean;
  /** Shows the preview at `src`; the player reports `ready` when it can show frames. */
  load: (src: string, fps: TimelineFps) => void;
  /** Loads the same address again (the project changed on disk). */
  reload: () => void;
  play: () => void;
  pause: () => void;
  /** Shows `frame`; playback stops (and `playing: false` is reported). */
  seek: (frame: number) => void;
  /** 0 to 1. */
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setRate: (rate: number) => void;
  subscribe: (listener: PlayerListener) => () => void;
  destroy: () => void;
}

/** Makes a player inside `host`; the player fills the host. */
export type CreatePlayerBridge = (host: HTMLElement) => PlayerBridge;

export const PLAYER_TAG = "hyperframes-player";

/** The parts of the element the bridge uses (the element is untyped for TypeScript). */
interface PlayerElement extends HTMLElement {
  play?: () => void;
  pause?: () => void;
  seek?: (seconds: number) => void;
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
  duration?: number;
  currentTime?: number;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The frame that shows at `seconds` (a tiny allowance for rounding errors of exact frame times). */
export function frameAtSeconds(seconds: number, fps: TimelineFps): number {
  return Math.max(0, Math.floor((seconds * fps.num) / fps.den + 1e-4));
}

export function secondsAtFrame(frame: number, fps: TimelineFps): number {
  return (frame * fps.den) / fps.num;
}

export const createPlayerBridge: CreatePlayerBridge = (host) => {
  const element = document.createElement(PLAYER_TAG) as PlayerElement;
  element.setAttribute("disable-click-to-play", "");
  element.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;";
  host.appendChild(element);

  const listeners = new Set<PlayerListener>();
  let fps: TimelineFps = { num: 30, den: 1 };
  let src: string | null = null;
  const emit = (event: PlayerEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const onReady = () => {
    const seconds = element.duration;
    emit({
      type: "ready",
      duration: finite(seconds) ? Math.round((seconds * fps.num) / fps.den) : 0,
    });
  };
  const onTime = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const seconds =
      typeof detail === "object" && detail !== null
        ? (detail as { currentTime?: unknown }).currentTime
        : undefined;
    if (finite(seconds)) emit({ type: "frame", frame: frameAtSeconds(seconds, fps) });
  };
  const onPlay = () => emit({ type: "playing", playing: true });
  const onPause = () => emit({ type: "playing", playing: false });
  const onEnded = () => {
    emit({ type: "playing", playing: false });
    emit({ type: "ended" });
  };
  const onError = () => emit({ type: "failed" });
  element.addEventListener("ready", onReady);
  element.addEventListener("timeupdate", onTime);
  element.addEventListener("play", onPlay);
  element.addEventListener("pause", onPause);
  element.addEventListener("ended", onEnded);
  element.addEventListener("error", onError);

  return {
    supportsRate: true,
    load(address, rate) {
      src = address;
      fps = rate;
      element.setAttribute("src", address);
    },
    reload() {
      if (src !== null) element.setAttribute("src", src);
    },
    play: () => element.play?.(),
    pause: () => element.pause?.(),
    seek(frame) {
      element.seek?.(secondsAtFrame(frame, fps));
      // The element stops playing on a seek without saying so.
      emit({ type: "playing", playing: false });
    },
    setVolume(volume) {
      element.volume = Math.min(1, Math.max(0, volume));
    },
    setMuted(muted) {
      element.muted = muted;
    },
    setRate(rate) {
      element.playbackRate = rate;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      listeners.clear();
      element.removeEventListener("ready", onReady);
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
      element.pause?.();
      element.remove();
    },
  };
};

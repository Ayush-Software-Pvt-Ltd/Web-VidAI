/**
 * The player and its frame box: one `position: relative` element of exactly the frame's displayed
 * size (the project's picture letterboxed inside the area), the player filling it, then the
 * change request overlay on top. Also the loading and error states of the player, and the renewal
 * of the preview address.
 */
import { Maximize, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button, IconButton, Spinner } from "@/components/ui";
import type { TimelineFps } from "@/lib/types";
import { clampFrame, lastFrame } from "../model";
import type { PlaybackStore } from "../playback";
import { FrameOverlay } from "../requests";
import { fitFrame } from "./frameBox";
import type { PlayerBridge } from "./playerBridge";
import { usePlayerEnv } from "./playerEnv";
import { useMeasure } from "./useMeasure";

export interface PlayerFrameProps {
  videoId: string;
  width: number;
  height: number;
  fps: TimelineFps;
  /** The timeline's length in frames. */
  duration: number;
  /** The project's revision: a change reloads the player and keeps the playhead. */
  revision: number;
  /**
   * How many preview copies of the video are finished (SPEC section 11): a new one reloads the
   * player, because a file the player already opened keeps playing from the original, which a
   * browser may play without sound (a sound codec it cannot decode).
   */
  copiesDone: number;
  previewUrl: string | null;
  playback: PlaybackStore;
  /** Filled with the bridge while the player exists; the playback store drives it through this. */
  bridgeRef: RefObject<PlayerBridge | null>;
  /** Asks the server for a new preview address (`openTimeline`) and returns it. */
  renewPreview: () => Promise<string | null>;
  volume: number;
  muted: boolean;
  rate: number;
}

type Phase = "script" | "loading" | "ready" | "error";
type Failure = "script" | "preview";

const FAILURE_TEXT: Record<Failure, { title: string; text: string }> = {
  script: {
    title: "The video player could not be loaded.",
    text: "Check your connection to the server and try again.",
  },
  preview: {
    title: "The preview could not be shown.",
    text: "The server did not answer in time. Try again in a moment.",
  },
};

export function PlayerFrame({
  videoId,
  width,
  height,
  fps,
  duration,
  revision,
  copiesDone,
  previewUrl,
  playback,
  bridgeRef,
  renewPreview,
  volume,
  muted,
  rate,
}: PlayerFrameProps) {
  const env = usePlayerEnv();
  const [areaRef, area] = useMeasure();
  const [areaNode, setAreaNode] = useState<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("script");
  const [failure, setFailure] = useState<Failure>("preview");
  const [bridge, setBridge] = useState<PlayerBridge | null>(null);
  const [attempt, setAttempt] = useState(0);

  // What the callbacks below read, so they stay the same functions for the whole life of the player.
  const live = useRef({ fps, duration, renewPreview, readyTimeoutMs: env.readyTimeoutMs });
  useLayoutEffect(() => {
    live.current = { fps, duration, renewPreview, readyTimeoutMs: env.readyTimeoutMs };
  });
  const loadedUrl = useRef<string | null>(null);
  const renewed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const alive = useRef(true);
  const readyRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const fail = useCallback(
    (kind: Failure) => {
      stopTimer();
      setFailure(kind);
      setPhase("error");
    },
    [stopTimer],
  );

  const load = useCallback(
    (player: PlayerBridge, url: string, onTimeout: () => void) => {
      loadedUrl.current = url;
      readyRef.current = false;
      setPhase("loading");
      playback.report({ ready: false });
      player.load(url, live.current.fps);
      stopTimer();
      timer.current = setTimeout(onTimeout, live.current.readyTimeoutMs);
    },
    [playback, stopTimer],
  );

  // Asks for a new address once; a second failure ends in the error state with Try Again.
  const renew = useCallback(
    async (player: PlayerBridge) => {
      renewed.current = true;
      stopTimer();
      setPhase("loading");
      const url = await live.current.renewPreview().catch(() => null);
      if (!alive.current) return;
      if (url === null) {
        fail("preview");
        return;
      }
      load(player, url, () => fail("preview"));
    },
    [fail, load, stopTimer],
  );

  const handleFailure = useCallback(
    (player: PlayerBridge) => {
      if (readyRef.current) return;
      if (!renewed.current) void renew(player);
      else fail("preview");
    },
    [fail, renew],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopTimer();
    };
  }, [stopTimer]);

  // The script, then the player.
  useEffect(() => {
    let cancelled = false;
    let made: PlayerBridge | null = null;
    let unsubscribe: (() => void) | null = null;
    env
      .loadScript()
      .then(() => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        const player = env.createBridge(host);
        made = player;
        unsubscribe = player.subscribe((event) => {
          switch (event.type) {
            case "ready": {
              stopTimer();
              readyRef.current = true;
              setPhase("ready");
              playback.report({ ready: true });
              const wanted = pendingSeek.current;
              pendingSeek.current = null;
              if (wanted !== null) {
                player.seek(clampFrame(wanted, lastFrame(live.current.duration)));
              }
              return;
            }
            case "frame":
              playback.report({ frame: clampFrame(event.frame, lastFrame(live.current.duration)) });
              return;
            case "playing":
              playback.report({ playing: event.playing });
              return;
            case "ended":
              playback.report({ playing: false, frame: lastFrame(live.current.duration) });
              return;
            case "failed":
              handleFailure(player);
              return;
          }
        });
        bridgeRef.current = player;
        setBridge(player);
      })
      .catch(() => {
        if (!cancelled) fail("script");
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
      made?.destroy();
      if (bridgeRef.current === made) bridgeRef.current = null;
      loadedUrl.current = null;
      setBridge(null);
      playback.report({ ready: false, playing: false });
    };
    // The player lives as long as this component; the callbacks are stable by construction.
  }, [env, playback, bridgeRef, stopTimer, fail, handleFailure, attempt]);

  // The preview address (also a new one after the connection came back).
  useEffect(() => {
    if (!bridge || previewUrl === null || previewUrl === loadedUrl.current) return;
    load(bridge, previewUrl, () => handleFailure(bridge));
  }, [bridge, previewUrl, load, handleFailure]);

  // The project changed (an edit, undo, a job) or a preview copy came ready: show it at the same frame.
  const shown = useRef({ revision, copiesDone });
  useEffect(() => {
    const before = shown.current;
    if (before.revision === revision && copiesDone <= before.copiesDone) {
      // A smaller count is a new video or a cleanup of copies: nothing to show again.
      shown.current = { revision, copiesDone };
      return;
    }
    shown.current = { revision, copiesDone };
    if (!bridge || loadedUrl.current === null) return;
    pendingSeek.current = playback.getState().frame;
    readyRef.current = false;
    playback.report({ ready: false, playing: false });
    setPhase("loading");
    bridge.reload();
    stopTimer();
    timer.current = setTimeout(() => handleFailure(bridge), live.current.readyTimeoutMs);
  }, [revision, copiesDone, bridge, playback, stopTimer, handleFailure]);

  useEffect(() => {
    bridge?.setVolume(volume);
    bridge?.setMuted(muted);
    bridge?.setRate(rate);
  }, [bridge, volume, muted, rate, phase]);

  const box = fitFrame(area, width, height);
  const tryAgain = () => {
    renewed.current = false;
    setFailure("preview");
    if (bridge) void renew(bridge);
    else {
      setPhase("script");
      setAttempt((count) => count + 1);
    }
  };
  const failed = FAILURE_TEXT[failure];
  const fullscreen = () => void areaNode?.requestFullscreen();

  return (
    <div
      ref={(node) => {
        areaRef(node);
        setAreaNode(node);
      }}
      data-measure="area"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
    >
      <div
        data-testid="frame-box"
        data-video={videoId}
        className="relative shrink-0 overflow-hidden"
        style={{ width: box.width, height: box.height }}
      >
        <div ref={hostRef} className="absolute inset-0" />
        <FrameOverlay videoId={videoId} box={box} />
      </div>
      {previewUrl === null && (
        <div
          role="status"
          data-testid="no-preview"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black px-6 text-center"
        >
          <p className="text-md font-semibold text-white">There is no preview of this video</p>
          <p className="max-w-md text-base text-white/70">
            The server that runs VidAI cannot show the picture because it has no preview tool. You
            can still read the timeline and send change requests. To see the picture, install
            HyperFrames on that computer and restart VidAI.
          </p>
        </div>
      )}
      {previewUrl !== null && phase !== "ready" && phase !== "error" && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70"
        >
          <Spinner size={16} />
          Loading the preview
        </div>
      )}
      {phase === "error" && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center"
        >
          <TriangleAlert className="size-6 text-warning" aria-hidden />
          <div>
            <p className="text-md font-semibold text-white">{failed.title}</p>
            <p className="mt-1 text-base text-white/70">{failed.text}</p>
          </div>
          <Button onClick={tryAgain}>Try Again</Button>
        </div>
      )}
      {typeof document !== "undefined" && document.fullscreenEnabled && (
        <IconButton
          label="Full screen"
          icon={<Maximize />}
          size="sm"
          className="absolute top-2 right-2 bg-black/50 text-white/80 hover:bg-black/70"
          onClick={fullscreen}
        />
      )}
    </div>
  );
}

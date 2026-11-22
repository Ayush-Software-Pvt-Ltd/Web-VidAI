import {
  Maximize2,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { IconButton } from "@/components/ui";
import type { Timeline, TimelineClip, TimelineFps } from "@/lib/types";
import {
  canDelete,
  canSplit,
  durationText,
  timeCode,
  type Allowance,
  type EditGate,
} from "../model";
import { usePlayback, usePlaybackFrame, usePlaybackStatus } from "../playback";
import { Reasoned } from "./Header";

function TimeReadout({ fps, duration }: { fps: TimelineFps; duration: number }) {
  const frame = usePlaybackFrame();
  return (
    <div
      className="flex min-w-[150px] items-baseline gap-1.5 font-mono text-sm tabular-nums"
      aria-label="Time code"
    >
      <span data-testid="time-code" className="text-fg">
        {timeCode(frame, fps)}
      </span>
      <span className="text-fg-subtle">/ {durationText(duration, fps)}</span>
    </div>
  );
}

export interface TransportProps {
  timeline: Timeline;
  gate: EditGate;
  selected: TimelineClip | null;
  volume: number;
  muted: boolean;
  onVolume: (volume: number) => void;
  onMuted: (muted: boolean) => void;
  onSplit: () => void;
  onDelete: () => void;
  onZoom: (steps: number) => void;
  onFit: () => void;
}

export function Transport({
  timeline,
  gate,
  selected,
  volume,
  muted,
  onVolume,
  onMuted,
  onSplit,
  onDelete,
  onZoom,
  onFit,
}: TransportProps) {
  const playback = usePlayback();
  const { playing, ready } = usePlaybackStatus();
  const { fps, duration } = timeline;
  const frame = usePlaybackFrame();
  const last = Math.max(0, duration - 1);
  const none: Allowance = { ok: false, reason: "Select a clip first." };
  const split = selected ? canSplit(selected, frame, gate) : none;
  const remove = selected ? canDelete(timeline, selected, gate) : none;
  const step = (by: number) => {
    const next = Math.min(last, Math.max(0, playback.getState().frame + by));
    playback.seek(next);
  };
  const waiting = ready ? undefined : "The preview is still loading.";
  return (
    <div
      role="toolbar"
      aria-label="Playback and editing"
      className="flex h-10 shrink-0 items-center gap-1 border-t border-border bg-window px-3"
    >
      <IconButton label="To start" icon={<SkipBack />} onClick={() => playback.seek(0)} />
      <IconButton label="Back one frame" icon={<StepBack />} onClick={() => step(-1)} />
      <span title={waiting} className="inline-flex">
        <IconButton
          label={playing ? "Pause" : "Play"}
          icon={playing ? <Pause /> : <Play />}
          variant="secondary"
          disabled={!ready}
          noTooltip={!ready}
          onClick={() => (playing ? playback.pause() : playback.play())}
        />
      </span>
      <IconButton label="Forward one frame" icon={<StepForward />} onClick={() => step(1)} />
      <IconButton label="To end" icon={<SkipForward />} onClick={() => playback.seek(last)} />
      <TimeReadout fps={fps} duration={duration} />
      <IconButton
        label={muted ? "Unmute" : "Mute"}
        icon={muted || volume === 0 ? <VolumeX /> : <Volume2 />}
        pressed={muted}
        onClick={() => onMuted(!muted)}
      />
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(event) => {
          const next = Number(event.target.value);
          onVolume(next);
          onMuted(next === 0);
        }}
        className="focus-ring h-1 w-20 cursor-pointer accent-accent"
      />
      <div className="flex-1" />
      <Reasoned allow={split}>
        <IconButton
          label="Split at playhead"
          icon={<Scissors />}
          disabled={!split.ok}
          noTooltip={!split.ok}
          aria-keyshortcuts="S"
          onClick={onSplit}
        />
      </Reasoned>
      <Reasoned allow={remove}>
        <IconButton
          label="Delete clip"
          icon={<Trash2 />}
          disabled={!remove.ok}
          noTooltip={!remove.ok}
          aria-keyshortcuts="Delete"
          onClick={onDelete}
        />
      </Reasoned>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <IconButton label="Zoom out" icon={<ZoomOut />} onClick={() => onZoom(-1)} />
      <IconButton label="Zoom in" icon={<ZoomIn />} onClick={() => onZoom(1)} />
      <IconButton label="Fit to width" icon={<Maximize2 />} onClick={onFit} />
    </div>
  );
}

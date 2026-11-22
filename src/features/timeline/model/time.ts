// Time on the timeline: frames are whole numbers, `fps` is the wire's fraction (30 is 30/1, 29.97 is
// 30000/1001). Drop-frame time code is not used. A time code counts frames at the NOMINAL rate (the
// rate rounded to a whole number: 24 for 23.976, 30 for 29.97), so the frame part runs 0 to 23 or
// 0 to 29 and the readout is exact to the frame; over half an hour at 29.97 it runs about 1.8 s
// ahead of the wall clock. `framesToSeconds` and `secondsToFrames` use the exact rate.

import type { TimelineFps } from "@/lib/types";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The frame rate as one number (29.97 for 30000/1001). */
export function fpsValue(fps: TimelineFps): number {
  return fps.num / fps.den;
}

/** The rate rounded to a whole number of frames per second; at least 1. */
export function nominalFps(fps: TimelineFps): number {
  return Math.max(1, Math.round(fpsValue(fps)));
}

/** The second at which `frame` starts (exact rate). */
export function framesToSeconds(frame: number, fps: TimelineFps): number {
  return (frame * fps.den) / fps.num;
}

/** The whole frame nearest to `seconds` (exact rate); never below 0. */
export function secondsToFrames(seconds: number, fps: TimelineFps): number {
  return Math.max(0, Math.round((seconds * fps.num) / fps.den));
}

/** The last frame that shows a picture: `duration - 1`, or 0 for an empty timeline. */
export function lastFrame(duration: number): number {
  return Math.max(0, duration - 1);
}

/** `frame` as a whole number inside 0 to `max`. */
export function clampFrame(frame: number, max: number): number {
  if (!Number.isFinite(frame)) return 0;
  return Math.min(Math.max(0, Math.round(frame)), Math.max(0, max));
}

interface Parts {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

function parts(frame: number, fps: TimelineFps): Parts {
  const n = nominalFps(fps);
  const f = Math.max(0, Math.round(frame));
  const total = Math.floor(f / n);
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    frames: f % n,
  };
}

/** The readout: `MM:SS:FF` under an hour, `H:MM:SS:FF` from one hour on. */
export function timeCode(frame: number, fps: TimelineFps): string {
  const p = parts(frame, fps);
  const tail = `${pad2(p.minutes)}:${pad2(p.seconds)}:${pad2(p.frames)}`;
  return p.hours > 0 ? `${p.hours}:${tail}` : tail;
}

/**
 * A ruler label: whole seconds read `m:ss` (`h:mm:ss` from one hour on); a frame between two
 * seconds reads `m:ss:ff`.
 */
export function rulerLabel(frame: number, fps: TimelineFps): string {
  const p = parts(frame, fps);
  const base =
    p.hours > 0
      ? `${p.hours}:${pad2(p.minutes)}:${pad2(p.seconds)}`
      : `${p.minutes}:${pad2(p.seconds)}`;
  return p.frames === 0 ? base : `${base}:${pad2(p.frames)}`;
}

/** A length as `m:ss` (`h:mm:ss` from one hour on), rounded to the nearest second. */
export function durationText(frames: number, fps: TimelineFps): string {
  const total = Math.round(framesToSeconds(Math.max(0, frames), fps));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

/** A clip length for a tooltip: `12 frames` under a second, `2.4 s` under ten, else `m:ss`. */
export function clipLengthText(frames: number, fps: TimelineFps): string {
  const f = Math.max(0, Math.round(frames));
  if (f === 1) return "1 frame";
  if (f < nominalFps(fps)) return `${f} frames`;
  const seconds = framesToSeconds(f, fps);
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  return durationText(f, fps);
}

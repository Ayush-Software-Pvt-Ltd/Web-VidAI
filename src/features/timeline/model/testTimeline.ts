// A small timeline for the tests of the model (not exported by the feature).
import type { ClipKind, Timeline, TimelineClip } from "@/lib/types";

export function clip(
  id: string,
  kind: ClipKind,
  track: number,
  start: number,
  duration: number,
  rest: Partial<TimelineClip> = {},
): TimelineClip {
  const media = kind === "aroll" || kind === "broll" || kind === "sfx" || kind === "music";
  return {
    id,
    kind,
    label: id,
    track,
    start,
    duration,
    source: media ? `${id}.mp4` : null,
    mediaStart: media ? 0 : null,
    sourceFrames: media ? duration + 100 : null,
    file: null,
    ...rest,
  };
}

/** Three A-roll clips (0-100, 100-250, 250-400), B-roll 20-60 and 80-120, a graphic, a fade. */
export function sample(): Timeline {
  const a1 = clip("a-1", "aroll", 0, 0, 100, { mediaStart: 50, sourceFrames: 400 });
  const a2 = clip("a-2", "aroll", 0, 100, 150, { mediaStart: 0, sourceFrames: 150 });
  const a3 = clip("a-3", "aroll", 0, 250, 150, { mediaStart: 10, sourceFrames: 200 });
  const b1 = clip("b-1", "broll", 1, 20, 40, { mediaStart: 5, sourceFrames: 60 });
  const b2 = clip("b-2", "broll", 1, 80, 40, { mediaStart: 0, sourceFrames: 500 });
  const g1 = clip("g-1", "graphic", 1, 300, 50, { file: "compositions/g-1.html", source: null });
  const fade = clip("fade-1", "fade", 4, 380, 20, {
    source: null,
    mediaStart: null,
    sourceFrames: null,
  });
  const music = clip("m-1", "music", 10, 0, 400);
  return {
    revision: 3,
    fps: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    duration: 400,
    tracks: [
      { index: 0, name: "A-roll", clips: [a1, a2, a3] },
      { index: 1, name: "B-roll", clips: [b1, b2, g1] },
      { index: 2, name: "Overlays", clips: [] },
      { index: 3, name: "Hits", clips: [] },
      { index: 4, name: "End fade", clips: [fade] },
      { index: 10, name: "Music", clips: [music] },
    ],
    notes: [],
    canUndo: false,
    canRedo: false,
    locked: null,
  };
}

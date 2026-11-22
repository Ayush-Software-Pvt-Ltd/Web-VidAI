/** The displayed size of the frame: the project's picture letterboxed inside the area. */
import type { Box } from "../model";

/** `area` and the picture's `width` x `height`; whole pixels, `0 x 0` while nothing is measured. */
export function fitFrame(area: Box, width: number, height: number): Box {
  if (area.width <= 0 || area.height <= 0 || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(area.width / width, area.height / height);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

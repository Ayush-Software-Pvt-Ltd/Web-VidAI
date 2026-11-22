/**
 * "Disk Cleanup" in a video's menu opens the Disk Cleanup page for that one video. The jobs
 * controller only switches the view to the page (it keeps no record of the video), so whoever
 * opens the page for one video says so here first, and the page takes the request once when it
 * mounts: it selects that video and asks the same confirmation as for a chosen list.
 */
let requested: string | null = null;

/** Asks the page to open for one video (call it right before showing the page). */
export function requestDiskCleanup(videoId: string): void {
  requested = videoId;
}

/** The video the page was asked for, once; `null` when it was opened without a request. */
export function takeRequestedDiskCleanup(): string | null {
  const videoId = requested;
  requested = null;
  return videoId;
}

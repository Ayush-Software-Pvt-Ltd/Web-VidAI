/** Moving keyboard focus into the video list from elsewhere (the search field, the panel). */

/** Focuses the list's active row (its tab stop). False when the list shows no rows. */
export function focusList(): boolean {
  const row = document.querySelector<HTMLElement>(
    '[data-video-list] [data-row-main][tabindex="0"]',
  );
  row?.focus();
  return row !== null;
}

/** Focuses the row of a video when it is shown, for example after its activity panel closed. */
export function focusVideoRow(videoId: string): boolean {
  const rows = document.querySelectorAll<HTMLElement>("[data-video-list] [data-video-id]");
  const row = [...rows].find((el) => el.dataset.videoId === videoId);
  const main = row?.querySelector<HTMLElement>("[data-row-main]") ?? null;
  main?.focus();
  return main !== null;
}

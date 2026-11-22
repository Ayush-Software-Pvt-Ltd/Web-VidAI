/** How long a job still needs, from the server's `secondsLeft` (rounded to 5 seconds). */

/** "Less than a minute left", "About 4 min left", "About 1h 05m left". */
export function formatTimeLeft(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return "Less than a minute left";
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `About ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `About ${h}h ${String(m).padStart(2, "0")}m left`;
}

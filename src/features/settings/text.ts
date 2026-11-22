/** Wording and small presentation helpers shared by Settings and Onboarding. */
import type { VideoType } from "@/lib/types";

/**
 * How often the system is checked again while VidAI waits for a login or an install in the
 * terminal (Terminal on macOS, PowerShell on Windows).
 */
export const LOGIN_POLL_MS = 3000;

export const TYPE_LABEL: Record<VideoType, string> = {
  long: "Long 16:9",
  short: "Short 9:16",
};

const numberFormat = new Intl.NumberFormat("en-US");

/** "11,024 characters". */
export function characterCount(text: string): string {
  const n = text.length;
  return `${numberFormat.format(n)} ${n === 1 ? "character" : "characters"}`;
}

/** "...9f2c" (the backend's hint) as "••••••••9f2c"; the key itself never reaches the UI. */
export function maskedHint(hint: string | null): string {
  const visible = hint?.replace(/^\.+/, "") ?? "";
  return `${"•".repeat(8)}${visible}`;
}

/** Curly quotes around a name in running text. */
export function quoted(name: string): string {
  return `“${name}”`;
}

/**
 * What the admin pages state before the server can refuse (docs/SPEC.md sections 4, 5 and 9). The
 * server still checks and clamps every value: these are the same ranges, shown up front, and its
 * own sentence is shown when it refuses anyway.
 */
import type { SelectOption } from "@/components/ui";
import type { AdminSettings } from "@/lib/types";

/** The settings that are one whole number (everything but the setup and the storage folders). */
export type NumberKey = Exclude<keyof AdminSettings, "setup" | "storageRoots">;

export interface WholeRange {
  min: number;
  max: number;
}

/** SPEC section 5, "Queues" and "Storage". */
export const RANGES = {
  maxEdits: { min: 1, max: 8 },
  maxTimelineEdits: { min: 1, max: 8 },
  maxRenders: { min: 1, max: 4 },
  maxEditsPerUser: { min: 0, max: 8 },
  startDelayMinutes: { min: 0, max: 120 },
  maxModelRetries: { min: 0, max: 50 },
  maxUploadGb: { min: 1, max: 2000 },
  proxyCacheGb: { min: 1, max: 2000 },
} as const satisfies Partial<Record<NumberKey, WholeRange>>;

export type RangedKey = keyof typeof RANGES;

/** SPEC section 5, "Limits (section 9)": 5 to 100 percent in steps of 5. */
export const PERCENT_MIN = 5;
export const PERCENT_MAX = 100;
export const PERCENT_STEP = 5;

/** Said under every field where a password is typed (SPEC section 4). */
export const PASSWORD_RULE = "The password must have 8 to 200 characters.";

/**
 * SPEC sections 5 and 6: a per-edit processor or graphics card value above its total is stored as
 * typed and never refused; the page says the total limits it. The total that does, or `null`.
 */
export function limitedByTotal(perEdit: string, total: string): number | null {
  const each = Number(perEdit);
  const all = Number(total);
  return Number.isFinite(each) && Number.isFinite(all) && each > all ? all : null;
}

/** A whole number in range, or `null` for anything else (empty, decimals, text). */
export function parseWhole(text: string, range: WholeRange): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= range.min && n <= range.max ? n : null;
}

export function rangeSentence(range: WholeRange): string {
  return `Enter a whole number from ${String(range.min)} to ${String(range.max)}.`;
}

/**
 * Which field of an account a refusal belongs to. The server words the refusals but does not name
 * the field, so the sentence decides (see `server/src/rpc/adminUsers.js`, `auth/passwords.js`).
 */
export type AccountField = "email" | "password" | "role" | "disabled" | "form";

export function accountFieldOf(message: string): AccountField {
  if (/made a user/i.test(message)) return "role";
  if (/cannot be disabled/i.test(message)) return "disabled";
  if (/password/i.test(message)) return "password";
  if (/email/i.test(message)) return "email";
  return "form";
}

/** `from` to `to` in steps of `step`, as Select options. */
export function numberOptions(
  from: number,
  to: number,
  step = 1,
  labelOf: (n: number) => string = String,
): SelectOption[] {
  const options: SelectOption[] = [];
  for (let n = from; n <= to; n += step) options.push({ value: String(n), label: labelOf(n) });
  return options;
}

/** Pure helpers of Admin, Harness and Model (SPEC sections 5 and 16). */
import { keyRequired, noModelText } from "@/lib/setup";
import type { ApiModel, ApiOption } from "@/lib/types";

/** Whether `model` matches what was typed: every word in its name or id, without letter case. */
export function matchesModel(model: ApiModel, query: string): boolean {
  const haystack = `${model.displayName} ${model.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

/**
 * Why an API option cannot be selected yet, in the words of the card, or `null` when it can
 * (mirrors `selectionProblem` of the server, which refuses with the same reason).
 * `keySaved` is `null` while the key status is not known; only OpenCode Go needs a key (`keyRequired`),
 * and its model is chosen from a list while the other options type theirs.
 */
export function selectionProblem(
  option: ApiOption,
  keySaved: boolean | null,
  model: string | null,
): string | null {
  if (keySaved === false && keyRequired(option)) return "Save an API key first.";
  if (model === null) return noModelText(option);
  return null;
}

/**
 * Why Fetch Models and Test of an option cannot ask the service yet, or `null` when they can.
 * The address always has a value (its default). The key is needed only on OpenCode Go; without
 * one the other options ask the service without credentials.
 */
export function fetchProblem(option: ApiOption, keySaved: boolean | null): string | null {
  if (!keyRequired(option)) return null;
  if (keySaved === false) return "Save an API key first.";
  if (keySaved === null) return "Checking the saved key.";
  return null;
}

/** "ends in 9f2c" from the last 4 characters the server gives; the key itself never reaches the UI. */
export function keyEnding(last4: string | null): string {
  return last4 === null || last4 === "" ? "saved" : `ends in ${last4}`;
}

/** The reasoning-effort hint of an option: what the level does in the option's program. */
export function effortHint(option: ApiOption): string {
  return option === "anthropicApi"
    ? "Remembered for each model and sent to Claude Code as its effort. Whether the service applies it is up to the service; Default sends nothing."
    : "Remembered for each model. Used only when the model offers that level; otherwise the model runs on its default and the edit log says so.";
}

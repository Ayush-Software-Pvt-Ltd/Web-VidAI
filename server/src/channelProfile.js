// The prompt and style slots of a channel profile (docs/SPEC.md section 6, "Channels"; rules
// carried over from docs/SPEC-desktop.md section 4 and `src-tauri/src/store.rs`): every profile has
// exactly 5 prompts and 5 styles, slot 0 is named "Default", other names are 1 to 40 characters.
// `validateProfile` is strict (what a user sends); `sanitizeProfile` is lenient (stored and imported
// files, which must always load).

import { invalidInput } from "./errors.js";

/** @typedef {import("../../src/lib/wire/channels.ts").ChannelProfile} ChannelProfile */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelSlot} ChannelSlot */

/** How many prompts and how many styles each of Long and Short has, always exactly. */
export const CHANNEL_SLOTS = 5;
/** Longest name of a slot, in characters. */
export const MAX_SLOT_NAME_CHARS = 40;
/** The name of slot 0, which cannot be changed. */
export const DEFAULT_SLOT_NAME = "Default";
/** Longest text of a prompt or style, in characters (a guard against abuse; real ones are far shorter). */
export const MAX_SLOT_TEXT_CHARS = 200_000;

/**
 * The empty slot `index` of a list called `label` ("Prompt" or "Style").
 * @param {"Prompt" | "Style"} label
 * @param {number} index
 * @returns {ChannelSlot}
 */
export function emptySlot(label, index) {
  return { name: index === 0 ? DEFAULT_SLOT_NAME : `${label} ${index + 1}`, text: "" };
}

/** Every slot empty and default-named. @returns {ChannelProfile} */
export function emptyProfile() {
  const slots = (/** @type {"Prompt" | "Style"} */ label) =>
    Array.from({ length: CHANNEL_SLOTS }, (_, index) => emptySlot(label, index));
  return { prompts: slots("Prompt"), styles: slots("Style") };
}

/**
 * A new channel's profile: slot 0 holds these texts, everything else is empty.
 * @param {string} prompt
 * @param {string} style
 * @returns {ChannelProfile}
 */
export function profileWithDefaults(prompt, style) {
  const profile = emptyProfile();
  /** @type {ChannelSlot} */ (profile.prompts[0]).text = prompt;
  /** @type {ChannelSlot} */ (profile.styles[0]).text = style;
  return profile;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} list
 * @param {"Prompt" | "Style"} label
 * @param {unknown} legacyText Version 1 files have one text per profile: it becomes slot 0.
 * @returns {ChannelSlot[]}
 */
function sanitizeSlots(list, label, legacyText) {
  const given = Array.isArray(list) ? list.slice(0, CHANNEL_SLOTS) : [];
  return Array.from({ length: CHANNEL_SLOTS }, (_, index) => {
    const fallback = emptySlot(label, index);
    let entry = given[index];
    if (index === 0 && given.length === 0 && typeof legacyText === "string") {
      entry = { text: legacyText };
    }
    if (!isRecord(entry)) return fallback;
    const name =
      typeof entry.name === "string"
        ? [...entry.name.trim()].slice(0, MAX_SLOT_NAME_CHARS).join("")
        : "";
    return {
      name: index === 0 || name === "" ? fallback.name : name,
      text: typeof entry.text === "string" ? entry.text : "",
    };
  });
}

/**
 * Makes anything a valid profile: exactly 5 prompts and styles (missing ones empty and
 * default-named, extra ones dropped), slot 0 named "Default", other names trimmed, cut to 40
 * characters and default-named when empty. Never throws.
 * @param {unknown} value
 * @returns {ChannelProfile}
 */
export function sanitizeProfile(value) {
  const record = isRecord(value) ? value : {};
  return {
    prompts: sanitizeSlots(record.prompts, "Prompt", record.prompt),
    styles: sanitizeSlots(record.styles, "Style", record.style),
  };
}

/**
 * @param {unknown} list
 * @param {"Prompt" | "Style"} label
 * @param {string} field
 * @returns {ChannelSlot[]}
 */
function validateSlots(list, label, field) {
  if (!Array.isArray(list)) throw invalidInput(`The ${field} must be a list.`);
  if (list.length !== CHANNEL_SLOTS) {
    throw invalidInput(`A profile needs exactly ${CHANNEL_SLOTS} ${label.toLowerCase()}s.`);
  }
  return list.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.text !== "string") {
      throw invalidInput(`${label} ${index + 1} needs a name and a text.`);
    }
    if ([...entry.text].length > MAX_SLOT_TEXT_CHARS) {
      throw invalidInput(`${label} ${index + 1} is too long.`);
    }
    if (index === 0) return { name: DEFAULT_SLOT_NAME, text: entry.text };
    const name = entry.name.trim();
    const length = [...name].length;
    if (length < 1 || length > MAX_SLOT_NAME_CHARS) {
      throw invalidInput(
        `The name of ${label.toLowerCase()} ${index + 1} must have 1 to ${MAX_SLOT_NAME_CHARS} characters.`,
      );
    }
    return { name, text: entry.text };
  });
}

/**
 * Checks a profile a user sent: exactly 5 prompts and 5 styles, every name except slot 0's 1 to 40
 * characters after trimming; slot 0 is saved as "Default" whatever it was called.
 * @param {unknown} value
 * @param {string} [field] Names the field in the message.
 * @returns {ChannelProfile}
 * @throws {import("./errors.js").AppError} `invalidInput`
 */
export function validateProfile(value, field = "profile") {
  if (!isRecord(value)) throw invalidInput(`The ${field} must be an object.`);
  return {
    prompts: validateSlots(value.prompts, "Prompt", `${field} prompts`),
    styles: validateSlots(value.styles, "Style", `${field} styles`),
  };
}

// The admin settings (docs/SPEC.md section 5): defaults, ranges, strict validation and clamping,
// stored one row per key. The harness part is only `setup` for now; the API address, key, model
// and efforts are added with their own settings later.

import { isAbsolute, resolve } from "node:path";
import { SETUPS } from "./agents/harness.js";
import { invalidInput } from "./errors.js";

/** @typedef {import("../../src/lib/wire.ts").AdminSettings} AdminSettings */
/** @typedef {import("../../src/lib/wire.ts").PublicSettings} PublicSettings */

const PERCENT_STEP = 5;
const MAX_STORAGE_ROOTS = 100;

/**
 * @typedef {{ kind: "int", min: number, max: number, default: number }
 *   | { kind: "percent", default: number }
 *   | { kind: "setup", default: import("../../src/lib/wire.ts").Setup }
 *   | { kind: "paths", default: string[] }} Definition
 */

/** @type {{ [K in keyof AdminSettings]: Definition }} */
export const DEFINITIONS = {
  setup: { kind: "setup", default: "claudeSubscription" },
  maxEdits: { kind: "int", min: 1, max: 8, default: 2 },
  maxTimelineEdits: { kind: "int", min: 1, max: 8, default: 2 },
  maxRenders: { kind: "int", min: 1, max: 4, default: 1 },
  maxEditsPerUser: { kind: "int", min: 0, max: 8, default: 0 },
  startDelayMinutes: { kind: "int", min: 0, max: 120, default: 0 },
  maxModelRetries: { kind: "int", min: 0, max: 50, default: 5 },
  cpuPerEditPercent: { kind: "percent", default: 100 },
  cpuTotalPercent: { kind: "percent", default: 100 },
  gpuPerEditPercent: { kind: "percent", default: 100 },
  gpuTotalPercent: { kind: "percent", default: 100 },
  storageRoots: { kind: "paths", default: [] },
  maxUploadGb: { kind: "int", min: 1, max: 2000, default: 200 },
  proxyCacheGb: { kind: "int", min: 1, max: 2000, default: 50 },
};

/** @type {(keyof AdminSettings)[]} */
const KEYS = /** @type {(keyof AdminSettings)[]} */ (Object.keys(DEFINITIONS));

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Checks one value strictly by type and clamps numbers into range.
 * @param {string} key
 * @param {Definition} definition
 * @param {unknown} value
 * @returns {number | string | string[]}
 */
function sanitize(key, definition, value) {
  switch (definition.kind) {
    case "int":
    case "percent": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidInput(`The setting "${key}" must be a number.`);
      }
      if (definition.kind === "percent") {
        return clamp(Math.round(value / PERCENT_STEP) * PERCENT_STEP, PERCENT_STEP, 100);
      }
      return clamp(Math.round(value), definition.min, definition.max);
    }
    case "setup": {
      const setup = SETUPS.find((candidate) => candidate === value);
      if (!setup) throw invalidInput(`The setting "${key}" must be one of ${SETUPS.join(", ")}.`);
      return setup;
    }
    case "paths": {
      if (!Array.isArray(value))
        throw invalidInput(`The setting "${key}" must be a list of folders.`);
      if (value.length > MAX_STORAGE_ROOTS) {
        throw invalidInput(`There can be at most ${MAX_STORAGE_ROOTS} storage folders.`);
      }
      /** @type {Set<string>} */
      const folders = new Set();
      for (const entry of /** @type {unknown[]} */ (value)) {
        if (typeof entry !== "string") {
          throw invalidInput(`The setting "${key}" must be a list of folders.`);
        }
        const trimmed = entry.trim();
        if (trimmed === "" || trimmed.includes("\0") || !isAbsolute(trimmed)) {
          throw invalidInput(`"${entry}" is not a full folder path.`);
        }
        // resolve() drops a trailing separator and `..`, so "/a/b/" and "/a/b" are one folder.
        folders.add(resolve(trimmed));
      }
      return [...folders];
    }
  }
}

/**
 * @param {{ repo: ReturnType<typeof import("./db/settings.js").createSettingsRepo> }} deps
 */
export function createSettings({ repo }) {
  /** @returns {AdminSettings} */
  function getAll() {
    const stored = repo.all();
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of KEYS) {
      const definition = DEFINITIONS[key];
      const value = stored[key];
      try {
        // A stored value that no longer fits (an older range, a hand edit) falls back to the default.
        result[key] = value === undefined ? definition.default : sanitize(key, definition, value);
      } catch {
        result[key] = definition.default;
      }
    }
    return /** @type {AdminSettings} */ (/** @type {unknown} */ (result));
  }

  const settings = {
    getAll,

    /**
     * Checks a partial change the way `update` does and returns what would be stored (numbers
     * clamped, folders cleaned), without writing anything.
     * @param {unknown} patch
     * @returns {Partial<AdminSettings>}
     */
    check(patch) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw invalidInput("The settings change must be an object.");
      }
      /** @type {Record<string, unknown>} */
      const clean = {};
      for (const [key, value] of Object.entries(patch)) {
        const definition = Object.hasOwn(DEFINITIONS, key)
          ? DEFINITIONS[/** @type {keyof AdminSettings} */ (key)]
          : undefined;
        if (!definition) throw invalidInput(`There is no setting called "${key}".`);
        clean[key] = sanitize(key, definition, value);
      }
      return /** @type {Partial<AdminSettings>} */ (clean);
    },

    /**
     * Applies a partial change; every value is checked before any is written.
     * @param {unknown} patch
     * @returns {AdminSettings} The settings after the change.
     */
    update(patch) {
      repo.setMany(settings.check(patch));
      return getAll();
    },

    /**
     * What every signed-in user may see: the setup and the limits that show in the UI.
     * @returns {PublicSettings}
     */
    publicView() {
      const all = getAll();
      return {
        setup: all.setup,
        maxUploadGb: all.maxUploadGb,
        maxEditsPerUser: all.maxEditsPerUser,
        startDelayMinutes: all.startDelayMinutes,
      };
    },
  };
  return settings;
}

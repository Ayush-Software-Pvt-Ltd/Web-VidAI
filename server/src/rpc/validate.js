// Input validators for RPC functions (docs/SPEC.md section 3: "validate input"). Each validator
// is `(value, field) => cleanValue` and throws `invalidInput` with a sentence that names the
// field and carries it as the error's `field` (when there is one), so a form can show the
// sentence under that input. Combine them with `object`; every function of every area uses
// these, so answers to bad input look the same everywhere.
//
//   const input = object({ id: string({ min: 1, max: 64 }), note: optional(string({ max: 500 })) })(raw);

import { invalidInput } from "../errors.js";

/**
 * @template T
 * @typedef {(value: unknown, field?: string) => T} Validator
 */

/** @param {string} field */
const named = (field) => (field ? `The field "${field}"` : "The request");

/** @param {string} parent @param {string} key */
const join = (parent, key) => (parent ? `${parent}.${key}` : key);

/** @param {unknown} value */
const isMissing = (value) => value === undefined || value === null;

/**
 * Text. `trim` trims before the length is checked and returns the trimmed text.
 * @param {{ min?: number, max?: number, trim?: boolean }} [options]
 * @returns {Validator<string>}
 */
export function string({ min = 0, max = Infinity, trim = false } = {}) {
  return (value, field = "") => {
    if (isMissing(value)) throw invalidInput(`${named(field)} is missing.`, field);
    if (typeof value !== "string") throw invalidInput(`${named(field)} must be text.`, field);
    const text = trim ? value.trim() : value;
    const length = [...text].length;
    if (length < min || length > max) {
      const range =
        max === Infinity
          ? `at least ${min} characters`
          : min === 0
            ? `at most ${max} characters`
            : `${min} to ${max} characters`;
      throw invalidInput(`${named(field)} must have ${range}.`, field);
    }
    return text;
  };
}

/**
 * A whole number; out-of-range values are refused, not clamped (clamping is for settings).
 * @param {{ min?: number, max?: number }} [options]
 * @returns {Validator<number>}
 */
export function integer({ min = -Infinity, max = Infinity } = {}) {
  return (value, field = "") => {
    if (isMissing(value)) throw invalidInput(`${named(field)} is missing.`, field);
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw invalidInput(`${named(field)} must be a whole number.`, field);
    }
    if (value < min || value > max) {
      throw invalidInput(`${named(field)} must be between ${min} and ${max}.`, field);
    }
    return value;
  };
}

/** @type {Validator<boolean>} */
export const boolean = (value, field = "") => {
  if (isMissing(value)) throw invalidInput(`${named(field)} is missing.`, field);
  if (typeof value !== "boolean")
    throw invalidInput(`${named(field)} must be true or false.`, field);
  return value;
};

/**
 * One of the listed values.
 * @template {string | number} T
 * @param {readonly T[]} allowed
 * @returns {Validator<T>}
 */
export function oneOf(allowed) {
  return (value, field = "") => {
    if (isMissing(value)) throw invalidInput(`${named(field)} is missing.`, field);
    const found = allowed.find((candidate) => candidate === value);
    if (found === undefined) {
      throw invalidInput(`${named(field)} must be one of ${allowed.join(", ")}.`, field);
    }
    return found;
  };
}

/**
 * A list whose items all pass `item`.
 * @template T
 * @param {Validator<T>} item
 * @param {{ max?: number }} [options]
 * @returns {Validator<T[]>}
 */
export function array(item, { max = Infinity } = {}) {
  return (value, field = "") => {
    if (isMissing(value)) throw invalidInput(`${named(field)} is missing.`, field);
    if (!Array.isArray(value)) throw invalidInput(`${named(field)} must be a list.`, field);
    if (value.length > max)
      throw invalidInput(`${named(field)} can have at most ${max} entries.`, field);
    return /** @type {unknown[]} */ (value).map((entry, index) =>
      item(entry, `${field}[${index}]`),
    );
  };
}

/**
 * Lets a field be left out (or null); it is then `undefined`.
 * @template T
 * @param {Validator<T>} inner
 * @returns {Validator<T | undefined>}
 */
export function optional(inner) {
  return (value, field = "") => (isMissing(value) ? undefined : inner(value, field));
}

/**
 * Lets a field be left out (or null); it is then `fallback`.
 * @template T
 * @param {Validator<T>} inner
 * @param {T} fallback
 * @returns {Validator<T>}
 */
export function withDefault(inner, fallback) {
  return (value, field = "") => (isMissing(value) ? fallback : inner(value, field));
}

/**
 * An object with exactly the listed fields (extra fields are refused unless `allowUnknown`).
 * Fields that `optional` leaves out and that have no fallback are left out of the result.
 * @template {Record<string, Validator<unknown>>} S
 * @param {S} shape
 * @param {{ allowUnknown?: boolean }} [options]
 * @returns {Validator<{ [K in keyof S]: ReturnType<S[K]> }>}
 */
export function object(shape, { allowUnknown = false } = {}) {
  return (value, field = "") => {
    if (isMissing(value)) throw invalidInput(`${named(field)} is missing.`, field);
    if (typeof value !== "object" || Array.isArray(value)) {
      throw invalidInput(`${named(field)} must be an object.`, field);
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    if (!allowUnknown) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(shape, key)) {
          throw invalidInput(`${named(join(field, key))} is not known here.`, join(field, key));
        }
      }
    }
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [key, validator] of Object.entries(shape)) {
      const clean = validator(record[key], join(field, key));
      if (clean !== undefined) result[key] = clean;
    }
    return /** @type {{ [K in keyof S]: ReturnType<S[K]> }} */ (result);
  };
}

// Passwords and emails (docs/SPEC.md section 4): scrypt with N 32768, r 8, p 1, a 16 byte salt
// and a 32 byte hash, stored as `scrypt$N$r$p$<salt b64>$<hash b64>`, compared in constant time.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { invalidInput } from "../errors.js";

const N = 32768;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

// Parameters read back from the database are bounded so a damaged or hostile value cannot make
// one login take gigabytes of memory.
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

// A valid hash of a password nobody knows, so a login for an unknown email does the same work
// as one for a known email and takes the same time.
const DUMMY_HASH =
  "scrypt$32768$8$1$2bqLGVvGesolxyEvh4zt7g==$R8Kv0rZ9S5ZChg2CNGk/0ywf4IyqAexF3OvAtcsIorg=";

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} n
 * @param {number} r
 * @param {number} p
 * @param {number} keyLength
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, n, r, p, keyLength) {
  return new Promise((resolve, reject) => {
    // scrypt needs 128 * N * r bytes; the default limit is exactly that, so raise it.
    const maxmem = 128 * n * r * 2 + 1024 * 1024;
    scrypt(password, salt, keyLength, { N: n, r, p, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * @param {string} password
 * @returns {Promise<string>} The stored form.
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, N, R, P, HASH_BYTES);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Whether `password` matches the stored form. Unknown or malformed stored values give false,
 * never an exception.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  try {
    const actual = await derive(
      password,
      parsed.salt,
      parsed.n,
      parsed.r,
      parsed.p,
      parsed.hash.length,
    );
    return timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * Does the work of a verification against a hash nobody can match; for an unknown email.
 * @returns {Promise<false>}
 */
export async function dummyVerify() {
  await verifyPassword("dummy-password", DUMMY_HASH);
  return false;
}

/**
 * @param {unknown} stored
 * @returns {{ n: number, r: number, p: number, salt: Buffer, hash: Buffer } | null}
 */
function parseStored(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nText, rText, pText, saltText, hashText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  if (128 * n * r > MAX_MEMORY_BYTES) return null;
  const salt = decodeBase64(saltText);
  const hash = decodeBase64(hashText);
  if (!salt || salt.length < 8 || !hash || hash.length < 16 || hash.length > 128) return null;
  return { n, r, p, salt, hash };
}

/** @param {string | undefined} text @returns {Buffer | null} */
function decodeBase64(text) {
  if (text === undefined || !BASE64.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  // Reject sloppy encodings so one hash has one spelling.
  return bytes.toString("base64") === text ? bytes : null;
}

/**
 * Normalises an email (trimmed, lower-case) and checks it (SPEC section 4).
 * @param {unknown} value
 * @param {string} [field] The input field a refusal names (default `email`).
 * @returns {string}
 */
export function validateEmail(value, field = "email") {
  if (typeof value !== "string") throw invalidInput("Enter an email address.", field);
  const email = value.trim().toLowerCase();
  if (email.length > EMAIL_MAX) {
    throw invalidInput(`The email address can have at most ${EMAIL_MAX} characters.`, field);
  }
  const at = email.indexOf("@");
  const valid =
    at > 0 &&
    at === email.lastIndexOf("@") &&
    at < email.length - 1 &&
    // eslint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(email);
  if (!valid) throw invalidInput("Enter a valid email address, like name@example.com.", field);
  return email;
}

/**
 * The length rule of SPEC section 4; the password itself is never trimmed or changed.
 * @param {unknown} value
 * @param {string} [field] The input field a refusal names (default `password`).
 * @returns {string}
 */
export function validatePassword(value, field = "password") {
  if (typeof value !== "string") throw invalidInput("Enter a password.", field);
  const length = [...value].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw invalidInput(
      `The password must have ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
      field,
    );
  }
  return value;
}

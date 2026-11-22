// API keys at rest (docs/SPEC.md section 5): AES-256-GCM under the 32 byte `secret.key` file of
// the data directory, one row per name in the `secrets` table. The UI only ever learns whether
// a key is saved and its last 4 characters.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, invalidInput } from "./errors.js";
import { createSecretsRepo } from "./db/secrets.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// Short values would be shown almost completely by "last 4 characters".
const LAST4_MIN_LENGTH = 8;

/**
 * @typedef {object} SecretStatus
 * @property {boolean} saved
 * @property {string | null} last4
 */

/**
 * @param {{
 *   db: import("./db/open.js").Database,
 *   keyFile: string,
 *   memory?: boolean,
 *   log?: { warn(message: string): void },
 * }} deps `memory: true` (env `VIDAI_SECRETS=memory`) keeps values in a Map and writes nothing.
 */
export function createSecrets({ db, keyFile, memory = false, log }) {
  const repo = createSecretsRepo(db);
  /** @type {Map<string, string>} */
  const volatile = new Map();
  /** @type {Buffer | null} */
  let key = null;
  let warned = false;

  /** @param {string} message */
  function warnOnce(message) {
    if (warned) return;
    warned = true;
    log?.warn(message);
  }

  /** Reads the key file, creating it with owner-only access the first time. */
  function loadKey() {
    if (key) return key;
    try {
      mkdirSync(dirname(keyFile), { recursive: true });
      writeFileSync(keyFile, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
    } catch (error) {
      // Created before (or by another start-up); anything else surfaces when reading.
      if (/** @type {{ code?: string }} */ (error).code !== "EEXIST") throw error;
    }
    const bytes = readFileSync(keyFile);
    if (bytes.length !== KEY_BYTES) {
      throw new Error(`The key file ${keyFile} must hold exactly ${KEY_BYTES} bytes.`);
    }
    key = bytes;
    return key;
  }

  return {
    /**
     * Stores (or replaces) a value.
     * @param {string} name
     * @param {string} value
     */
    set(name, value) {
      if (typeof value !== "string" || value.length === 0) {
        throw invalidInput("Enter the key before saving it.");
      }
      if (memory) {
        volatile.set(name, value);
        return;
      }
      let secretKey;
      try {
        secretKey = loadKey();
      } catch (error) {
        throw new AppError(
          "io",
          "The server's secret key file cannot be read, so the key was not saved.",
          {
            cause: error,
          },
        );
      }
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", secretKey, nonce);
      // The name is authenticated too, so a row cannot be moved to another name.
      cipher.setAAD(Buffer.from(name));
      const sealed = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      repo.set(name, {
        nonce,
        cipher: sealed,
        last4: value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : "",
      });
    },

    /**
     * The value, or null when not saved or when it cannot be decrypted (a changed or replaced
     * key file, a damaged row); that is logged once and never throws.
     * @param {string} name
     * @returns {string | null}
     */
    get(name) {
      if (memory) return volatile.get(name) ?? null;
      const row = repo.get(name);
      if (!row) return null;
      try {
        const sealed = Buffer.from(row.cipher);
        if (sealed.length < TAG_BYTES) throw new Error("The stored value is too short.");
        const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(row.nonce));
        decipher.setAAD(Buffer.from(name));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        const plain = Buffer.concat([
          decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
          decipher.final(),
        ]);
        return plain.toString("utf8");
      } catch {
        warnOnce(
          `A saved key ("${name}") could not be decrypted: the secret key file changed or the data is damaged. Enter the key again in Settings.`,
        );
        return null;
      }
    },

    /** @param {string} name */
    clear(name) {
      if (memory) volatile.delete(name);
      else repo.delete(name);
    },

    /**
     * What the UI may know (SPEC section 5): saved or not, and the last 4 characters.
     * @param {string} name
     * @returns {SecretStatus}
     */
    status(name) {
      if (memory) {
        const value = volatile.get(name);
        if (value === undefined) return { saved: false, last4: null };
        return { saved: true, last4: value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null };
      }
      const row = repo.get(name);
      if (!row) return { saved: false, last4: null };
      return { saved: true, last4: row.last4 === "" ? null : row.last4 };
    },
  };
}

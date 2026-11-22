// Keeping secrets out of the job log (src-tauri/src/jobs/log.rs, `add_secret_as` and `scrub_all`).
//
// An API key given to a job is registered here; every text that is written to the log file or
// sent to the browser goes through `scrub` first, which replaces the key by a label
// (`[api key]`).

/** The label that replaces an API key. */
export const API_KEY_LABEL = "[api key]";

/**
 * @typedef {object} Scrubber
 * @property {(secret: string, label?: string) => void} add Registers a secret to scrub from every
 *   later text as `label` (default `[api key]`). Blank secrets are ignored, the same secret is
 *   registered once.
 * @property {(text: string) => string} scrub `text` with every registered secret replaced by its
 *   label. Texts are scrubbed BEFORE they are cut to a length, so a secret cut in half by the
 *   limit cannot leave a prefix behind.
 */

/**
 * @returns {Scrubber}
 */
export function createScrubber() {
  /** @type {Set<string>} */
  const known = new Set();
  /** @type {{ secret: string, label: string }[]} */
  let forms = [];
  return {
    add(secret, label = API_KEY_LABEL) {
      const trimmed = secret.trim();
      if (trimmed === "" || known.has(trimmed)) return;
      known.add(trimmed);
      // The secret as it appears inside a JSON string (tool inputs are logged as JSON), when
      // that differs from the plain one.
      const escaped = JSON.stringify(trimmed).slice(1, -1);
      const both = escaped === trimmed ? [trimmed] : [trimmed, escaped];
      // Longest first, so a secret that contains another one is replaced whole.
      forms = [...forms, ...both.map((s) => ({ secret: s, label }))].sort(
        (a, b) => b.secret.length - a.secret.length,
      );
    },
    scrub(text) {
      let out = text;
      for (const { secret, label } of forms) out = out.replaceAll(secret, label);
      return out;
    },
  };
}

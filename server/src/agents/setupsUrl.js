// Checking and normalizing the address an admin types for an API option (docs/SPEC.md section 5,
// "Harness, program and model").

import { invalidInput } from "../errors.js";
import { defaultBaseUrl, protocolOf } from "./setups.js";

/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */

/** Hosts that are this computer: the only ones allowed plain `http://`. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Suffixes the form of a protocol removes, in order: Claude Code and OpenCode 2's Anthropic package append `/v1/messages` themselves. */
const SUFFIXES = {
  anthropic: ["/v1/messages", "/v1"],
  // The OpenAI form keeps its `/v1`: it is part of the address.
  openai: ["/chat/completions"],
};

/**
 * Checks and normalizes an address typed for `option`. Returns null for "the default address of
 * the option" (null, an empty text, or the default itself).
 *
 * Accepted: `https://` anywhere, plain `http://` only for this computer (`localhost`,
 * `127.0.0.1`, `[::1]`). No user name or password, query or fragment. A pasted trailing `/` is
 * removed. By the protocol of the option: the Anthropic form (`opencodeGo`, `anthropicApi`) also
 * drops a trailing `/v1/messages` or `/v1`; the OpenAI form (`openaiApi`) drops a trailing
 * `/chat/completions` and keeps `/v1`.
 * @param {ApiOption} option
 * @param {unknown} input
 * @returns {string | null}
 * @throws {import("../errors.js").AppError} `invalidInput` with the reason.
 */
export function normalizeBaseUrl(option, input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") throw invalidInput("The address must be text.");
  const text = input.trim();
  if (text === "") return null;
  const invalid = () =>
    invalidInput(
      `Enter an address that starts with https://, for example ${defaultBaseUrl(option)}.`,
    );
  /** @type {URL} */
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    // fine
  } else if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw invalidInput(
        "Use https:// for the address. Plain http:// is only allowed for an address on this computer (localhost).",
      );
    }
  } else {
    throw invalid();
  }
  if (host === "") throw invalid();
  if (url.username !== "" || url.password !== "") {
    throw invalidInput(
      "Leave the user name and password out of the address; VidAI sends the API key itself.",
    );
  }
  // `search` and `hash` are empty for a bare `?` or `#`, which must be refused as well.
  if (url.search !== "" || url.hash !== "" || /[?#]/u.test(text)) {
    throw invalidInput("The address cannot contain a ? or # part.");
  }
  let path = trimSlashes(url.pathname);
  for (const suffix of SUFFIXES[protocolOf(option)]) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = trimSlashes(path.slice(0, path.length - suffix.length));
    }
  }
  // `hostname` keeps the brackets of an IPv6 address; `port` is empty for the default port.
  const port = url.port === "" ? "" : `:${url.port}`;
  const normalized = `${url.protocol}//${host}${port}${path}`;
  return normalized === defaultBaseUrl(option) ? null : normalized;
}

/** @param {string} path */
function trimSlashes(path) {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/**
 * The pure rules of the harness area of the mock, the same as `server/src/agents/setupsUrl.js`
 * and the HTTP probes of the server (address normalization per protocol, which model list an
 * address has, what the Test request answers, which keys and addresses the mock's services
 * refuse).
 *
 * Mock conventions, so every state can be reached from the UI:
 * - a key that contains `bad` after a `_` or `-` (or starts with it, `oc_sk_bad...`) is refused
 *   by its service (Test fails with the 401 text);
 * - on an OpenCode address, a model whose id ends in `-free` is refused for this client (Test
 *   fails with the 403 text);
 * - an address with `fail` in it, or a model server on this computer that is not running
 *   (`localhost:11434`, Ollama's port), cannot be reached (the model list fails);
 * - the OpenCode Go address lists the 30 Go models, any other OpenCode address the 86
 *   pay-as-you-go models; an Anthropic compatible API lists the Claude models, any other
 *   OpenAI compatible address ten common models.
 */
import {
  API_DEFAULT_BASE_URL,
  API_PROTOCOL,
  SETUP_INFO,
  isGoAddress,
  isOpencodeHost,
  setupOfOption,
} from "../setup";
import type { ApiModel, ApiOption, ApiTest } from "../types";
import { ANTHROPIC_MODELS, GO_MODELS, OPENAI_MODELS, PAY_AS_YOU_GO_MODELS } from "./seed/apiModels";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Mirrors `normalizeBaseUrl` of the server: `null` is the default address of the option; throws
 * an `Error` with the same sentences for what the server refuses. The Anthropic form drops a
 * trailing `/v1/messages` or `/v1`; the OpenAI form drops `/chat/completions` and keeps the `/v1`.
 */
export function normalizeBaseUrl(option: ApiOption, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const invalid = `Enter an address that starts with https://, for example ${API_DEFAULT_BASE_URL[option]}.`;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(invalid);
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && !LOOPBACK.has(host)) {
    throw new Error(
      "Use https:// for the address. Plain http:// is only allowed for an address on this computer (localhost).",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(invalid);
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "Leave the user name and password out of the address; VidAI sends the API key itself.",
    );
  }
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(trimmed)) {
    throw new Error("The address cannot contain a ? or # part.");
  }
  const suffixes =
    API_PROTOCOL[option] === "anthropic" ? ["/v1/messages", "/v1"] : ["/chat/completions"];
  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of suffixes) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, "");
    }
  }
  const normalized = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${path}`;
  return normalized === API_DEFAULT_BASE_URL[option] ? null : normalized;
}

/** The models the mock's service offers for `option` at `baseUrl`. */
export function modelsFor(option: ApiOption, baseUrl: string): readonly ApiModel[] {
  if (isGoAddress(baseUrl)) return GO_MODELS;
  if (isOpencodeHost(baseUrl)) return PAY_AS_YOU_GO_MODELS;
  return API_PROTOCOL[option] === "anthropic" ? ANTHROPIC_MODELS : OPENAI_MODELS;
}

/** Whether a key of the mock is one its service refuses (see the module comment). */
export function isBadKey(key: string): boolean {
  return /(^|[_-])bad/i.test(key);
}

/**
 * What the Test request answers (the texts of the server's `apiHttpFailure.js`: OpenCode is
 * named for an OpenCode address, "the service" otherwise).
 */
export function testOutcome(
  option: ApiOption,
  baseUrl: string,
  key: string | null,
  model: string,
  modelName: string,
): ApiTest {
  const open = isOpencodeHost(baseUrl);
  if (key !== null && isBadKey(key)) {
    return {
      ok: false,
      message: open
        ? "OpenCode did not accept the API key. Check that you copied the whole key, or make a new one in the OpenCode console."
        : "The service did not accept the API key. Check that you copied the whole key, or make a new one with the service.",
    };
  }
  if (open && model.endsWith("-free")) {
    return {
      ok: false,
      message: `OpenCode does not allow the model ${model} for this key: it is not in your plan, or it is a free model that only works in OpenCode's own apps. Choose another model in Admin, Harness and Model.`,
    };
  }
  return {
    ok: true,
    message: `${SETUP_INFO[setupOfOption(option)].service} answered with ${modelName}.`,
  };
}

/** Whether the mock's service at `baseUrl` is down (see the module comment). */
export function isUnreachable(baseUrl: string): boolean {
  return (
    baseUrl.includes("fail") ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):11434(\/|$)/.test(baseUrl)
  );
}

/** What a model list request that cannot reach the address says. */
export function unreachableText(baseUrl: string): string {
  return `Could not reach ${isOpencodeHost(baseUrl) ? "OpenCode" : "the service"}. Check the address and your internet connection.`;
}

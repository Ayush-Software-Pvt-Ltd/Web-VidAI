// VidAI's own requests to a service (SPEC-desktop section 7a, "Options, addresses and protocols";
// src-tauri/src/opencode/http.rs):
//
//   option          model list                         test
//   opencodeGo      GET <address>/v1/models, bearer    POST <address>/v1/messages, bearer
//   anthropicApi    GET <address>/v1/models, x-api-key POST <address>/v1/messages, x-api-key
//   openaiApi       GET <address>/models, bearer       POST <address>/chat/completions, bearer
//
// The model list is fetched only when the admin presses Fetch Models (or refreshes OpenCode
// Go); it is a pick list, never authoritative for `anthropicApi` and `openaiApi`. Every request
// has a time limit, follows no redirect (the key must never follow one), identifies itself as
// `VidAI/<version>`, and the key never appears in a message or a log: nothing here logs, and
// every sentence is built from the status and fixed words.
//
// `fetch` is injected (Node's built-in one by default). It has no separate connect timeout, so
// the limits below are for the whole request (the desktop app had 5 seconds to connect).

import { AppError, invalidInput } from "../errors.js";
import { failureText, objectOf, serviceForBaseUrl, subjectOf } from "./apiHttpFailure.js";
import { parseModelsPage, parseOpenaiModels } from "./apiHttpModels.js";
import { SETUP_INFO, protocolOf, scrubKey, setupOfOption } from "./setups.js";

/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiModel} ApiModel */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiTest} ApiTest */
/** @typedef {import("./apiHttpFailure.js").Audience} Audience */
/** @typedef {import("./apiHttpFailure.js").Service} Service */

/**
 * @typedef {object} HttpTimings Milliseconds; every one has a real default.
 * @property {number} listMs The model list and the quota.
 * @property {number} testMs The Test request runs the model once, which can take a while on a
 *   cold model.
 */

/** @type {HttpTimings} */
const DEFAULT_TIMINGS = { listMs: 15_000, testMs: 60_000 };
/** The most pages of models followed (a gateway that never ends its list stops here). */
const MAX_PAGES = 50;
/** More than this of an answer is not read (no model list or error text is that long). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ANTHROPIC_VERSION = "2023-06-01";

/** Error codes of a connection that never got to the service. */
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);
/** Error codes of a connection that took too long. */
const TOO_SLOW = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * @param {unknown} error
 * @returns {string[]} The error codes of an error and of its causes.
 */
function codesOf(error) {
  /** @type {string[]} */
  const codes = [];
  /** @type {unknown[]} */
  const queue = [error];
  for (let seen = 0; queue.length > 0 && seen < 8; seen += 1) {
    const current = queue.shift();
    if (typeof current !== "object" || current === null) continue;
    const { code, cause, errors } = /** @type {Record<string, unknown>} */ (current);
    if (typeof code === "string") codes.push(code);
    queue.push(cause);
    if (Array.isArray(errors)) queue.push(.../** @type {unknown[]} */ (errors));
  }
  return codes;
}

/**
 * A readable sentence for a request that got no answer.
 * @param {unknown} error
 * @param {Service} service
 */
export function transportFailure(error, service) {
  const name = error instanceof Error ? error.name : "";
  const codes = codesOf(error);
  if (name === "TimeoutError" || name === "AbortError" || codes.some((c) => TOO_SLOW.has(c))) {
    return `${subjectOf(service)} did not answer in time. Check your internet connection and try again.`;
  }
  if (codes.some((c) => UNREACHABLE.has(c))) {
    return `Could not reach ${objectOf(service)}. Check the address and your internet connection.`;
  }
  return `The connection to ${objectOf(service)} failed. Check your internet connection and try again.`;
}

/**
 * Reads at most `MAX_BODY_BYTES` of an answer as text.
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

/**
 * @param {{ fetch?: typeof fetch, version: string, timings?: Partial<HttpTimings> }} deps
 */
export function createApiHttp({ fetch: fetchFn = globalThis.fetch, version, timings = {} }) {
  const limits = { ...DEFAULT_TIMINGS, ...timings };

  /**
   * One request: the status and the body, or an `AppError` with a readable sentence. A redirect is
   * an error: the key must not follow it.
   * @param {string} url
   * @param {{ method: "GET" | "POST", headers: Record<string, string>, body?: string }} request
   * @param {number} timeoutMs
   * @param {Service} service
   * @returns {Promise<{ status: number, body: string }>}
   */
  async function send(url, request, timeoutMs, service) {
    /** @type {Response} */
    let response;
    /** @type {string} */
    let body;
    try {
      response = await fetchFn(url, {
        method: request.method,
        headers: { "user-agent": `VidAI/${version}`, ...request.headers },
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await readText(response);
    } catch (error) {
      throw new AppError("internal", transportFailure(error, service));
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new AppError(
        "internal",
        `${subjectOf(service)} answered with a redirect, which VidAI does not follow. Check the address.`,
      );
    }
    return { status: response.status, body };
  }

  /**
   * The headers that carry the key the way the option's service wants it: a bearer token, or
   * Anthropic's `x-api-key`; and the version header of the Anthropic protocol.
   * @param {ApiOption} option
   * @param {string | null} key
   * @returns {Record<string, string>}
   */
  function authHeaders(option, key) {
    /** @type {Record<string, string>} */
    const headers = { accept: "application/json" };
    if (protocolOf(option) === "anthropic") headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (key !== null) {
      if (option === "anthropicApi") headers["x-api-key"] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    return headers;
  }

  /**
   * @param {string} text
   * @param {Service} service
   * @returns {URL}
   */
  function parseUrl(text, service) {
    try {
      return new URL(text);
    } catch {
      throw invalidInput(`The address of ${objectOf(service)} is not valid.`);
    }
  }

  return {
    /**
     * Every model of `option` at `baseUrl`. With a key the request carries it (a key may see
     * models the public list does not); without one the public list is asked. The Anthropic form
     * is followed with `has_more`; the OpenAI form is one answer.
     * @param {ApiOption} option
     * @param {string} baseUrl
     * @param {string | null} key
     * @param {{ audience?: Audience }} [options]
     * @returns {Promise<ApiModel[]>}
     * @throws {AppError} with a readable sentence, never containing the key.
     */
    async fetchModels(option, baseUrl, key, { audience = "admin" } = {}) {
      const service = serviceForBaseUrl(baseUrl);
      const openai = protocolOf(option) === "openai";
      const url = parseUrl(`${baseUrl}/${openai ? "models" : "v1/models"}`, service);
      const notAList = () =>
        new AppError(
          "internal",
          `${subjectOf(service)} answered, but not with a model list. Check the address.`,
        );
      /** @type {ApiModel[]} */
      const models = [];
      /** @type {string | null} */
      let after = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const pageUrl = new URL(url);
        if (!openai) {
          pageUrl.searchParams.set("limit", "1000");
          if (after !== null) pageUrl.searchParams.set("after_id", after);
        }
        const answer = await send(
          pageUrl.href,
          { method: "GET", headers: authHeaders(option, key) },
          limits.listMs,
          service,
        );
        if (answer.status !== 200) {
          throw new AppError(
            "internal",
            scrubKey(
              failureText(answer.status, answer.body, null, {
                service,
                hasKey: key !== null,
                audience,
              }),
              key,
            ),
          );
        }
        if (openai) {
          const list = parseOpenaiModels(answer.body);
          if (list === null) throw notAList();
          return list;
        }
        const parsed = parseModelsPage(answer.body);
        if (parsed === null) throw notAList();
        for (const model of parsed.models) {
          if (!models.some((known) => known.id === model.id)) models.push(model);
        }
        // A gateway that repeats its last page cannot loop us.
        if (parsed.next === null || parsed.next === after) return models;
        after = parsed.next;
      }
      return models;
    },

    /**
     * The Test action: one tiny request with `max_tokens` 1 (`POST <address>/v1/messages` for the
     * Anthropic protocol, `POST <address>/chat/completions` for OpenAI's). Never throws: every
     * problem is a readable `ApiTest` with `ok: false`.
     * @param {ApiOption} option
     * @param {string} baseUrl
     * @param {string | null} key
     * @param {string} model
     * @param {string} modelName What the success sentence calls the model.
     * @param {{ audience?: Audience }} [options]
     * @returns {Promise<ApiTest>}
     */
    async testApi(option, baseUrl, key, model, modelName, { audience = "admin" } = {}) {
      const service = serviceForBaseUrl(baseUrl);
      const anthropic = protocolOf(option) === "anthropic";
      try {
        const url = parseUrl(
          `${baseUrl}/${anthropic ? "v1/messages" : "chat/completions"}`,
          service,
        );
        const answer = await send(
          url.href,
          {
            method: "POST",
            headers: { ...authHeaders(option, key), "content-type": "application/json" },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: "user", content: "Hi" }],
            }),
          },
          limits.testMs,
          service,
        );
        if (answer.status !== 200) {
          return {
            ok: false,
            message: scrubKey(
              failureText(answer.status, answer.body, model, {
                service,
                hasKey: key !== null,
                audience,
              }),
              key,
            ),
          };
        }
        /** @type {unknown} */
        let message = null;
        try {
          message = JSON.parse(answer.body);
        } catch {
          // not as expected, below
        }
        const record =
          typeof message === "object" && message !== null
            ? /** @type {Record<string, unknown>} */ (message)
            : {};
        const asExpected = anthropic ? record.type === "message" : Array.isArray(record.choices);
        if (!asExpected) {
          return {
            ok: false,
            message: `${subjectOf(service)} answered, but not as expected. Check the address.`,
          };
        }
        return {
          ok: true,
          message: `${SETUP_INFO[setupOfOption(option)].service} answered with ${modelName}.`,
        };
      } catch (error) {
        const text = error instanceof AppError ? error.message : "The request could not be made.";
        return { ok: false, message: scrubKey(text, key) };
      }
    },

    /**
     * `GET <url>` with the key as a bearer token, for the quota (OpenCode's own gateway).
     * @param {string} url
     * @param {string} key
     * @returns {Promise<{ status: number, body: string }>}
     * @throws {AppError} with a readable sentence when there is no answer.
     */
    async getWithKey(url, key) {
      const service = "opencode";
      const parsed = parseUrl(url, service);
      return send(
        parsed.href,
        { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` } },
        limits.listMs,
        service,
      );
    },
  };
}

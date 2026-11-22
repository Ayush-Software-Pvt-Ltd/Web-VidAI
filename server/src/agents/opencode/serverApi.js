// The HTTP client of one OpenCode 2 server (docs/SPEC.md section 8, "Driving OpenCode 2";
// "Driving OpenCode 2" in section 8): every request goes to 127.0.0.1 with HTTP basic auth (user
// `opencode`, the per-run password), the directory of the job in `x-opencode-directory`, a time
// limit, and no redirect.
//
// Every failure is an `OpencodeRequestError` with a sentence for the user. The body of a refusal is
// capped, and a key never reaches here: it is only in the server's environment.

import { sessionBody } from "./events.js";
import {
  KEY_VAR,
  USERNAME,
  VIDAI_PROVIDER,
  customModel,
  modelJson,
  sessionPermissions,
} from "./launch.js";
import { OpencodeRequestError, describeFetchError } from "./serverErrors.js";

/** @typedef {import("./launch.js").ModelRef} ModelRef */
/** @typedef {import("./events.js").Action} Action */

/** Longest part of an error body that is put into a sentence. */
const BODY_CHARS = 500;

/**
 * Percent-encodes a header value, a path segment or a query value the way `encodeURIComponent`
 * does (an Editing Folder may have spaces or Devanagari in its path; OpenCode decodes the header
 * with `decodeURIComponent`).
 * @param {string} text
 * @returns {string}
 */
export function encode(text) {
  return encodeURIComponent(text);
}

/**
 * Whether a built-in provider would use `OPENCODE_API_KEY` (`GET /api/integration/<id>`: its first
 * connection, the one it uses, comes from that variable rather than a stored login).
 * @param {unknown} integration
 * @returns {boolean}
 */
export function usesKeyVariable(integration) {
  const data = /** @type {{ data?: { connections?: unknown[] } } | null} */ (integration)?.data;
  const first = /** @type {{ type?: unknown, name?: unknown } | undefined} */ (
    data?.connections?.[0]
  );
  return first?.type === "env" && first.name === KEY_VAR;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The entry of `model` in the catalog (`GET /api/model`: `data` is a list with `providerID` and
 * `id` or `modelID`), or `null`.
 * @param {unknown} list
 * @param {ModelRef} model
 * @returns {Record<string, unknown> | null}
 */
export function catalogEntry(list, model) {
  const data = arrayOf(/** @type {{ data?: unknown } | null} */ (list)?.data);
  for (const entry of data) {
    const m = /** @type {Record<string, unknown> | null} */ (entry);
    if (m === null || typeof m !== "object") continue;
    if (m["providerID"] !== model.providerId) continue;
    if (m["id"] === model.modelId || m["modelID"] === model.modelId) return m;
  }
  return null;
}

/**
 * @typedef {object} ApiOptions
 * @property {string} base The server's address (`http://127.0.0.1:<port>`).
 * @property {string} password
 * @property {string} directory The folder of the job (the Editing Folder).
 * @property {number} requestTimeoutMs
 * @property {typeof fetch} fetch
 * @property {(text: string) => void} onWarn Told what could not be done without waiting (an
 *   answer that did not arrive), one line each.
 */

/**
 * The API of one server.
 * @param {ApiOptions} options
 */
export function createApi(options) {
  const authorization = `Basic ${Buffer.from(`${USERNAME}:${options.password}`).toString("base64")}`;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<{ status: number, text: string }>}
   */
  async function request(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = {
      authorization,
      "x-opencode-directory": encode(options.directory),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await options.fetch(`${options.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      throw describeFetchError(error);
    }
  }

  /** @param {string} text */
  const brief = (text) => text.trim().slice(0, BODY_CHARS);
  /** @param {number} status */
  const ok = (status) => status >= 200 && status < 300;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  async function json(method, path, body) {
    const { status, text } = await request(method, path, body);
    if (!ok(status)) {
      throw new OpencodeRequestError(
        "other",
        `OpenCode answered ${path} with HTTP ${status}: ${brief(text)}`,
      );
    }
    try {
      return /** @type {unknown} */ (JSON.parse(text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpencodeRequestError(
        "other",
        `OpenCode answered ${path} with something unexpected: ${reason}`,
      );
    }
  }

  /** @param {string} session */
  const runningPath = (session) =>
    `/api/experimental/job?sessionID=${encode(session)}&descendants=true&status=running`;

  return {
    request,
    json,
    encode,

    /**
     * Creates the job's session. OpenCode chooses its id.
     * @param {string} title
     * @param {ModelRef} model
     * @param {string | null} variant
     * @returns {Promise<string>}
     */
    async createSession(title, model, variant) {
      const body = sessionBody(
        title,
        modelJson(model, variant),
        sessionPermissions(),
        options.directory,
      );
      const session = /** @type {{ data?: { id?: unknown } } | null} */ (
        await json("POST", "/api/session", body)
      );
      const id = session?.data?.id;
      if (typeof id !== "string" || id === "") {
        throw new OpencodeRequestError("other", "OpenCode did not say which session it created");
      }
      return id;
    },

    /**
     * Whether the session exists; one that ran on another model (or reasoning effort) is moved to
     * `model` with `variant`.
     * @param {string} id
     * @param {ModelRef} model
     * @param {string | null} variant
     * @returns {Promise<boolean>}
     */
    async resumeSession(id, model, variant) {
      const { status, text } = await request("GET", `/api/session/${encode(id)}`);
      if (status === 404) return false;
      if (!ok(status)) {
        throw new OpencodeRequestError(
          "other",
          `OpenCode could not look up the session (HTTP ${status}): ${brief(text)}`,
        );
      }
      /** @type {{ data?: { model?: Record<string, unknown> | null } } | null} */
      let session = null;
      try {
        session = JSON.parse(text);
      } catch {
        // Treated as a session whose model is unknown: it is switched below.
      }
      const current = session?.data?.model;
      const same =
        current?.["providerID"] === model.providerId &&
        current?.["id"] === model.modelId &&
        (current?.["variant"] ?? null) === variant;
      if (!same) {
        const switched = await request("POST", `/api/session/${encode(id)}/model`, {
          model: modelJson(model, variant),
        });
        if (!ok(switched.status)) {
          throw new OpencodeRequestError(
            "other",
            `OpenCode could not switch the session to the model (HTTP ${switched.status}): ${brief(switched.text)}`,
          );
        }
      }
      return true;
    },

    /**
     * The variant names of `model` in the server's catalog; `null` when the catalog cannot be
     * read or lacks the model.
     * @param {ModelRef} model
     * @returns {Promise<string[] | null>}
     */
    async variants(model) {
      /** @type {unknown} */
      let list;
      try {
        list = await json("GET", "/api/model");
      } catch {
        return null;
      }
      const found = catalogEntry(list, model);
      if (found === null) return null;
      const ids = [];
      for (const variant of arrayOf(found["variants"])) {
        const id = /** @type {{ id?: unknown } | null} */ (variant)?.id;
        if (typeof id === "string") ids.push(id);
      }
      return ids;
    },

    /**
     * `wanted` when its built-in provider lists the model and would use VidAI's key (or, for a
     * test login, whatever login it has), else the model through VidAI's own provider, which
     * always uses VidAI's key. When the server cannot say, VidAI's own provider.
     * @param {ModelRef} wanted
     * @param {boolean} testLogin
     * @returns {Promise<ModelRef>}
     */
    async chooseModel(wanted, testLogin) {
      if (wanted.providerId === VIDAI_PROVIDER) return wanted;
      const listed = await json("GET", "/api/model").then(
        (list) => catalogEntry(list, wanted) !== null,
        () => false,
      );
      const ownKey =
        testLogin ||
        (await json("GET", `/api/integration/${encode(wanted.providerId)}`).then(
          usesKeyVariable,
          () => false,
        ));
      return listed && ownKey ? wanted : customModel(wanted.modelId);
    },

    /**
     * The ids of the session tree's background work that runs now, or `null` when the server
     * cannot say.
     * @param {string} session
     * @returns {Promise<string[] | null>}
     */
    async runningJobs(session) {
      /** @type {unknown} */
      let list;
      try {
        list = await json("GET", runningPath(session));
      } catch {
        return null;
      }
      const data = /** @type {{ data?: unknown } | null} */ (list)?.data;
      if (!Array.isArray(data)) return null;
      const ids = [];
      for (const job of data) {
        const j = /** @type {{ status?: unknown, id?: unknown } | null} */ (job);
        if (j?.status === "running" && typeof j.id === "string") ids.push(j.id);
      }
      return ids;
    },

    /**
     * Interrupts the session's running turn.
     * @param {string} session
     * @returns {Promise<{ success: boolean, error: string | null }>}
     */
    async interrupt(session) {
      const { status, text } = await request("POST", `/api/session/${encode(session)}/interrupt`);
      return ok(status) ? { success: true, error: null } : { success: false, error: text };
    },

    /**
     * Ends the commands of the session tree that run in the background and interrupts its
     * sub-agents (an interrupt of the session alone leaves them running, and their reports would
     * wake it again). Never throws.
     * @param {string} session
     * @returns {Promise<void>}
     */
    async stopBackground(session) {
      /** @type {unknown} */
      let list;
      try {
        list = await json("GET", runningPath(session));
      } catch {
        return;
      }
      for (const job of arrayOf(/** @type {{ data?: unknown } | null} */ (list)?.data)) {
        const j = /** @type {Record<string, unknown> | null} */ (job);
        const kind = j?.["kind"];
        const shell = j?.["shellID"];
        const child = j?.["childSessionID"];
        /** @type {[string, string] | null} */
        let call = null;
        if (kind === "shell" && typeof shell === "string") {
          call = ["DELETE", `/api/shell/${encode(shell)}`];
        } else if (kind === "subagent" && typeof child === "string") {
          call = ["POST", `/api/session/${encode(child)}/interrupt`];
        }
        if (call === null) continue;
        try {
          await request(call[0], call[1]);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          options.onWarn(`Could not stop OpenCode's background work (${call[1]}): ${why}`);
        }
      }
    },

    /**
     * Answers a permission request or a form, or interrupts a session, without waiting. Never
     * throws; a failure goes to `onWarn`.
     * @param {Action} action
     * @param {string} questionCancelled The text a cancelled question gives the model.
     */
    answer(action, questionCancelled) {
      /** @type {[string, string, unknown]} */
      let call;
      const session = encode(action.session);
      if (action.type === "replyPermission") {
        call = [
          "POST",
          `/api/session/${session}/permission/${encode(action.id)}/reply`,
          { decision: "once" },
        ];
      } else if (action.type === "cancelForm") {
        call = [
          "DELETE",
          `/api/session/${session}/form/${encode(action.id)}?message=${encode(questionCancelled)}`,
          undefined,
        ];
      } else {
        call = ["POST", `/api/session/${session}/interrupt`, undefined];
      }
      request(call[0], call[1], call[2]).catch((error) => {
        const why = error instanceof Error ? error.message : String(error);
        options.onWarn(`Could not answer OpenCode (${call[1]}): ${why}`);
      });
    },
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */

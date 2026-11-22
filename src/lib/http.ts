/**
 * The backend of the real app, the transport between the page and the server (SPEC sections 3, 4,
 * 6 and 14):
 *
 * - `POST /api/rpc/<name>` with the JSON input (`{}` when there is none) and the `X-VidAI: 1`
 *   header; the session cookie travels by itself (`credentials: "same-origin"`).
 *   A failed call rejects with an `ApiError` made from the server's `{ code, message }`; when
 *   there is no such body (a proxy's page, a stopped server) it is a `NetworkError` (code `io`,
 *   `isNetworkError`) or an error made from the HTTP status.
 *   No call has a time limit, because the server promises no answer time (a folder on a slow
 *   network drive, a disk measurement): the only exception is `getSession`, which the page waits
 *   on at start and the server answers at once (`QUICK_TIMEOUT_MS`).
 * - The event stream (`sse.ts`) starts when a call shows a signed-in session (`getSession`,
 *   `login` and `setupAdmin` answering a user) and stops at `logout`. A 401 on any other call
 *   means the session is gone: the stream stops, `connection.unauthorized` is set, the page
 *   gets one `session-ended` event with `reason: null` (the store signs out on it) and
 *   `onUnauthenticated` runs, all once per burst of failing calls; signing in again re-arms it.
 * - `GET /api/file` (`fileUrl`) and `PUT /api/upload/<id>` (`upload.ts`).
 */
import type { Api, RpcApi } from "./api";
import { PLAYER_SCRIPT_URL } from "./api";
import { createConnectionStore } from "./connection";
import { NetworkError, errorForStatus, parseWireError } from "./errors";
import { createEventHub } from "./eventHub";
import { PUBLIC_RPC_NAMES, RPC_NAMES, type RpcInput, type RpcName, type RpcOutput } from "./rpc";
import { createEventStream, type EventSourceFactory, type SessionCheck } from "./sse";
import { createUploadClient, type UploadClientOptions } from "./upload";
import { encodeVideoId } from "./videoId";

/** How long `getSession` may take before the page treats the server as unreachable. */
export const QUICK_TIMEOUT_MS = 20_000;

const QUICK_RPC_NAMES: ReadonlySet<string> = new Set<RpcName>(["getSession"]);
const PUBLIC_NAMES: ReadonlySet<string> = new Set<string>(PUBLIC_RPC_NAMES);

/** The URL of a file of the user's video folder (SPEC section 14, `GET /api/file`). */
export function buildFileUrl(
  videoId: string,
  path: string,
  options: { download?: boolean } = {},
  baseUrl = "",
): string {
  // The id contains a slash, which must not become a path separator: it is a query value.
  const query = `video=${encodeVideoId(videoId)}&path=${encodeURIComponent(path)}`;
  return `${baseUrl}/api/file?${query}${options.download ? "&download=1" : ""}`;
}

export interface HttpOptions {
  /** Prefix of every address (empty: the page's own server). */
  baseUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: the `EventSource` to open (default: the browser's). */
  createEventSource?: EventSourceFactory;
  /** For tests: reloads the page (default `window.location.reload()`). */
  reload?: () => void;
  /** For tests: delays of the event stream's reconnects. */
  backoffMs?: readonly number[];
  /** For tests: upload chunk size, retry delays and clock. */
  uploads?: Pick<UploadClientOptions, "chunkBytes" | "retryDelaysMs" | "now">;
  /** Called once when the server says the session is gone (a 401 on a call, or on the stream). */
  onUnauthenticated?: () => void;
}

export interface HttpApi extends Api {
  readonly backend: "http";
  /** Closes the event stream and drops the subscribers (tests; the page never needs it). */
  dispose: () => void;
}

/** The parsed JSON of an answer: `undefined` when the body is not JSON, `null` when empty. */
function parseBody(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function hasUser(output: unknown): boolean {
  return typeof output === "object" && output !== null && "user" in output && output.user !== null;
}

export function createHttpApi(options: HttpOptions = {}): HttpApi {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const connection = createConnectionStore();
  const hub = createEventHub();

  /** A call showed a session (`true`) or its absence (`false`). */
  let signedIn = false;
  /** `onUnauthenticated` has run for this burst of 401s. */
  let notified = false;

  // The server ended the session itself (`session-ended`): later 401s are no news.
  hub.on.sessionEnded(() => {
    signedIn = false;
  });

  /** The session is gone: the stream stops and the page learns it once. */
  function sessionLost() {
    stream.stop();
    connection.update({ unauthorized: true });
    if (notified) return;
    notified = true;
    if (signedIn) {
      signedIn = false;
      hub.emit("session-ended", { reason: null });
    }
    options.onUnauthenticated?.();
  }

  function sessionShown(present: boolean) {
    if (present) {
      signedIn = true;
      notified = false;
      connection.update({ unauthorized: false });
      stream.start();
    } else {
      signedIn = false;
      stream.stop();
    }
  }

  /** One POST. Resolves with the output, rejects with an `ApiError`. */
  async function post<K extends RpcName>(name: K, input: RpcInput<K>): Promise<RpcOutput<K>> {
    const controller = new AbortController();
    const timer = QUICK_RPC_NAMES.has(name)
      ? setTimeout(() => {
          controller.abort();
        }, QUICK_TIMEOUT_MS)
      : null;
    let status: number;
    let text: string;
    try {
      const response = await doFetch(`${baseUrl}/api/rpc/${name}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-VidAI": "1" },
        body: JSON.stringify(input ?? {}),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch {
      throw controller.signal.aborted
        ? new NetworkError("VidAI did not answer in time. Check your connection and try again.")
        : new NetworkError();
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const body = parseBody(text);
    if (status >= 200 && status < 300) {
      // An answer that is no JSON is a proxy's page, not VidAI.
      if (body === undefined) throw new NetworkError();
      return body as RpcOutput<K>;
    }
    const error = parseWireError(body) ?? errorForStatus(status);
    if (error.code === "unauthenticated" && !PUBLIC_NAMES.has(name)) sessionLost();
    throw error;
  }

  async function rpc<K extends RpcName>(name: K, input: RpcInput<K>): Promise<RpcOutput<K>> {
    const output = await post(name, input);
    if (name === "getSession" || name === "login" || name === "setupAdmin") {
      sessionShown(hasUser(output));
    } else if (name === "logout") {
      sessionShown(false);
    }
    return output;
  }

  /** Whether the session is still there; no side effects, errors mean "cannot tell". */
  async function checkSession(): Promise<SessionCheck> {
    try {
      return hasUser(await post("getSession", undefined as never)) ? "signedIn" : "signedOut";
    } catch {
      return "unreachable";
    }
  }

  const stream = createEventStream({
    url: `${baseUrl}/api/events`,
    hub,
    connection,
    createSource: options.createEventSource,
    checkSession,
    onSessionLost: sessionLost,
    reload: options.reload,
    backoffMs: options.backoffMs,
  });

  const uploads = createUploadClient({
    baseUrl,
    fetch: doFetch,
    onUnauthenticated: sessionLost,
    ...options.uploads,
  });

  const methods = Object.fromEntries(
    RPC_NAMES.map((name) => [name, (input?: unknown) => rpc(name, input as never)]),
  ) as unknown as RpcApi;

  return {
    ...methods,
    backend: "http",
    connection,
    fileUrl: (videoId, path, fileOptions) => buildFileUrl(videoId, path, fileOptions, baseUrl),
    playerScriptUrl: PLAYER_SCRIPT_URL,
    uploads,
    on: hub.on,
    dispose() {
      stream.stop();
      hub.clear();
    },
  };
}

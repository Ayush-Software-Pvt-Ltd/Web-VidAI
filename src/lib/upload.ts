/**
 * The upload client (SPEC section 6, "Uploads"): `PUT /api/upload/<id>?offset=<n>` with a raw body
 * of at most `ticket.maxChunkBytes`, `GET /api/upload/<id>` for how far the server got.
 *
 * - `send` always asks the server first, so Resume is `send` again with the same ticket and file.
 *   Pause is aborting the signal: the transfer stops with an `AbortError` and the server keeps
 *   what it received.
 * - The file is cut with `Blob.slice`, so it is never read into memory as a whole. Chunks are at
 *   most `min(ticket.maxChunkBytes, chunkBytes)`; `fetch` reports no progress inside a request,
 *   so the default of 8 MiB keeps the progress bar moving on a slow link.
 * - A `PUT` at a wrong offset answers `conflict` with `X-Upload-Received`: the client continues
 *   from there. It does that once in a row (a second wrong offset without progress in between is
 *   an error), so two writers can never fight forever.
 * - A failed chunk (no network, a proxy page, `io`, `internal`, `rateLimited`, or a `conflict`
 *   while the server still handles an earlier, aborted request) is retried with growing delays;
 *   after the last retry the error is thrown. `tooLarge`, `notFound` (the upload was cancelled or
 *   expired), `forbidden`, `invalidInput` and a 401 end the transfer at once. A `conflict` the
 *   server does not explain with a position is checked with `GET`: gone ends it, done finishes it.
 * - `onProgress(received, bytesPerSecond)`: bytes the server has, and a smoothed speed (an
 *   exponential average over the chunks of this call, 0 before the first chunk finished).
 */
import type { Uploads, UploadOptions } from "./api";
import { ApiError, NetworkError, errorForStatus, isAbortError, parseWireError } from "./errors";
import type { UploadProgress, UploadState, UploadTicket } from "./types";

/** Default size of one request, below the server's 32 MB limit. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Waits in milliseconds before the 1st, 2nd, ... retry of a failed request. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];

/** The weight of the newest chunk in the smoothed speed. */
const SPEED_WEIGHT = 0.3;

export interface UploadProgressHandler {
  (received: number, bytesPerSecond: number): void;
}

export interface UploadSendOptions extends Omit<UploadOptions, "onProgress"> {
  onProgress?: UploadProgressHandler;
}

export interface UploadClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Largest chunk (further limited by the ticket). */
  chunkBytes?: number;
  retryDelaysMs?: readonly number[];
  /** Called on a 401: the session is gone. */
  onUnauthenticated?: () => void;
  /** For tests: a clock in milliseconds. */
  now?: () => number;
}

export interface UploadClient extends Uploads {
  send(ticket: UploadTicket, file: Blob, options?: UploadSendOptions): Promise<void>;
}

/** What one request came to. */
type Outcome =
  | { kind: "ok"; body: unknown }
  | {
      kind: "failed";
      status: number;
      error: ApiError;
      /** `X-Upload-Received`: where the server says the upload is. */
      received: number | null;
      /** No answer from VidAI itself. */
      network: boolean;
    };

function abortError(): DOMException {
  return new DOMException("The upload was paused.", "AbortError");
}

export function createUploadClient(options: UploadClientOptions = {}): UploadClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const chunkLimit = Math.max(1, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const now = options.now ?? (() => Date.now());

  function urlOf(id: string): string {
    return `${baseUrl}/api/upload/${encodeURIComponent(id)}`;
  }

  async function call(url: string, init: RequestInit, signal?: AbortSignal): Promise<Outcome> {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, credentials: "same-origin", signal });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (isAbortError(error)) throw abortError();
      return {
        kind: "failed",
        status: 0,
        error: new NetworkError(),
        received: null,
        network: true,
      };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (signal?.aborted) throw abortError();
      return {
        kind: "failed",
        status: 0,
        error: new NetworkError(),
        received: null,
        network: true,
      };
    }
    let body: unknown;
    try {
      body = text.trim() === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }
    if (response.ok && body !== undefined) return { kind: "ok", body };
    const error = parseWireError(body) ?? errorForStatus(response.status);
    const header = response.headers.get("X-Upload-Received");
    const received = header !== null && /^\d{1,16}$/.test(header) ? Number(header) : null;
    return {
      kind: "failed",
      status: response.status,
      error,
      received,
      network: false,
    };
  }

  function retryable(outcome: Extract<Outcome, { kind: "failed" }>): boolean {
    if (outcome.network || outcome.status >= 500) return true;
    return ["io", "internal", "rateLimited"].includes(outcome.error.code);
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function fail(outcome: Extract<Outcome, { kind: "failed" }>): never {
    if (outcome.status === 401) options.onUnauthenticated?.();
    throw outcome.error;
  }

  async function readState(id: string, signal?: AbortSignal): Promise<UploadState> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await call(urlOf(id), { method: "GET" }, signal);
      if (outcome.kind === "ok") return outcome.body as UploadState;
      if (!retryable(outcome) || attempt >= delays.length) fail(outcome);
      await sleep(delays[attempt] ?? 0, signal);
    }
  }

  async function send(
    ticket: UploadTicket,
    file: Blob,
    sendOptions: UploadSendOptions = {},
  ): Promise<void> {
    const { signal, onProgress } = sendOptions;
    if (signal?.aborted) throw abortError();
    if (file.size !== ticket.size) {
      throw new ApiError("invalidInput", "This is not the file the upload was made for.");
    }
    const size = ticket.size;
    const chunkBytes = Math.max(1, Math.min(ticket.maxChunkBytes, chunkLimit));

    let speed = 0;
    const report = (received: number) => {
      onProgress?.(Math.min(received, size), speed);
    };

    const state = await readState(ticket.id, signal);
    if (state.done) {
      report(size);
      return;
    }
    let offset = Math.min(Math.max(0, state.received), size);
    report(offset);

    let attempts = 0;
    let resynced = false;
    // The loop ends by `return` (the server says done) or by a thrown error.
    for (;;) {
      if (signal?.aborted) throw abortError();
      const end = Math.min(offset + chunkBytes, size);
      // At the end an empty request asks the server to finish the file (SPEC section 6).
      const chunk = file.slice(offset, end);
      const started = now();
      const outcome = await call(
        `${urlOf(ticket.id)}?offset=${offset}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", "X-VidAI": "1" },
          body: chunk,
        },
        signal,
      );

      if (outcome.kind === "ok") {
        const progress = outcome.body as UploadProgress;
        const advanced = progress.received - offset;
        if (advanced > 0) {
          const elapsed = Math.max(1, now() - started);
          const sample = (Math.min(advanced, end - offset) * 1000) / elapsed;
          speed = speed === 0 ? sample : speed * (1 - SPEED_WEIGHT) + sample * SPEED_WEIGHT;
        }
        if (progress.done) {
          report(size);
          return;
        }
        if (advanced > 0) {
          offset = Math.min(progress.received, size);
          attempts = 0;
          resynced = false;
          report(offset);
          continue;
        }
        // The server took nothing: treat it like a failed attempt, so this cannot spin.
        if (attempts >= delays.length) {
          throw new ApiError("io", "The server did not accept any data. Try again later.");
        }
        await sleep(delays[attempts] ?? 0, signal);
        attempts += 1;
        continue;
      }

      if (outcome.status === 401) fail(outcome);

      if (outcome.status === 409 && outcome.received !== null) {
        if (resynced || outcome.received > size) throw outcome.error;
        resynced = true;
        offset = outcome.received;
        report(offset);
        continue;
      }

      if (outcome.error.code === "conflict") {
        // Either the server still handles an earlier request of this upload, or the upload was
        // cancelled or its name taken: the state tells which.
        const current = await readState(ticket.id, signal);
        if (current.done) {
          report(size);
          return;
        }
      } else if (!retryable(outcome)) {
        throw outcome.error;
      }
      if (attempts >= delays.length) throw outcome.error;
      await sleep(delays[attempts] ?? 0, signal);
      attempts += 1;
    }
  }

  return {
    send,
    async state(id) {
      return readState(id);
    },
  };
}

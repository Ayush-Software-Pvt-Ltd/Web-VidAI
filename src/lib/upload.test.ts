import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isAbortError, isApiError, isNetworkError } from "./errors";
import type { UploadTicket } from "./types";
import { createUploadClient, DEFAULT_CHUNK_BYTES } from "./upload";

interface Put {
  offset: number;
  size: number;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  isBlob: boolean;
}

/** What a scripted fault does to the next `PUT`. */
type Fault = "network" | "html" | Response | ((put: Put) => Response | "network");

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function wireError(status: number, code: string, message: string, headers = {}): Response {
  return json(status, { code, message }, headers);
}

/** A hand-written upload endpoint of the server (SPEC section 6) behind a fake `fetch`. */
class FakeServer {
  received = 0;
  done = false;
  /** The upload is gone (cancelled or expired). */
  gone = false;
  puts: Put[] = [];
  gets = 0;
  /** Consumed in order, one per `PUT`. */
  faults: Fault[] = [];
  /** Consumed in order, one per `GET`. */
  stateFaults: Response[] = [];
  /** Waits for the signal to abort instead of answering the next `PUT`. */
  hangNext = false;
  /** Shown to the client by `GET` instead of the truth (a stale answer). */
  staleReceived: number | null = null;
  clock = 0;
  /** Milliseconds each `PUT` takes on the fake clock. */
  putMs = 1000;

  constructor(readonly size: number) {}

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(requestUrl(input), "https://vidai.test");
    expect(url.pathname).toBe("/api/upload/abc123");
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if ((init?.method ?? "GET") === "GET") return this.get();
    return this.put(url, init, signal);
  });

  private get(): Response {
    this.gets += 1;
    const fault = this.stateFaults.shift();
    if (fault) return fault;
    if (this.gone) return wireError(404, "notFound", "That upload was not found.");
    return json(200, {
      received: this.staleReceived ?? this.received,
      size: this.size,
      done: this.done,
    });
  }

  private async put(url: URL, init: RequestInit | undefined, signal?: AbortSignal) {
    const body = init?.body;
    const put: Put = {
      offset: Number(url.searchParams.get("offset")),
      size: body instanceof Blob ? body.size : -1,
      headers: { ...(init?.headers as Record<string, string>) },
      credentials: init?.credentials,
      isBlob: body instanceof Blob,
    };
    this.puts.push(put);
    this.clock += this.putMs;
    if (this.hangNext) {
      this.hangNext = false;
      // Half of the chunk arrives before the pause; the server keeps it.
      this.received = put.offset + Math.floor(put.size / 2);
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const fault = this.faults.shift();
    if (fault !== undefined) {
      const effect = typeof fault === "function" ? fault(put) : fault;
      if (effect === "network") throw new TypeError("Failed to fetch");
      if (effect === "html") return new Response("<html>Bad gateway</html>", { status: 502 });
      return effect;
    }
    if (this.gone) return wireError(404, "notFound", "That upload was not found.");
    if (put.offset !== this.received && !(this.done && put.offset === this.size)) {
      return wireError(409, "conflict", "Wrong offset.", {
        "X-Upload-Received": String(this.received),
      });
    }
    this.received += put.size;
    if (this.received === this.size) this.done = true;
    return json(200, { received: this.received, done: this.done });
  }
}

function ticket(size: number, maxChunkBytes: number): UploadTicket {
  return { id: "abc123", name: "clip.mp4", size, maxChunkBytes };
}

function file(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

function client(server: FakeServer, extra: Parameters<typeof createUploadClient>[0] = {}) {
  return createUploadClient({
    fetch: server.fetch as unknown as typeof fetch,
    retryDelaysMs: [1, 1, 1],
    now: () => server.clock,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a fresh upload", () => {
  it("asks the server first, then sends the file in chunks no larger than the ticket allows", async () => {
    const server = new FakeServer(20);
    await client(server).send(ticket(20, 8), file(20));
    expect(server.gets).toBe(1);
    expect(server.puts.map((put) => [put.offset, put.size])).toEqual([
      [0, 8],
      [8, 8],
      [16, 4],
    ]);
    expect(server.done).toBe(true);
    for (const put of server.puts) {
      expect(put.isBlob).toBe(true);
      expect(put.headers["X-VidAI"]).toBe("1");
      expect(put.headers["Content-Type"]).toBe("application/octet-stream");
      expect(put.credentials).toBe("same-origin");
    }
  });

  it("uses the smaller of the ticket's limit and its own chunk size", async () => {
    const a = new FakeServer(20);
    await client(a, { chunkBytes: 5 }).send(ticket(20, 8), file(20));
    expect(a.puts.map((put) => put.size)).toEqual([5, 5, 5, 5]);
    const b = new FakeServer(20);
    await client(b, { chunkBytes: 100 }).send(ticket(20, 8), file(20));
    expect(b.puts.map((put) => put.size)).toEqual([8, 8, 4]);
  });

  it("cuts a large file in 8 MiB pieces by default, never above the server's 32 MB", async () => {
    const size = 17 * 1024 * 1024;
    const server = new FakeServer(size);
    await client(server).send(ticket(size, 32 * 1024 * 1024), file(size));
    expect(DEFAULT_CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(server.puts.map((put) => put.size)).toEqual([
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      1024 * 1024,
    ]);
  });

  it("reports the bytes the server has and a smoothed speed", async () => {
    const server = new FakeServer(24);
    const progress: Array<[number, number]> = [];
    await client(server).send(ticket(24, 8), file(24), {
      onProgress: (received, speed) => progress.push([received, speed]),
    });
    // 8 bytes per second on every chunk: the speed is 0 before the first chunk, then 8.
    expect(progress).toEqual([
      [0, 0],
      [8, 8],
      [16, 8],
      [24, 8],
    ]);
  });

  it("smooths a changing speed instead of jumping to the last sample", async () => {
    const server = new FakeServer(16);
    const speeds: number[] = [];
    await client(server).send(ticket(16, 8), file(16), {
      onProgress: (received, speed) => {
        speeds.push(speed);
        // The first chunk took 1 s (8 B/s); the second takes 0.25 s (32 B/s).
        if (received === 8) server.putMs = 250;
      },
    });
    expect(speeds[1]).toBe(8);
    expect(speeds[2]).toBeCloseTo(0.7 * 8 + 0.3 * 32, 5);
  });

  it("refuses a file that is not the one of the ticket before sending anything", async () => {
    const server = new FakeServer(20);
    await expect(client(server).send(ticket(20, 8), file(19))).rejects.toMatchObject({
      code: "invalidInput",
    });
    expect(server.fetch).not.toHaveBeenCalled();
  });
});

describe("a resumed upload", () => {
  it("continues from the offset the server has", async () => {
    const server = new FakeServer(20);
    server.received = 8;
    const progress: number[] = [];
    await client(server).send(ticket(20, 8), file(20), { onProgress: (r) => progress.push(r) });
    expect(server.puts.map((put) => put.offset)).toEqual([8, 16]);
    expect(progress[0]).toBe(8);
    expect(progress.at(-1)).toBe(20);
  });

  it("sends nothing when the file is already complete", async () => {
    const server = new FakeServer(20);
    server.received = 20;
    server.done = true;
    const progress: number[] = [];
    await client(server).send(ticket(20, 8), file(20), { onProgress: (r) => progress.push(r) });
    expect(server.puts).toEqual([]);
    expect(progress).toEqual([20]);
  });

  it("asks the server to finish when all bytes are there but the file is not named yet", async () => {
    const server = new FakeServer(20);
    server.received = 20;
    await client(server).send(ticket(20, 8), file(20));
    expect(server.puts.map((put) => [put.offset, put.size])).toEqual([[20, 0]]);
    expect(server.done).toBe(true);
  });
});

describe("pause by abort", () => {
  it("rejects with an AbortError and leaves the upload resumable", async () => {
    const server = new FakeServer(20);
    const controller = new AbortController();
    server.hangNext = true;
    const sending = client(server).send(ticket(20, 8), file(20), { signal: controller.signal });
    await vi.waitFor(() => {
      expect(server.puts).toHaveLength(1);
    });
    controller.abort();
    const error = await sending.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    // The server kept the 4 bytes that arrived; sending again with the same ticket continues there.
    expect(server.received).toBe(4);
    await client(server).send(ticket(20, 8), file(20));
    expect(server.puts.map((put) => put.offset)).toEqual([0, 4, 12]);
    expect(server.done).toBe(true);
  });

  it("does not start when the signal is already aborted", async () => {
    const server = new FakeServer(20);
    const controller = new AbortController();
    controller.abort();
    const error = await client(server)
      .send(ticket(20, 8), file(20), { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("stops between two chunks", async () => {
    const server = new FakeServer(20);
    const controller = new AbortController();
    const error = await client(server)
      .send(ticket(20, 8), file(20), {
        signal: controller.signal,
        onProgress: (received) => {
          if (received === 8) controller.abort();
        },
      })
      .catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(server.puts).toHaveLength(1);
    expect(server.received).toBe(8);
  });

  it("stops while waiting to retry", async () => {
    vi.useFakeTimers();
    const server = new FakeServer(20);
    const controller = new AbortController();
    server.faults = ["network"];
    const sending = client(server, { retryDelaysMs: [10_000] })
      .send(ticket(20, 8), file(20), { signal: controller.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(isAbortError(await sending)).toBe(true);
    expect(server.puts).toHaveLength(1);
  });
});

describe("a wrong offset", () => {
  it("continues from the offset the server names", async () => {
    const server = new FakeServer(24);
    server.received = 8;
    // The answer of the first GET was stale: the client thinks the upload is at 0.
    server.staleReceived = 0;
    await client(server).send(ticket(24, 8), file(24));
    expect(server.puts.map((put) => put.offset)).toEqual([0, 8, 16]);
    expect(server.done).toBe(true);
  });

  it("gives up when it happens twice in a row", async () => {
    const server = new FakeServer(24);
    server.received = 8;
    server.staleReceived = 0;
    // The server keeps naming another place than the one it accepts.
    const lie = (): Response =>
      wireError(409, "conflict", "Wrong offset.", { "X-Upload-Received": "4" });
    server.faults = [lie, lie];
    const error = await client(server)
      .send(ticket(24, 8), file(24))
      .catch((e: unknown) => e);
    expect(isApiError(error, "conflict")).toBe(true);
    expect(server.puts).toHaveLength(2);
  });

  it("allows a new resync after a chunk went through", async () => {
    const server = new FakeServer(24);
    const lateJoiner = (): Response => {
      // Another request got 4 bytes in first.
      server.received = 4;
      return wireError(409, "conflict", "Wrong offset.", { "X-Upload-Received": "4" });
    };
    server.faults = [
      (put) => (put.offset === 0 ? lateJoiner() : "network"),
      () => json(200, { received: 12, done: false }),
    ];
    await client(server).send(ticket(24, 8), file(24));
    expect(server.puts[1]?.offset).toBe(4);
    expect(server.done).toBe(true);
  });
});

describe("failures", () => {
  it("retries a failed chunk and finishes when the server recovers", async () => {
    const server = new FakeServer(20);
    server.faults = ["network", "html"];
    await client(server).send(ticket(20, 8), file(20));
    expect(server.puts.map((put) => put.offset)).toEqual([0, 0, 0, 8, 16]);
    expect(server.done).toBe(true);
  });

  it("retries an io error and a rate limit", async () => {
    const server = new FakeServer(8);
    server.faults = [
      wireError(400, "io", "The server cannot write the uploaded file."),
      wireError(429, "rateLimited", "Slow down."),
    ];
    await client(server).send(ticket(8, 8), file(8));
    expect(server.puts).toHaveLength(3);
  });

  it("returns the error after a few retries", async () => {
    const server = new FakeServer(20);
    server.faults = ["network", "network", "network", "network", "network"];
    const error = await client(server)
      .send(ticket(20, 8), file(20))
      .catch((e: unknown) => e);
    expect(isNetworkError(error)).toBe(true);
    // The first try and three retries.
    expect(server.puts).toHaveLength(4);
  });

  it("waits longer before each retry", async () => {
    vi.useFakeTimers();
    const server = new FakeServer(8);
    server.faults = ["network", "network", "network", "network"];
    const sending = client(server, { retryDelaysMs: [500, 1500, 4000] })
      .send(ticket(8, 8), file(8))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(server.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.puts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(server.puts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.puts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(server.puts).toHaveLength(4);
    expect(isNetworkError(await sending)).toBe(true);
  });

  it("ends at once on tooLarge", async () => {
    const server = new FakeServer(20);
    server.faults = [wireError(413, "tooLarge", "That is more than one request may carry.")];
    const error = await client(server)
      .send(ticket(20, 8), file(20))
      .catch((e: unknown) => e);
    expect(isApiError(error, "tooLarge")).toBe(true);
    expect(server.puts).toHaveLength(1);
  });

  it.each([
    [400, "invalidInput"],
    [403, "forbidden"],
    [404, "notFound"],
  ])("ends at once on %i %s", async (status, code) => {
    const server = new FakeServer(20);
    server.faults = [wireError(status, code, "No.")];
    const error = await client(server)
      .send(ticket(20, 8), file(20))
      .catch((e: unknown) => e);
    expect(isApiError(error, code as "notFound")).toBe(true);
    expect(server.puts).toHaveLength(1);
  });

  it("ends at once when the ticket was cancelled before the first request", async () => {
    const server = new FakeServer(20);
    server.gone = true;
    const error = await client(server)
      .send(ticket(20, 8), file(20))
      .catch((e: unknown) => e);
    expect(isApiError(error, "notFound")).toBe(true);
    expect(server.puts).toHaveLength(0);
    // Not even retried.
    expect(server.gets).toBe(1);
  });

  it("ends at once when the ticket is cancelled while sending", async () => {
    const server = new FakeServer(20);
    server.faults = [
      () => {
        server.gone = true;
        return wireError(409, "conflict", "This upload was cancelled.");
      },
    ];
    const error = await client(server)
      .send(ticket(20, 8), file(20))
      .catch((e: unknown) => e);
    expect(isApiError(error, "notFound")).toBe(true);
    expect(server.puts).toHaveLength(1);
  });

  it("waits and retries when the server still handles an earlier request of the upload", async () => {
    const server = new FakeServer(20);
    const busy = (): Response =>
      wireError(409, "conflict", "This upload is already receiving data from another request.");
    server.faults = [busy, busy];
    await client(server).send(ticket(20, 8), file(20));
    expect(server.puts.map((put) => put.offset)).toEqual([0, 0, 0, 8, 16]);
    expect(server.done).toBe(true);
  });

  it("returns the conflict when it never clears", async () => {
    const server = new FakeServer(8);
    const busy = (): Response => wireError(409, "conflict", "Busy.");
    server.faults = [busy, busy, busy, busy, busy];
    const error = await client(server)
      .send(ticket(8, 8), file(8))
      .catch((e: unknown) => e);
    expect(isApiError(error, "conflict")).toBe(true);
    expect(server.puts).toHaveLength(4);
  });

  it("finishes when the server reports the file done after a conflict", async () => {
    const server = new FakeServer(8);
    server.faults = [
      () => {
        server.received = 8;
        server.done = true;
        return wireError(409, "conflict", "The file is complete.");
      },
    ];
    const progress: number[] = [];
    await client(server).send(ticket(8, 8), file(8), { onProgress: (r) => progress.push(r) });
    expect(server.puts).toHaveLength(1);
    expect(progress.at(-1)).toBe(8);
  });

  it("does not spin when the server accepts nothing", async () => {
    const server = new FakeServer(8);
    const nothing = (): Response => json(200, { received: 0, done: false });
    server.faults = [nothing, nothing, nothing, nothing, nothing, nothing];
    const error = await client(server)
      .send(ticket(8, 8), file(8))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(server.puts.length).toBeLessThanOrEqual(5);
  });

  it("retries the first question when the network is down", async () => {
    const server = new FakeServer(8);
    server.stateFaults = [new Response("<html>502</html>", { status: 502 })];
    await client(server).send(ticket(8, 8), file(8));
    expect(server.gets).toBe(2);
    expect(server.done).toBe(true);
  });

  it("tells the session is gone on a 401 and does not retry", async () => {
    const server = new FakeServer(20);
    const onUnauthenticated = vi.fn();
    server.faults = [wireError(401, "unauthenticated", "Sign in to continue.")];
    const error = await client(server, { onUnauthenticated })
      .send(ticket(20, 8), file(20))
      .catch((e: unknown) => e);
    expect(isApiError(error, "unauthenticated")).toBe(true);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(server.puts).toHaveLength(1);
  });
});

describe("state", () => {
  it("reads how far an upload got", async () => {
    const server = new FakeServer(20);
    server.received = 12;
    expect(await client(server).state("abc123")).toEqual({ received: 12, size: 20, done: false });
  });

  it("rejects with the server's error", async () => {
    const server = new FakeServer(20);
    server.gone = true;
    await expect(client(server).state("abc123")).rejects.toMatchObject({ code: "notFound" });
  });
});

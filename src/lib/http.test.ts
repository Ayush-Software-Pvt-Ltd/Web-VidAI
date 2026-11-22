import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpOptions } from "./http";
import { buildFileUrl, createHttpApi, QUICK_TIMEOUT_MS } from "./http";
import { ApiError, isApiError, isNetworkError } from "./errors";
import type { EventSourceLike } from "./sse";
import type { SessionInfo, UploadTicket } from "./types";

class FakeSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(readonly url: string) {}

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(event: string, payload: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ event, payload }) }));
  }

  fail(gaveUp = false) {
    this.readyState = gaveUp ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

const USER = { id: "u1", email: "admin@example.com", role: "admin", mayMarkUrgent: true } as const;
const SIGNED_IN: SessionInfo = { user: USER, needsSetup: false, serverVersion: "1.0.0" };
const SIGNED_OUT: SessionInfo = { user: null, needsSetup: false, serverVersion: "1.0.0" };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

type Handler = (call: Call) => Response | Promise<Response>;

interface Setup {
  api: ReturnType<typeof createHttpApi>;
  calls: Call[];
  sources: FakeSource[];
  handler: { current: Handler };
  onUnauthenticated: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
}

const apis: Array<{ dispose: () => void }> = [];

function setup(options: HttpOptions = {}): Setup {
  const calls: Call[] = [];
  const sources: FakeSource[] = [];
  const handler: { current: Handler } = { current: () => json(200, null) };
  const onUnauthenticated = vi.fn();
  const reload = vi.fn();
  const api = createHttpApi({
    fetch: (input, init) => {
      const call = { url: requestUrl(input), init: init ?? {} };
      calls.push(call);
      if (call.init.signal?.aborted) return Promise.reject(new DOMException("a", "AbortError"));
      return Promise.resolve(handler.current(call));
    },
    createEventSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    onUnauthenticated,
    reload,
    ...options,
  });
  apis.push(api);
  return { api, calls, sources, handler, onUnauthenticated, reload };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const api of apis.splice(0)) api.dispose();
  vi.useRealTimers();
});

/** Routes by RPC name. */
function byName(answers: Record<string, () => Response>): Handler {
  return ({ url }) => {
    const name = url.split("/api/rpc/")[1] ?? "";
    const answer = answers[name];
    return answer ? answer() : json(200, null);
  };
}

describe("rpc calls", () => {
  it("posts JSON with the VidAI header and the cookie, and returns the output", async () => {
    const t = setup();
    t.handler.current = () => json(200, { id: "c1" });
    const out = await t.api.adminDeleteUser({ id: "c1" });
    expect(out).toEqual({ id: "c1" });
    const call = t.calls[0];
    expect(call?.url).toBe("/api/rpc/adminDeleteUser");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("same-origin");
    expect(call?.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-VidAI": "1",
    });
    expect(call?.init.body).toBe('{"id":"c1"}');
  });

  it("posts an empty object when there is no input", async () => {
    const t = setup();
    t.handler.current = () => json(200, []);
    await t.api.getQueue();
    expect(t.calls[0]?.init.body).toBe("{}");
  });

  it("uses the base url", async () => {
    const t = setup({ baseUrl: "https://vidai.test" });
    await t.api.getQueue();
    expect(t.calls[0]?.url).toBe("https://vidai.test/api/rpc/getQueue");
  });

  it("returns null for a null answer and for an empty body", async () => {
    const t = setup();
    t.handler.current = () => json(200, null);
    expect(await t.api.getQueue()).toBeNull();
    t.handler.current = () => new Response("", { status: 200 });
    expect(await t.api.getQueue()).toBeNull();
  });

  it.each([
    [400, "invalidInput"],
    [400, "notReady"],
    [400, "io"],
    [400, "internal"],
    [403, "forbidden"],
    [404, "notFound"],
    [409, "conflict"],
    [413, "tooLarge"],
    [429, "rateLimited"],
  ])("rejects with the server's error for %i %s", async (status, code) => {
    const t = setup();
    t.handler.current = () => json(status, { code, message: `A sentence about ${code}.` });
    const error = await t.api.getQueue().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code, message: `A sentence about ${code}.` });
    expect(isNetworkError(error)).toBe(false);
    expect(t.onUnauthenticated).not.toHaveBeenCalled();
  });

  it("builds an error from the status when the answer has no usable body", async () => {
    const t = setup();
    const cases: Array<[Response, string]> = [
      [new Response("<html>Not found</html>", { status: 404 }), "notFound"],
      [new Response("", { status: 403 }), "forbidden"],
      [new Response("x", { status: 413 }), "tooLarge"],
      [json(409, { nonsense: true }), "conflict"],
      [json(400, { code: "aliens", message: "No." }), "internal"],
      [new Response("x", { status: 418 }), "internal"],
    ];
    for (const [response, code] of cases) {
      t.handler.current = () => response.clone();
      const error = await t.api.getQueue().catch((e: unknown) => e);
      expect(isApiError(error, code as "internal")).toBe(true);
      expect(isNetworkError(error)).toBe(false);
      expect((error as ApiError).message).not.toBe("");
    }
  });

  it("treats a proxy's error page as not reachable", async () => {
    const t = setup();
    for (const status of [500, 502, 503, 504]) {
      t.handler.current = () => new Response("<html>Bad gateway</html>", { status });
      const error = await t.api.getQueue().catch((e: unknown) => e);
      expect(isNetworkError(error)).toBe(true);
      expect(error).toMatchObject({ code: "io" });
    }
  });

  it("treats a success that is not JSON as not reachable", async () => {
    const t = setup();
    t.handler.current = () => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200 });
    const error = await t.api.getQueue().catch((e: unknown) => e);
    expect(isNetworkError(error)).toBe(true);
  });

  it("turns a network failure into a plain NetworkError", async () => {
    const t = setup({
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const error = await t.api.getQueue().catch((e: unknown) => e);
    expect(isNetworkError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "io",
      message: "VidAI could not be reached. Check your connection and try again.",
    });
  });

  it("gives up on getSession after a while, but never on other calls", async () => {
    vi.useFakeTimers();
    const hung: Array<() => void> = [];
    const t = setup({
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          hung.push(() => {});
        }),
    });
    const session = t.api.getSession().catch((e: unknown) => e);
    const library = vi.fn();
    void t.api.getQueue().then(library, library);
    await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS - 1);
    expect(hung).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const error = await session;
    expect(isNetworkError(error)).toBe(true);
    expect((error as ApiError).message).toMatch(/did not answer in time/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(library).not.toHaveBeenCalled();
  });
});

describe("401", () => {
  it("tells the session is gone once for a burst of calls, ends the page's session, sets unauthorized", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    t.sources[0]?.open();
    const ended = vi.fn();
    t.api.on.sessionEnded(ended);
    t.handler.current = () => json(401, { code: "unauthenticated", message: "Sign in." });
    const results = await Promise.allSettled([
      t.api.getQueue(),
      t.api.getQueue(),
      t.api.getQueue(),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "unauthenticated" });
    }
    expect(t.onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ reason: null });
    expect(t.api.connection.getSnapshot().unauthorized).toBe(true);
    expect(t.sources[0]?.closed).toBe(true);
  });

  it("arms the hook again after the next sign-in", async () => {
    const t = setup();
    t.handler.current = byName({ login: () => json(200, SIGNED_IN) });
    const unauthenticated = () => json(401, { code: "unauthenticated", message: "Sign in." });
    await t.api.login({ email: "admin@example.com", password: "secret" });
    t.handler.current = unauthenticated;
    await t.api.getQueue().catch(() => {});
    expect(t.onUnauthenticated).toHaveBeenCalledTimes(1);
    t.handler.current = byName({ login: () => json(200, SIGNED_IN) });
    await t.api.login({ email: "admin@example.com", password: "secret" });
    expect(t.api.connection.getSnapshot().unauthorized).toBe(false);
    t.handler.current = unauthenticated;
    await t.api.getQueue().catch(() => {});
    expect(t.onUnauthenticated).toHaveBeenCalledTimes(2);
  });

  it("does not announce a session end when no session was known", async () => {
    const t = setup();
    const ended = vi.fn();
    t.api.on.sessionEnded(ended);
    t.handler.current = () => json(401, { code: "unauthenticated", message: "Sign in." });
    await t.api.getQueue().catch(() => {});
    expect(t.onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
  });

  it("does not treat a refused sign-in as a lost session", async () => {
    const t = setup();
    t.handler.current = () => json(401, { code: "unauthenticated", message: "Wrong." });
    await expect(t.api.login({ email: "a@example.com", password: "x" })).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(t.onUnauthenticated).not.toHaveBeenCalled();
    expect(t.api.connection.getSnapshot().unauthorized).toBe(false);
  });
});

describe("the event stream follows the session", () => {
  it("does nothing before sign-in", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_OUT) });
    await t.api.getSession();
    expect(t.sources).toHaveLength(0);
  });

  it("opens one stream when getSession shows a user, and not again for later answers", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    await t.api.getSession();
    expect(t.sources).toHaveLength(1);
    expect(t.sources[0]?.url).toBe("/api/events");
  });

  it("opens it after login and after setupAdmin", async () => {
    const t = setup();
    t.handler.current = byName({ login: () => json(200, SIGNED_IN) });
    await t.api.login({ email: "admin@example.com", password: "secret" });
    expect(t.sources).toHaveLength(1);
    const u = setup();
    u.handler.current = byName({ setupAdmin: () => json(200, SIGNED_IN) });
    await u.api.setupAdmin({ token: "t", email: "admin@example.com", password: "secret" });
    expect(u.sources).toHaveLength(1);
  });

  it("does not open it when login fails", async () => {
    const t = setup();
    t.handler.current = () => json(400, { code: "invalidInput", message: "Wrong." });
    await t.api.login({ email: "a@example.com", password: "x" }).catch(() => {});
    expect(t.sources).toHaveLength(0);
  });

  it("closes it at logout, and a getSession without user closes it too", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    t.handler.current = byName({ logout: () => json(200, null) });
    await t.api.logout();
    expect(t.sources[0]?.closed).toBe(true);
    expect(t.api.connection.getSnapshot().status).toBe("connecting");

    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    expect(t.sources).toHaveLength(2);
    t.handler.current = byName({ getSession: () => json(200, SIGNED_OUT) });
    await t.api.getSession();
    expect(t.sources[1]?.closed).toBe(true);
  });

  it("keeps the stream when logout fails", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    t.handler.current = () => json(500, { code: "internal", message: "Oops." });
    await t.api.logout().catch(() => {});
    expect(t.sources[0]?.closed).toBe(false);
  });

  it("delivers the stream's events through api.on and shows connected", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    const queue = vi.fn();
    t.api.on.queueChanged(queue);
    const source = t.sources[0] as FakeSource;
    source.open();
    source.message("hello", { instanceId: "a" });
    source.message("queue-changed", { queue: "edits" });
    expect(queue).toHaveBeenCalledWith({ queue: "edits" });
    expect(t.api.connection.getSnapshot()).toEqual({
      status: "connected",
      unauthorized: false,
      instance: "a",
    });
  });

  it("reloads once when the server's instance changes", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    const source = t.sources[0] as FakeSource;
    source.message("hello", { instanceId: "a" });
    source.message("hello", { instanceId: "b" });
    source.message("hello", { instanceId: "c" });
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("checks the session over RPC when the browser gave up, and signs out when it is gone", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    const ended = vi.fn();
    t.api.on.sessionEnded(ended);
    (t.sources[0] as FakeSource).open();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_OUT) });
    (t.sources[0] as FakeSource).fail(true);
    await vi.waitFor(() => {
      expect(ended).toHaveBeenCalledWith({ reason: null });
    });
    expect(t.onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(t.api.connection.getSnapshot().unauthorized).toBe(true);
    expect(t.sources).toHaveLength(1);
  });

  it("reconnects when the server is only briefly away", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    (t.sources[0] as FakeSource).open();
    (t.sources[0] as FakeSource).fail();
    expect(t.api.connection.getSnapshot().status).toBe("lost");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources).toHaveLength(2);
    (t.sources[1] as FakeSource).open();
    expect(t.api.connection.getSnapshot().status).toBe("connected");
  });

  it("dispose closes the stream", async () => {
    const t = setup();
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    t.api.dispose();
    expect(t.sources[0]?.closed).toBe(true);
  });
});

describe("fileUrl", () => {
  it("encodes a video id with a slash as one query value", () => {
    const t = setup();
    expect(t.api.fileUrl("ch1/My Video", "output/final.mp4")).toBe(
      "/api/file?video=ch1%2FMy%20Video&path=output%2Ffinal.mp4",
    );
  });

  it("encodes characters that would end a query value", () => {
    expect(buildFileUrl("c/a&b#c?d=e", "x y/é.png")).toBe(
      "/api/file?video=c%2Fa%26b%23c%3Fd%3De&path=x%20y%2F%C3%A9.png",
    );
    const url = new URL(buildFileUrl("c/a&b#c?d=e", "x y/é.png"), "https://vidai.test");
    expect(url.searchParams.get("video")).toBe("c/a&b#c?d=e");
    expect(url.searchParams.get("path")).toBe("x y/é.png");
  });

  it("adds download=1 only when asked, and the base url", () => {
    const t = setup({ baseUrl: "https://vidai.test" });
    expect(t.api.fileUrl("c/v", "a.mp4", { download: true })).toBe(
      "https://vidai.test/api/file?video=c%2Fv&path=a.mp4&download=1",
    );
    expect(t.api.fileUrl("c/v", "a.mp4", { download: false })).not.toContain("download");
  });

  it("serves the player script from a fixed address", () => {
    expect(setup().api.playerScriptUrl).toBe("/assets/hyperframes-player.js");
  });
});

describe("uploads through the api", () => {
  const ticket: UploadTicket = { id: "abc123", name: "a.mp4", size: 10, maxChunkBytes: 4 };

  it("sends the file in chunks and reports progress", async () => {
    const t = setup({ uploads: { retryDelaysMs: [1] } });
    let received = 0;
    t.handler.current = ({ url, init }) => {
      if (init.method === "PUT") {
        expect(url).toMatch(/^\/api\/upload\/abc123\?offset=\d+$/);
        received += (init.body as Blob).size;
        return json(200, { received, done: received === 10 });
      }
      return json(200, { received, size: 10, done: false });
    };
    const progress: number[] = [];
    await t.api.uploads.send(ticket, new Blob([new Uint8Array(10)]), {
      onProgress: (n) => progress.push(n),
    });
    expect(progress).toEqual([0, 4, 8, 10]);
  });

  it("reads the state of an upload", async () => {
    const t = setup();
    t.handler.current = ({ url }) => {
      expect(url).toBe("/api/upload/abc123");
      return json(200, { received: 4, size: 10, done: false });
    };
    expect(await t.api.uploads.state("abc123")).toEqual({ received: 4, size: 10, done: false });
  });

  it("ends the session of the page on a 401 during an upload", async () => {
    const t = setup({ uploads: { retryDelaysMs: [1] } });
    t.handler.current = byName({ getSession: () => json(200, SIGNED_IN) });
    await t.api.getSession();
    const ended = vi.fn();
    t.api.on.sessionEnded(ended);
    t.handler.current = () => json(401, { code: "unauthenticated", message: "Sign in." });
    await expect(t.api.uploads.send(ticket, new Blob([new Uint8Array(10)]))).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(t.onUnauthenticated).toHaveBeenCalledTimes(1);
  });
});

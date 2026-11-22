import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "./connection";
import { createEventHub, type EventHub } from "./eventHub";
import { EVENT_NAMES, eventMethodName, type EventName } from "./rpc";
import {
  createEventStream,
  DEFAULT_BACKOFF_MS,
  type EventSourceLike,
  type EventStream,
  type SessionCheck,
} from "./sse";

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

  /** The server accepted the request. */
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  send(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  message(event: string, payload?: unknown) {
    this.send(JSON.stringify({ event, payload }));
  }

  hello(instanceId: string) {
    this.message("hello", { instanceId });
  }

  /** The network broke (the browser would retry) or, with `gaveUp`, the server refused. */
  fail(gaveUp = false) {
    this.readyState = gaveUp ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

interface Setup {
  stream: EventStream;
  sources: FakeSource[];
  connection: ReturnType<typeof createConnectionStore>;
  hub: EventHub;
  reload: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  onSessionLost: ReturnType<typeof vi.fn>;
  session: { answer: SessionCheck };
  last: () => FakeSource;
}

function setup(): Setup {
  const sources: FakeSource[] = [];
  const connection = createConnectionStore();
  const hub = createEventHub();
  const reload = vi.fn();
  const warn = vi.fn();
  const onSessionLost = vi.fn();
  const session = { answer: "signedIn" as SessionCheck };
  const stream = createEventStream({
    url: "/api/events",
    hub,
    connection,
    createSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    checkSession: () => Promise.resolve(session.answer),
    onSessionLost,
    reload,
    warn,
  });
  const last = () => {
    const source = sources[sources.length - 1];
    if (!source) throw new Error("no source was opened");
    return source;
  };
  return { stream, sources, connection, hub, reload, warn, onSessionLost, session, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting and stopping", () => {
  it("opens one EventSource on the events address and is connecting until it opens", () => {
    const t = setup();
    t.stream.start();
    t.stream.start();
    expect(t.sources).toHaveLength(1);
    expect(t.last().url).toBe("/api/events");
    expect(t.connection.getSnapshot().status).toBe("connecting");
    t.last().open();
    expect(t.connection.getSnapshot().status).toBe("connected");
  });

  it("closes the source at sign-out and never reconnects", () => {
    const t = setup();
    t.stream.start();
    const source = t.last();
    source.open();
    t.stream.stop();
    expect(source.closed).toBe(true);
    expect(t.stream.running).toBe(false);
    expect(t.connection.getSnapshot().status).toBe("connecting");
    vi.advanceTimersByTime(60_000);
    expect(t.sources).toHaveLength(1);
  });

  it("can start again after a stop with a fresh source", () => {
    const t = setup();
    t.stream.start();
    t.stream.stop();
    t.stream.start();
    expect(t.sources).toHaveLength(2);
    expect(t.last().closed).toBe(false);
  });

  it("ignores messages of a source that was closed", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.queueChanged(seen);
    t.stream.start();
    const source = t.last();
    const onmessage = source.onmessage;
    t.stream.stop();
    onmessage?.(
      new MessageEvent("message", {
        data: '{"event":"queue-changed","payload":{"queue":"edits"}}',
      }),
    );
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("hello and the instance id", () => {
  it("remembers the first instance id and does not reload for the same one", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().hello("one");
    expect(t.connection.getSnapshot().instance).toBe("one");
    t.last().fail();
    vi.advanceTimersByTime(1000);
    t.last().open();
    t.last().hello("one");
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("reloads the page once when the instance changes, never in a loop", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().hello("one");
    t.last().hello("two");
    t.last().hello("three");
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.connection.getSnapshot().instance).toBe("one");
  });

  it("ignores a hello without an instance id and says so once", () => {
    const t = setup();
    t.stream.start();
    t.last().message("hello", {});
    t.last().message("hello", null);
    expect(t.connection.getSnapshot().instance).toBeNull();
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  it("never passes hello on to the UI", () => {
    const t = setup();
    const seen = vi.fn();
    for (const name of EVENT_NAMES) {
      (t.hub.on as unknown as Record<string, (h: () => void) => void>)[eventMethodName(name)]?.(
        seen,
      );
    }
    t.stream.start();
    t.last().hello("one");
    expect(seen).not.toHaveBeenCalled();
  });
});

/** A sample payload of each event that has the right rough shape. */
const SAMPLES: Record<Exclude<EventName, "session-ended">, unknown> = {
  "library-changed": null,
  "workspace-changed": null,
  "job-updated": { id: "j1", videoId: "c/v", userId: "u1" },
  "job-log": { videoId: "c/v", jobId: "j1", entries: [] },
  "queue-changed": { queue: "edits" },
  "settings-changed": { zoom: 1 },
  "timeline-changed": { videoId: "c/v", revision: 2 },
  "note-updated": { videoId: "c/v", note: { id: "n" }, removed: false },
  "preview-copies-changed": { videoId: "c/v", copies: { total: 2, done: 1, running: true } },
  "usage-updated": { claude: {} },
  "system-changed": null,
  "disk-use-changed": { videos: [], totals: {}, measuring: false },
};

describe("events", () => {
  it.each(Object.entries(SAMPLES))("delivers %s with its payload", (name, payload) => {
    const t = setup();
    const seen = vi.fn();
    const subscribe = (t.hub.on as unknown as Record<string, (h: (p: unknown) => void) => void>)[
      eventMethodName(name as EventName)
    ];
    subscribe?.(seen);
    t.stream.start();
    t.last().open();
    t.last().message(name, payload);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(payload);
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("has a sample for every event the UI knows", () => {
    const names = EVENT_NAMES.filter((name) => name !== "session-ended");
    expect(Object.keys(SAMPLES).sort()).toEqual([...names].sort());
  });

  it("delivers the full library and a library change without a payload", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.libraryChanged(seen);
    t.stream.start();
    t.last().message("library-changed", { channels: [] });
    t.last().send('{"event":"library-changed"}');
    expect(seen).toHaveBeenNthCalledWith(1, { channels: [] });
    expect(seen).toHaveBeenNthCalledWith(2, null);
  });

  it("delivers system-changed without a payload whatever the server sent", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.systemChanged(seen);
    t.stream.start();
    t.last().message("system-changed", { surprise: true });
    expect(seen).toHaveBeenCalledWith(null);
  });

  it("keeps going when a handler throws", () => {
    const t = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = vi.fn();
    t.hub.on.queueChanged(() => {
      throw new Error("boom");
    });
    t.hub.on.jobUpdated(seen);
    t.stream.start();
    t.last().message("queue-changed", { queue: "edits" });
    t.last().message("job-updated", SAMPLES["job-updated"]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it("ignores unknown events and malformed payloads, logging each kind once", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.jobUpdated(seen);
    t.hub.on.queueChanged(seen);
    t.stream.start();
    const source = t.last();
    source.message("no-such-event", {});
    source.message("no-such-event", {});
    source.message("job-updated", { id: 7 });
    source.message("job-updated", "text");
    source.message("queue-changed", null);
    source.send("not json");
    source.send("not json either");
    source.send('{"payload":{}}');
    source.send("[1]");
    expect(seen).not.toHaveBeenCalled();
    // unknown event, job-updated, queue-changed, malformed: one line each.
    expect(t.warn).toHaveBeenCalledTimes(4);
    // The stream still works afterwards.
    source.message("queue-changed", { queue: "renders" });
    expect(seen).toHaveBeenCalledWith({ queue: "renders" });
  });

  it("ignores a preview-copies-changed event without a video or without its copies", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.previewCopiesChanged(seen);
    t.stream.start();
    t.last().message("preview-copies-changed", { videoId: "c/v" });
    t.last().message("preview-copies-changed", { copies: { total: 1, done: 0, running: true } });
    t.last().message("preview-copies-changed", { videoId: 7, copies: {} });
    t.last().message("preview-copies-changed", { videoId: "c/v", copies: "none" });
    t.last().message("preview-copies-changed", null);
    expect(seen).not.toHaveBeenCalled();
    expect(t.warn).toHaveBeenCalledTimes(1);
    t.last().message("preview-copies-changed", SAMPLES["preview-copies-changed"]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("passes an event added to the list without any rule when it carries an object", () => {
    const t = setup();
    const seen = vi.fn();
    // `settings-changed` has no rule of its own: an object passes, anything else does not.
    t.hub.on.settingsChanged(seen);
    t.stream.start();
    t.last().message("settings-changed", [1]);
    t.last().message("settings-changed", 5);
    expect(seen).not.toHaveBeenCalled();
    t.last().message("settings-changed", {});
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("session-ended", () => {
  it("passes the reason, stops the stream and does not reconnect", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.sessionEnded(seen);
    t.stream.start();
    const source = t.last();
    source.open();
    source.message("session-ended", { reason: "passwordChanged" });
    // The server then sends one without a payload and closes: nothing more reaches the page.
    source.message("session-ended", null);
    source.fail(true);
    vi.advanceTimersByTime(60_000);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ reason: "passwordChanged" });
    expect(source.closed).toBe(true);
    expect(t.sources).toHaveLength(1);
    expect(t.stream.running).toBe(false);
  });

  it("turns one without a payload into a null reason", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.sessionEnded(seen);
    t.stream.start();
    t.last().send('{"event":"session-ended","payload":null}');
    expect(seen).toHaveBeenCalledWith({ reason: null });
  });

  it("ignores a reason it does not know", () => {
    const t = setup();
    const seen = vi.fn();
    t.hub.on.sessionEnded(seen);
    t.stream.start();
    t.last().message("session-ended", { reason: "aliens" });
    t.last().message("session-ended", 5);
    expect(seen).not.toHaveBeenCalled();
    expect(t.stream.running).toBe(true);
  });
});

describe("a broken stream", () => {
  it("shows lost, reconnects with growing delays and caps the delay", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().fail();
    expect(t.connection.getSnapshot().status).toBe("lost");
    expect(t.last().closed).toBe(true);

    const delays: number[] = [];
    for (let attempt = 0; attempt < DEFAULT_BACKOFF_MS.length + 2; attempt += 1) {
      const before = t.sources.length;
      let waited = 0;
      while (t.sources.length === before && waited < 100_000) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      delays.push(waited);
      t.last().fail();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it("goes back to 1 second after a stream that said hello", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().fail();
    vi.advanceTimersByTime(1000);
    t.last().fail();
    vi.advanceTimersByTime(2000);
    expect(t.sources).toHaveLength(3);
    t.last().open();
    t.last().hello("one");
    t.last().fail();
    vi.advanceTimersByTime(999);
    expect(t.sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(t.sources).toHaveLength(4);
  });

  it("passes from lost to connected when the stream is back", () => {
    const t = setup();
    const statuses: string[] = [];
    t.connection.subscribe(() => statuses.push(t.connection.getSnapshot().status));
    t.stream.start();
    t.last().open();
    t.last().fail();
    vi.advanceTimersByTime(1000);
    t.last().open();
    expect(statuses).toEqual(["connected", "lost", "connected"]);
  });

  it("reconnects at once when the browser comes back online", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().fail();
    expect(t.sources).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
    expect(t.sources).toHaveLength(2);
    // And the old timer is gone: no second source after the delay.
    vi.advanceTimersByTime(5000);
    expect(t.sources).toHaveLength(2);
  });

  it("asks whether the session is there when the browser gave up, and retries when it is", async () => {
    const t = setup();
    t.stream.start();
    t.last().fail(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onSessionLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources).toHaveLength(2);
  });

  it("retries when the server cannot be reached to ask", async () => {
    const t = setup();
    t.session.answer = "unreachable";
    t.stream.start();
    t.last().fail(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources).toHaveLength(2);
    expect(t.connection.getSnapshot().status).toBe("lost");
  });

  it("stops for good and says so when the session is gone", async () => {
    const t = setup();
    t.session.answer = "signedOut";
    t.stream.start();
    t.last().fail(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.onSessionLost).toHaveBeenCalledTimes(1);
    expect(t.sources).toHaveLength(1);
    expect(t.stream.running).toBe(false);
    expect(t.connection.getSnapshot()).toMatchObject({ unauthorized: true, status: "connecting" });
  });

  it("drops the answer about the session when the stream was stopped meanwhile", async () => {
    const t = setup();
    t.session.answer = "signedOut";
    t.stream.start();
    t.last().fail(true);
    t.stream.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.onSessionLost).not.toHaveBeenCalled();
  });

  it("is not unauthorized any more once a stream opens", () => {
    const t = setup();
    t.connection.update({ unauthorized: true });
    t.stream.start();
    t.last().open();
    expect(t.connection.getSnapshot().unauthorized).toBe(false);
  });
});

describe("the heartbeat", () => {
  it("swallows ping: it reaches the UI as nothing and is not warned about", () => {
    const t = setup();
    const seen = vi.fn();
    for (const name of EVENT_NAMES) {
      (t.hub.on as unknown as Record<string, (h: () => void) => void>)[eventMethodName(name)]?.(
        seen,
      );
    }
    t.stream.start();
    t.last().open();
    t.last().hello("one");
    t.last().message("ping", null);
    t.last().send(JSON.stringify({ event: "ping" }));
    expect(seen).not.toHaveBeenCalled();
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("treats 45 seconds without any message as a lost stream and reconnects with the backoff", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().hello("one");
    vi.advanceTimersByTime(44_999);
    expect(t.last().closed).toBe(false);
    expect(t.connection.getSnapshot().status).toBe("connected");
    vi.advanceTimersByTime(1);
    expect(t.sources[0]?.closed).toBe(true);
    expect(t.connection.getSnapshot().status).toBe("lost");
    // The first delay of the backoff (hello was seen: 1 second), then a new source.
    vi.advanceTimersByTime(999);
    expect(t.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sources).toHaveLength(2);
    t.last().open();
    expect(t.connection.getSnapshot().status).toBe("connected");
  });

  it("restarts the silence at every message, a ping included", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().hello("one");
    for (let beat = 0; beat < 6; beat += 1) {
      vi.advanceTimersByTime(15_000);
      t.last().message("ping", null);
    }
    expect(t.sources).toHaveLength(1);
    expect(t.connection.getSnapshot().status).toBe("connected");
    // A message that is not an event also proves the stream is alive.
    vi.advanceTimersByTime(44_000);
    t.last().send("not json");
    vi.advanceTimersByTime(44_000);
    expect(t.sources).toHaveLength(1);
  });

  it("keeps growing the delays when the silence repeats", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    vi.advanceTimersByTime(45_000);
    vi.advanceTimersByTime(1000);
    expect(t.sources).toHaveLength(2);
    // The second source never opens and never speaks: silent again after 45 seconds.
    vi.advanceTimersByTime(45_000);
    vi.advanceTimersByTime(1999);
    expect(t.sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(t.sources).toHaveLength(3);
  });

  it("can be tuned with silentMs", () => {
    const sources: FakeSource[] = [];
    const stream = createEventStream({
      url: "/api/events",
      hub: createEventHub(),
      connection: createConnectionStore(),
      createSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      checkSession: () => Promise.resolve("signedIn"),
      onSessionLost: vi.fn(),
      silentMs: 100,
    });
    stream.start();
    vi.advanceTimersByTime(100);
    expect(sources[0]?.closed).toBe(true);
    stream.stop();
  });

  it("clears the timer at stop: nothing reconnects afterwards", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.stream.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(t.sources).toHaveLength(1);
    expect(t.connection.getSnapshot().status).toBe("connecting");
  });

  it("clears the timer when the stream breaks or ends, the new source gets its own", () => {
    const t = setup();
    t.stream.start();
    t.last().open();
    t.last().fail();
    // Only the reconnect timer is pending, not a second silence timer of the closed source.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(1);
    t.last().open();
    t.last().message("session-ended", { reason: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});

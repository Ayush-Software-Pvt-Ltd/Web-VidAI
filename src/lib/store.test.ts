/**
 * The store against a hand-written fake `Api`: every call is answered by a handler the test sets
 * (an unexpected call rejects), every event is emitted by the test, and answers can be held back
 * with `deferred()` to make requests race.
 */
import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { createConnectionStore } from "./connection";
import { ApiError } from "./errors";
import { createAppStore } from "./store";
import {
  NO_PREVIEW_COPIES,
  SESSION_ENDED_TEXT,
  findChannel,
  findJob,
  findQueueEntry,
  findVideo,
  lineTotals,
  ownJobCounts,
  ownRunningEdits,
  selectPreviewCopies,
  selectSelectedVideo,
  sessionEndedText,
} from "./store";
import { MAX_LOG_ENTRIES } from "./types";

type Handler = (input: never) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A typed-enough stand-in for the backend. `answer` sets what a call returns. */
function fakeApi() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ name: string; input: unknown }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const connection = createConnectionStore({ status: "connected" });
  const on = new Proxy(
    {},
    {
      get: (_target, name: string) => (handler: (payload: unknown) => void) => {
        const set = listeners.get(name) ?? new Set();
        listeners.set(name, set);
        set.add(handler);
        return () => void set.delete(handler);
      },
    },
  );
  const base: Record<string, unknown> = { backend: "mock", connection, on };
  const api = new Proxy(base, {
    get(target, name: string) {
      if (name in target) return target[name];
      return (input: unknown) => {
        calls.push({ name, input });
        const handler = handlers.get(name);
        if (!handler) return Promise.reject(new ApiError("internal", `unexpected call ${name}`));
        return Promise.resolve().then(() => handler(input as never));
      };
    },
  }) as unknown as Api;
  return {
    api,
    connection,
    calls,
    answer(name: string, handler: unknown) {
      handlers.set(name, typeof handler === "function" ? (handler as Handler) : () => handler);
    },
    count: (name: string) => calls.filter((call) => call.name === name).length,
    emit(name: string, payload?: unknown) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
type Fake = ReturnType<typeof fakeApi>;

// Fixtures name only the fields the store reads; the cast is the point of this helper.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const cast = <T>(value: unknown) => value as T;

const sessionOf = (role: "admin" | "user" | null) => ({
  user: role ? { id: `${role}-id`, role, email: `${role}@example.test` } : null,
  needsSetup: false,
  serverVersion: "1.0.0",
});
const job = (id: string, videoId: string, extra: Record<string, unknown> = {}) =>
  cast<import("./types").JobView>({
    id,
    videoId,
    userId: "user-id",
    kind: "edit",
    queue: "edits",
    state: "running",
    urgent: false,
    position: null,
    startsAt: null,
    joinedAt: 1,
    ...extra,
  });
const video = (id: string, theJob: unknown = null) =>
  cast<import("./types").VideoView>({ id, job: theJob });
const libraryOf = (...videos: Array<ReturnType<typeof video>>) =>
  cast<import("./types").Library>({
    channels: [{ channelId: "c1", available: true, videos }],
  });
const channel = (id: string) => cast<import("./types").Channel>({ id, name: id });
const workspaceOf = (...ids: string[]) =>
  cast<import("./types").Workspace>({
    channels: ids.map(channel),
    settings: { maxEditsPerUser: 2 },
    readiness: null,
  });
const entry = (theJob: ReturnType<typeof job>) => ({ job: theJob });

/** The answers a signed-in user's `init()` asks for. */
function signedIn(fake: Fake, role: "admin" | "user" = "user") {
  fake.answer("getSession", sessionOf(role));
  fake.answer("getWorkspace", workspaceOf("c1"));
  fake.answer("getReadiness", { problem: null, message: null });
  fake.answer("getHarness", { setup: "claudeSubscription" });
  fake.answer("getLibrary", libraryOf(video("c1/001", job("j1", "c1/001"))));
  fake.answer("getQueue", { jobs: [entry(job("j1", "c1/001"))], queues: [] });
  fake.answer("getUsage", { claude: null, opencode: null });
}

async function start(role: "admin" | "user" | null = "user") {
  const fake = fakeApi();
  if (role) signedIn(fake, role);
  else fake.answer("getSession", sessionOf(null));
  const store = createAppStore(fake.api);
  const stop = store.getState().init();
  await vi.waitFor(() => expect(store.getState().session.status).toBe("ready"));
  if (role) await vi.waitFor(() => expect(store.getState().usage.status).toBe("ready"));
  return { fake, store, stop, get: store.getState };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("init()", () => {
  it("loads what an admin sees, but not the admin pages", async () => {
    const { get, fake } = await start("admin");
    expect(get().session.data?.user?.role).toBe("admin");
    for (const key of ["workspace", "readiness", "harness", "library", "queue", "usage"] as const) {
      expect(get()[key].status).toBe("ready");
    }
    expect(fake.calls.map((c) => c.name).filter((n) => n.startsWith("admin"))).toEqual([]);
    expect(get().adminQueue.status).toBe("idle");
  });

  it("loads the same for a user", async () => {
    const { get } = await start("user");
    expect(get().session.data?.user?.role).toBe("user");
    expect(get().library.data?.channels).toHaveLength(1);
  });

  it("asks only for the session when nobody is signed in", async () => {
    const { get, fake } = await start(null);
    await settle();
    expect(get().session.data?.user).toBeNull();
    expect(fake.calls.map((c) => c.name)).toEqual(["getSession"]);
  });

  it("loads nothing else while the first admin is still to be created", async () => {
    const fake = fakeApi();
    fake.answer("getSession", { user: null, needsSetup: true, serverVersion: "1" });
    const store = createAppStore(fake.api);
    store.getState().init();
    await vi.waitFor(() => expect(store.getState().session.status).toBe("ready"));
    await settle();
    expect(store.getState().session.data?.needsSetup).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("returns a cleanup that unsubscribes everything", async () => {
    const { fake, stop, get } = await start("user");
    expect(fake.listenerCount()).toBeGreaterThanOrEqual(11);
    stop();
    expect(fake.listenerCount()).toBe(0);
    fake.emit("diskUseChanged", { total: 1 });
    expect(get().diskUse.status).toBe("idle");
  });

  it("signs in through login() and loads the user's data", async () => {
    const fake = fakeApi();
    fake.answer("getSession", sessionOf(null));
    const store = createAppStore(fake.api);
    store.getState().init();
    await vi.waitFor(() => expect(store.getState().session.status).toBe("ready"));
    signedIn(fake, "user");
    fake.answer("login", sessionOf("user"));
    await store.getState().login("user@example.test", "secret");
    expect(store.getState().library.status).toBe("ready");
    expect(store.getState().signedOutReason).toBeNull();
  });

  it("rejects a refused login with the ApiError", async () => {
    const fake = fakeApi();
    fake.answer("login", () => {
      throw new ApiError("invalidInput", "Wrong email or password.");
    });
    const store = createAppStore(fake.api);
    await expect(store.getState().login("a@b.test", "x")).rejects.toMatchObject({
      name: "ApiError",
      message: "Wrong email or password.",
    });
  });
});

describe("events", () => {
  it("library-changed with a library replaces it, null asks again", async () => {
    const { fake, get } = await start();
    fake.emit("libraryChanged", libraryOf(video("c1/002")));
    expect(get().library.data?.channels[0]?.videos.map((v) => v.id)).toEqual(["c1/002"]);
    const before = fake.count("getLibrary");
    fake.answer("getLibrary", libraryOf(video("c1/003")));
    fake.emit("libraryChanged", null);
    await vi.waitFor(() => expect(get().library.data?.channels[0]?.videos[0]?.id).toBe("c1/003"));
    expect(fake.count("getLibrary")).toBe(before + 1);
  });

  it("job-updated puts the job into its video row and the queue at once", async () => {
    const { fake, get } = await start();
    fake.emit("jobUpdated", job("j1", "c1/001", { state: "paused" }));
    expect(findJob(get().library.data, "c1/001")?.state).toBe("paused");
    expect(get().queue.data?.jobs[0]?.job.state).toBe("paused");
    // A finished job leaves the queue.
    fake.emit("jobUpdated", job("j1", "c1/001", { state: "completed" }));
    expect(get().queue.data?.jobs).toEqual([]);
    expect(findJob(get().library.data, "c1/001")?.state).toBe("completed");
  });

  it("job-updated of another user stays out of an admin's library but updates the admin queue", async () => {
    const { fake, get } = await start("admin");
    fake.answer("adminGetQueue", {
      jobs: [{ jobId: "j9", state: "queued", queue: "edits", kind: "edit", urgent: false }],
      queues: [],
    });
    await get().loadAdminQueue();
    fake.emit("jobUpdated", job("j9", "c1/001", { userId: "other-id", state: "running" }));
    expect(findJob(get().library.data, "c1/001")?.id).toBe("j1");
    expect(get().adminQueue.data?.jobs[0]?.state).toBe("running");
  });

  it("job-updated of another user does nothing when the admin queue is not loaded", async () => {
    const { fake, get } = await start("admin");
    fake.emit("jobUpdated", job("j9", "c1/001", { userId: "other-id" }));
    expect(findJob(get().library.data, "c1/001")?.id).toBe("j1");
    expect(get().adminQueue.status).toBe("idle");
  });

  it("job-updated of an unknown active job of the user refetches the queue", async () => {
    const { fake, get } = await start();
    const before = fake.count("getQueue");
    fake.emit("jobUpdated", job("j2", "c1/002", { state: "queued" }));
    await vi.waitFor(() => expect(fake.count("getQueue")).toBe(before + 1));
    await vi.waitFor(() => expect(get().queue.status).toBe("ready"));
  });

  it("job-log appends to an opened log and ignores logs nobody opened", async () => {
    const { fake, get } = await start();
    fake.answer("getJobLog", { entries: [{ seq: 1, text: "one" }] });
    fake.emit("jobLog", { videoId: "c1/001", jobId: "j1", entries: [{ seq: 1, text: "x" }] });
    expect(get().jobLogs).toEqual({});
    await get().loadJobLog("c1/001", "j1");
    fake.emit("jobLog", {
      videoId: "c1/001",
      jobId: "j1",
      entries: [
        { seq: 1, text: "again" },
        { seq: 2, text: "two" },
      ],
    });
    expect(get().jobLogs["c1/001"]?.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(get().jobLogs["c1/001"]?.entries[0]?.text).toBe("one");
  });

  it("keeps at most MAX_LOG_ENTRIES lines, dropping the oldest", async () => {
    const { fake, get } = await start();
    fake.answer("getJobLog", { entries: [{ seq: 0 }] });
    await get().loadJobLog("c1/001", "j1");
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({ seq: from + i }));
    fake.emit("jobLog", { videoId: "c1/001", jobId: "j1", entries: lines(1, MAX_LOG_ENTRIES) });
    expect(get().jobLogs["c1/001"]?.entries).toHaveLength(MAX_LOG_ENTRIES);
    fake.emit("jobLog", {
      videoId: "c1/001",
      jobId: "j1",
      entries: lines(MAX_LOG_ENTRIES, MAX_LOG_ENTRIES + 3),
    });
    const seqs = get().jobLogs["c1/001"]?.entries.map((e) => e.seq) ?? [];
    expect(seqs).toHaveLength(MAX_LOG_ENTRIES);
    expect(seqs[0]).toBe(3);
    expect(seqs[seqs.length - 1]).toBe(MAX_LOG_ENTRIES + 2);
  });

  it("queue-changed refetches the queue, and the admin queue only when loaded", async () => {
    const { fake, get } = await start("admin");
    fake.emit("queueChanged");
    await vi.waitFor(() => expect(fake.count("getQueue")).toBe(2));
    expect(fake.count("adminGetQueue")).toBe(0);
    fake.answer("adminGetQueue", { jobs: [], queues: [] });
    await get().loadAdminQueue();
    fake.emit("queueChanged");
    await vi.waitFor(() => expect(fake.count("adminGetQueue")).toBe(3 - 1));
  });

  it("settings-changed replaces the settings and the harness and asks for the readiness", async () => {
    const { fake, get } = await start();
    const before = fake.count("getReadiness");
    fake.emit("settingsChanged", { maxEditsPerUser: 5, harness: { setup: "opencodeGo" } });
    expect(get().workspace.data?.settings).toEqual({ maxEditsPerUser: 5 });
    expect(get().harness.data?.setup).toBe("opencodeGo");
    await vi.waitFor(() => expect(fake.count("getReadiness")).toBe(before + 1));
    // Without a harness the one in the state stays.
    fake.emit("settingsChanged", { maxEditsPerUser: 1 });
    expect(get().workspace.data?.settings).toEqual({ maxEditsPerUser: 1 });
    expect(get().harness.data?.setup).toBe("opencodeGo");
  });

  it("settings-changed reads the admin settings and harness again, only the ones that are loaded", async () => {
    const { fake, get } = await start("admin");
    fake.emit("settingsChanged", { maxEditsPerUser: 5 });
    await settle();
    expect(fake.count("adminGetSettings")).toBe(0);
    expect(fake.count("adminGetHarness")).toBe(0);
    fake.answer("adminGetSettings", { maxEdits: 2 });
    fake.answer("adminGetHarness", { setup: "claudeSubscription" });
    await get().loadAdminSettings();
    fake.emit("settingsChanged", { maxEditsPerUser: 5 });
    await vi.waitFor(() => expect(fake.count("adminGetSettings")).toBe(2));
    expect(fake.count("adminGetHarness")).toBe(0);
    await get().loadAdminHarness();
    fake.answer("adminGetSettings", { maxEdits: 6 });
    fake.answer("adminGetHarness", { setup: "opencodeGo" });
    fake.emit("settingsChanged", { maxEditsPerUser: 1 });
    await vi.waitFor(() => expect(get().adminSettings.data).toEqual({ maxEdits: 6 }));
    await vi.waitFor(() => expect(get().adminHarness.data).toEqual({ setup: "opencodeGo" }));
  });

  it("usage-updated merges the fields that are present", async () => {
    const { fake, get } = await start();
    fake.emit("usageUpdated", { claude: { fiveHour: 1 } });
    expect(get().usage.data).toEqual({ claude: { fiveHour: 1 }, opencode: null });
    fake.emit("usageUpdated", { opencode: { limits: [] } });
    expect(get().usage.data).toEqual({ claude: { fiveHour: 1 }, opencode: { limits: [] } });
  });

  it("timeline-changed reloads an open timeline at another revision, not a closed one", async () => {
    const { fake, get } = await start();
    fake.answer("openTimeline", {
      timeline: { revision: 1, notes: [] },
      previewUrl: "/p/1",
      violations: [],
    });
    fake.answer("getTimeline", { revision: 2, notes: [] });
    await get().openTimelineOf("c1/001");
    await get().applyTimelineChanged({ videoId: "c1/001", revision: 1 });
    expect(fake.count("getTimeline")).toBe(0);
    fake.emit("timelineChanged", { videoId: "c1/001", revision: 2 });
    await vi.waitFor(() => expect(get().timelines["c1/001"]?.timeline.data?.revision).toBe(2));
    fake.emit("timelineChanged", { videoId: "c1/009", revision: 2 });
    await settle();
    expect(fake.count("getTimeline")).toBe(1);
    expect(get().timelines["c1/009"]).toBeUndefined();
  });

  describe("a note's answer against events that came first", () => {
    const note = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
      id,
      prompt: id,
      state,
      jobId: null,
      error: null,
      ...extra,
    });
    async function open(notes: unknown[] = []) {
      const t = await start();
      t.fake.answer("openTimeline", {
        timeline: { revision: 1, notes },
        previewUrl: null,
        violations: [],
      });
      await t.get().openTimelineOf("c1/001");
      const stateOf = (id: string) =>
        t.get().timelines["c1/001"]?.timeline.data?.notes.find((n) => n.id === id)?.state;
      const emit = (n: unknown) =>
        t.fake.emit("noteUpdated", { videoId: "c1/001", note: n, removed: false });
      return { ...t, stateOf, emit };
    }
    const input = {
      frame: 1,
      shape: null,
      elementId: null,
      prompt: "x",
    } as never;

    it("keeps a running note running when the answer that made it comes later as pending", async () => {
      const { fake, get, stateOf, emit } = await open();
      const answer = deferred<unknown>();
      fake.answer("addTimelineNote", () => answer.promise);
      const adding = get().addTimelineNote("c1/001", input);
      await settle();
      emit(note("n1", "pending"));
      emit(note("n1", "running", { jobId: "j1" }));
      expect(stateOf("n1")).toBe("running");
      answer.resolve(note("n1", "pending"));
      const returned = await adding;
      expect(returned.state).toBe("pending");
      expect(stateOf("n1")).toBe("running");
    });

    it("applies the answer when no event came first", async () => {
      const { fake, get, stateOf } = await open();
      fake.answer("addTimelineNote", note("n1", "pending"));
      await get().addTimelineNote("c1/001", input);
      expect(stateOf("n1")).toBe("pending");
    });

    it("keeps a note that already finished when the answer of its retry comes later", async () => {
      const { fake, get, stateOf, emit } = await open([note("n1", "failed", { error: "No." })]);
      const answer = deferred<unknown>();
      fake.answer("retryTimelineNote", () => answer.promise);
      const retrying = get().retryTimelineNote("c1/001", "n1");
      await settle();
      emit(note("n1", "pending"));
      emit(note("n1", "done", { jobId: "j2" }));
      answer.resolve(note("n1", "pending"));
      await retrying;
      expect(stateOf("n1")).toBe("done");
    });

    it("lets a retry take a note back from failed to pending", async () => {
      const { fake, get, stateOf } = await open([note("n1", "failed", { error: "No." })]);
      fake.answer("retryTimelineNote", note("n1", "pending"));
      await get().retryTimelineNote("c1/001", "n1");
      expect(stateOf("n1")).toBe("pending");
    });
  });

  it("note-updated adds, replaces and removes notes of a loaded timeline", async () => {
    const { fake, get } = await start();
    fake.answer("openTimeline", {
      timeline: { revision: 1, notes: [{ id: "n1", prompt: "a" }] },
      previewUrl: null,
      violations: [],
    });
    await get().openTimelineOf("c1/001");
    const notes = () => get().timelines["c1/001"]?.timeline.data?.notes.map((n) => n.prompt);
    fake.emit("noteUpdated", {
      videoId: "c1/001",
      note: { id: "n2", prompt: "b" },
      removed: false,
    });
    expect(notes()).toEqual(["a", "b"]);
    fake.emit("noteUpdated", {
      videoId: "c1/001",
      note: { id: "n1", prompt: "A" },
      removed: false,
    });
    expect(notes()).toEqual(["A", "b"]);
    fake.emit("noteUpdated", { videoId: "c1/001", note: { id: "n1", prompt: "A" }, removed: true });
    expect(notes()).toEqual(["b"]);
    fake.emit("noteUpdated", { videoId: "c1/other", note: { id: "n3" }, removed: false });
    expect(get().timelines["c1/other"]).toBeUndefined();
  });

  it("preview-copies-changed updates the open video only, and openTimeline starts it", async () => {
    const { fake, get } = await start();
    const copies = (total: number, done: number, running: boolean) => ({ total, done, running });
    fake.answer("openTimeline", {
      timeline: { revision: 1, notes: [] },
      previewUrl: null,
      violations: [],
      previewCopies: copies(3, 1, true),
    });
    expect(selectPreviewCopies("c1/001")(get())).toBe(NO_PREVIEW_COPIES);
    await get().openTimelineOf("c1/001");
    expect(selectPreviewCopies("c1/001")(get())).toEqual(copies(3, 1, true));
    fake.emit("previewCopiesChanged", { videoId: "c1/001", copies: copies(3, 2, true) });
    expect(selectPreviewCopies("c1/001")(get())).toEqual(copies(3, 2, true));
    fake.emit("previewCopiesChanged", { videoId: "c1/001", copies: copies(3, 3, false) });
    expect(selectPreviewCopies("c1/001")(get())).toEqual(copies(3, 3, false));
    fake.emit("previewCopiesChanged", { videoId: "c1/other", copies: copies(1, 0, true) });
    expect(get().timelines["c1/other"]).toBeUndefined();
    expect(selectPreviewCopies("c1/other")(get())).toBe(NO_PREVIEW_COPIES);
    get().forgetTimeline("c1/001");
    expect(selectPreviewCopies("c1/001")(get())).toBe(NO_PREVIEW_COPIES);
  });

  it("system-changed refetches the admin system only when loaded", async () => {
    const { fake, get } = await start("admin");
    fake.answer("adminGetSystem", { version: 1 });
    fake.emit("systemChanged");
    await settle();
    expect(fake.count("adminGetSystem")).toBe(0);
    await get().loadAdminSystem();
    fake.emit("systemChanged");
    await vi.waitFor(() => expect(fake.count("adminGetSystem")).toBe(2));
  });

  it("disk-use-changed replaces the disk use", async () => {
    const { fake, get } = await start();
    fake.emit("diskUseChanged", { total: 7 });
    expect(get().diskUse).toMatchObject({ status: "ready", data: { total: 7 } });
  });
});

describe("session end", () => {
  it.each([
    ["passwordChanged", /password was changed/],
    ["disabled", /turned off/],
    ["removed", /removed/],
    [null, new RegExp(SESSION_ENDED_TEXT.replace(".", "\\."))],
  ] as const)("session-ended %s signs out with its sentence", async (reason, text) => {
    const { fake, get } = await start();
    fake.emit("sessionEnded", { reason });
    expect(get().session.data?.user).toBeNull();
    expect(get().signedOutReason).toMatch(text);
    expect(get().library.data).toBeNull();
  });

  it("words null as a plain sentence", () => {
    expect(sessionEndedText(null)).toBe("Your session has ended. Sign in again.");
  });

  it("changes nothing when a second session-ended follows the first", async () => {
    const { fake, get } = await start();
    fake.emit("sessionEnded", { reason: "disabled" });
    const first = get();
    fake.emit("sessionEnded", { reason: null });
    expect(get().signedOutReason).toBe(first.signedOutReason);
    expect(get().session).toEqual(first.session);
    fake.emit("sessionEnded", { reason: "removed" });
    expect(get().signedOutReason).toBe(first.signedOutReason);
  });

  it("leaves no data of the user behind, and signedOut() twice is harmless", async () => {
    const { fake, get } = await start("admin");
    fake.answer("adminGetQueue", { jobs: [], queues: [] });
    await get().loadAdminQueue();
    await get()
      .loadDiskUse()
      .catch(() => undefined);
    get().selectChannel("c1");
    get().selectVideo("c1/001");
    get().signedOut();
    get().signedOut();
    const s = get();
    for (const key of [
      "workspace",
      "readiness",
      "harness",
      "library",
      "queue",
      "usage",
      "archived",
      "editLog",
      "diskUse",
      "adminQueue",
    ] as const) {
      expect(s[key]).toEqual({ data: null, status: "idle", error: null });
    }
    expect(s.jobLogs).toEqual({});
    expect(s.timelines).toEqual({});
    expect(s.selectedChannelId).toBeNull();
    expect(s.selectedVideoId).toBeNull();
    expect(s.view).toBe("main");
    expect(s.session.data?.user).toBeNull();
    expect(s.signedOutReason).toBe(SESSION_ENDED_TEXT);
  });

  it("drops answers that were still on their way when the user signed out", async () => {
    const { fake, get } = await start();
    const slow = deferred<unknown>();
    fake.answer("getLibrary", () => slow.promise);
    const refresh = get().refreshLibrary();
    get().signedOut();
    slow.resolve(libraryOf(video("c1/777")));
    await refresh;
    expect(get().library.data).toBeNull();
  });

  it("shows no sentence after a deliberate logout, even when the event comes first", async () => {
    const { fake, get } = await start();
    fake.answer("logout", () => {
      fake.emit("sessionEnded", { reason: null });
      return undefined;
    });
    await get().logout();
    expect(get().session.data?.user).toBeNull();
    expect(get().signedOutReason).toBeNull();
  });

  it("treats a logout answered unauthenticated as done, and shows other failures", async () => {
    const { fake, get } = await start();
    fake.answer("logout", () => {
      throw new ApiError("unauthenticated", "Please sign in again.");
    });
    await get().logout();
    expect(get().session.data?.user).toBeNull();
    const second = await start();
    second.fake.answer("logout", () => {
      throw new ApiError("io", "Offline.");
    });
    await expect(second.get().logout()).rejects.toMatchObject({ code: "io" });
    expect(second.get().session.data?.user).not.toBeNull();
  });

  it("signs out on any call answered unauthenticated", async () => {
    const { fake, get } = await start();
    fake.answer("getArchived", () => {
      throw new ApiError("unauthenticated", "Please sign in again.");
    });
    await get().loadArchived();
    expect(get().session.data?.user).toBeNull();
    expect(get().signedOutReason).toBe(SESSION_ENDED_TEXT);
  });

  it("clears the previous user's data when another account signs in", async () => {
    const { fake, get } = await start("admin");
    fake.answer("getLibrary", libraryOf(video("c1/other")));
    await get().setSession({
      ...sessionOf("user"),
      user: { id: "someone-else", role: "user" },
    } as never);
    expect(get().library.data?.channels[0]?.videos.map((v) => v.id)).toEqual(["c1/other"]);
  });
});

describe("races", () => {
  it("coalesces refreshes: one in flight plus one queued", async () => {
    const { fake, get } = await start();
    const first = deferred<unknown>();
    fake.answer("getLibrary", () => first.promise);
    const before = fake.count("getLibrary");
    const runs = [get().refreshLibrary(), get().refreshLibrary(), get().refreshLibrary()];
    await settle();
    expect(fake.count("getLibrary")).toBe(before + 1);
    fake.answer("getLibrary", libraryOf(video("c1/second")));
    first.resolve(libraryOf(video("c1/first")));
    await Promise.all(runs);
    expect(fake.count("getLibrary")).toBe(before + 2);
    expect(get().library.data?.channels[0]?.videos[0]?.id).toBe("c1/second");
  });

  it("lets only the newest load of a resource write", async () => {
    const { fake, get } = await start();
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    const answers = [slow, fast];
    fake.answer("getUsage", () => answers.shift()?.promise);
    const older = get().loadUsage();
    const newer = get().loadUsage();
    fast.resolve({ claude: { fiveHour: 2 }, opencode: null });
    await newer;
    slow.resolve({ claude: { fiveHour: 1 }, opencode: null });
    await older;
    expect(get().usage.data).toEqual({ claude: { fiveHour: 2 }, opencode: null });
  });

  it("drops an answer that arrives after a library event replaced the state", async () => {
    const { fake, get } = await start();
    const slow = deferred<unknown>();
    fake.answer("getLibrary", () => slow.promise);
    const refresh = get().refreshLibrary();
    fake.emit("libraryChanged", libraryOf(video("c1/new")));
    slow.resolve(libraryOf(video("c1/old")));
    await refresh;
    expect(get().library.data?.channels[0]?.videos[0]?.id).toBe("c1/new");
  });

  it("keeps the data while refreshing and after a failed refresh", async () => {
    const { fake, get } = await start();
    fake.answer("getLibrary", () => {
      throw new ApiError("io", "Offline.");
    });
    await get().refreshLibrary();
    expect(get().library.status).toBe("error");
    expect(get().library.error?.code).toBe("io");
    expect(get().library.data?.channels).toHaveLength(1);
  });
});

describe("navigation", () => {
  it("falls back when the selected video disappears from a library that can see it", async () => {
    const { fake, get } = await start();
    get().selectVideo("c1/001");
    fake.emit("libraryChanged", libraryOf(video("c1/002")));
    expect(get().selectedVideoId).toBeNull();
  });

  it("keeps the selection while the channel's folder cannot be read", async () => {
    const { fake, get } = await start();
    get().selectVideo("c1/001");
    fake.emit(
      "libraryChanged",
      cast({ channels: [{ channelId: "c1", available: false, videos: [] }] }),
    );
    expect(get().selectedVideoId).toBe("c1/001");
  });

  it("clears the selected channel when an admin removes the channel (workspace-changed)", async () => {
    const { fake, get } = await start();
    get().selectChannel("c1");
    const before = fake.count("getWorkspace");
    fake.answer("getWorkspace", workspaceOf());
    fake.emit("workspaceChanged", null);
    await vi.waitFor(() => expect(get().selectedChannelId).toBeNull());
    expect(fake.count("getWorkspace")).toBe(before + 1);
    expect(get().workspace.data?.channels).toEqual([]);
  });

  it("leaves the timeline view when its video is gone", async () => {
    const { fake, get } = await start();
    get().goTo({ view: "timeline", videoId: "c1/001" });
    expect(get().view).toBe("timeline");
    fake.emit("libraryChanged", libraryOf());
    expect(get().view).toBe("main");
    expect(get().timelineVideoId).toBeNull();
  });

  it("goes to settings and admin sections and back", async () => {
    const { get } = await start("admin");
    get().goTo({ view: "settings", section: "channels" });
    expect(get().view).toBe("settings");
    get().toggleSettings();
    expect(get().view).toBe("main");
    get().goTo({ view: "admin", section: "system" });
    expect([get().view, get().adminSection]).toEqual(["admin", "system"]);
  });
});

describe("reconnecting", () => {
  it("asks again for everything signed-in plus the loaded optional resources", async () => {
    const { fake, get } = await start("admin");
    fake.answer("adminGetQueue", { jobs: [], queues: [] });
    fake.answer("adminGetSystem", { version: 1 });
    fake.answer("getDiskUse", { total: 1 });
    await Promise.all([get().loadAdminQueue(), get().loadAdminSystem(), get().loadDiskUse()]);
    fake.calls.length = 0;
    fake.connection.update({ status: "lost" });
    await settle();
    expect(fake.calls).toEqual([]);
    fake.connection.update({ status: "connected" });
    await vi.waitFor(() => expect(fake.count("getUsage")).toBe(1));
    for (const name of [
      "getWorkspace",
      "getReadiness",
      "getHarness",
      "getLibrary",
      "getQueue",
      "adminGetQueue",
      "adminGetSystem",
      "getDiskUse",
    ]) {
      expect(fake.count(name), name).toBe(1);
    }
    // What was never loaded stays unloaded.
    expect(fake.count("adminListUsers")).toBe(0);
    expect(fake.count("getArchived")).toBe(0);
  });

  it("reloads open timelines and job logs", async () => {
    const { fake, get } = await start();
    fake.answer("openTimeline", {
      timeline: { revision: 1, notes: [] },
      previewUrl: null,
      violations: [],
    });
    fake.answer("getJobLog", { entries: [{ seq: 1 }] });
    await get().openTimelineOf("c1/001");
    await get().loadJobLog("c1/001", "j1");
    fake.calls.length = 0;
    fake.connection.update({ status: "lost" });
    fake.connection.update({ status: "connected" });
    await vi.waitFor(() => expect(fake.count("openTimeline")).toBe(1));
    await vi.waitFor(() => expect(fake.count("getJobLog")).toBe(1));
    expect(fake.calls.find((c) => c.name === "getJobLog")?.input).toEqual({
      jobId: "j1",
      after: 1,
    });
  });

  it("does nothing when the stream merely opens for the first time", async () => {
    const fake = fakeApi();
    signedIn(fake);
    fake.connection.update({ status: "connecting" });
    const store = createAppStore(fake.api);
    store.getState().init();
    await vi.waitFor(() => expect(store.getState().usage.status).toBe("ready"));
    fake.calls.length = 0;
    fake.connection.update({ status: "connected" });
    await settle();
    expect(fake.calls).toEqual([]);
  });

  it("does nothing while signed out, nor after the cleanup", async () => {
    const out = await start(null);
    out.fake.connection.update({ status: "lost" });
    out.fake.connection.update({ status: "connected" });
    await settle();
    expect(out.fake.calls.map((c) => c.name)).toEqual(["getSession"]);

    const inn = await start("user");
    inn.stop();
    inn.fake.calls.length = 0;
    inn.fake.connection.update({ status: "lost" });
    inn.fake.connection.update({ status: "connected" });
    await settle();
    expect(inn.fake.calls).toEqual([]);
  });

  it("coalesces a refresh already in flight with the one a reconnect asks for", async () => {
    const { fake, get } = await start();
    const first = deferred<unknown>();
    fake.answer("getLibrary", () => first.promise);
    fake.calls.length = 0;
    void get().refreshLibrary();
    fake.connection.update({ status: "lost" });
    fake.connection.update({ status: "connected" });
    await settle();
    expect(fake.count("getLibrary")).toBe(1);
    fake.answer("getLibrary", libraryOf());
    first.resolve(libraryOf());
    await vi.waitFor(() => expect(fake.count("getLibrary")).toBe(2));
  });
});

describe("actions", () => {
  it("applies the job a command returns at once", async () => {
    const { fake, get } = await start();
    fake.answer("pauseJob", job("j1", "c1/001", { state: "pausing" }));
    const returned = await get().pauseJob("j1");
    expect(returned.state).toBe("pausing");
    expect(findJob(get().library.data, "c1/001")?.state).toBe("pausing");
    expect(fake.calls.find((c) => c.name === "pauseJob")?.input).toEqual({ jobId: "j1" });
  });

  it("returns a refusal as an ApiError and changes nothing", async () => {
    const { fake, get } = await start();
    fake.answer("stopJob", () => {
      throw new ApiError("conflict", "Already stopped.");
    });
    await expect(get().stopJob("j1")).rejects.toMatchObject({
      name: "ApiError",
      code: "conflict",
      message: "Already stopped.",
    });
    expect(findJob(get().library.data, "c1/001")?.state).toBe("running");
  });

  it("signs out when a command is answered unauthenticated, and still rejects", async () => {
    const { fake, get } = await start();
    fake.answer("startEdit", () => {
      throw new ApiError("unauthenticated", "Please sign in again.");
    });
    await expect(get().startEdit({ videoId: "c1/001", urgent: false })).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(get().session.data?.user).toBeNull();
  });

  it("refreshes the library after an archive and the list when it is loaded", async () => {
    const { fake, get } = await start();
    fake.answer("archiveVideo", undefined);
    fake.answer("getArchived", []);
    const before = fake.count("getLibrary");
    await get().archiveVideo("c1/001");
    expect(fake.count("getLibrary")).toBe(before + 1);
    expect(fake.count("getArchived")).toBe(0);
    await get().loadArchived();
    await get().archiveVideo("c1/001");
    expect(fake.count("getArchived")).toBe(2);
  });
});

describe("edit log filter", () => {
  const line = (id: number, userId = "admin-id") => ({
    id,
    at: id,
    userId,
    userEmail: `${userId}@example.test`,
    videoLabel: "C / V",
    event: "started",
    message: `Line ${id}`,
  });

  it("reads the own lines by default and the chosen lines after a filter", async () => {
    const { fake, get } = await start("admin");
    fake.answer("getEditLog", { entries: [line(3)], more: false });
    await get().loadEditLog();
    expect(fake.calls.find((c) => c.name === "getEditLog")?.input).toEqual({});
    await get().setEditLogFilter({ kind: "all" });
    await get().setEditLogFilter({ kind: "user", userId: "u2" });
    const asked = fake.calls.filter((c) => c.name === "getEditLog").map((c) => c.input);
    expect(asked).toEqual([{}, { all: true }, { userId: "u2" }]);
    expect(get().editLogFilter).toEqual({ kind: "user", userId: "u2" });
  });

  it("keeps the filter for paging and for a refresh", async () => {
    const { fake, get } = await start("admin");
    fake.answer("getEditLog", (input: { before?: number }) =>
      input.before
        ? { entries: [line(1)], more: false }
        : { entries: [line(3), line(2)], more: true },
    );
    await get().setEditLogFilter({ kind: "all" });
    await get().loadMoreEditLog();
    await get().loadEditLog();
    const asked = fake.calls.filter((c) => c.name === "getEditLog").map((c) => c.input);
    expect(asked).toEqual([{ all: true }, { all: true, before: 2 }, { all: true }]);
    expect(get().editLog.data?.entries.map((e) => e.id)).toEqual([3, 2]);
  });

  it("shows no lines of the old choice while the new one is read, and drops a late answer", async () => {
    const { fake, get } = await start("admin");
    fake.answer("getEditLog", { entries: [line(2)], more: false });
    await get().loadEditLog();
    const slowAll = deferred<unknown>();
    fake.answer("getEditLog", () => slowAll.promise);
    const choosing = get().setEditLogFilter({ kind: "all" });
    expect(get().editLog).toEqual({ data: null, status: "loading", error: null });
    fake.answer("getEditLog", { entries: [line(9, "u2")], more: false });
    const back = get().setEditLogFilter({ kind: "mine" });
    await back;
    slowAll.resolve({ entries: [line(8, "u3")], more: false });
    await choosing;
    expect(get().editLogFilter).toEqual({ kind: "mine" });
    expect(get().editLog.data?.entries.map((e) => e.id)).toEqual([9]);
  });

  it("drops an older page that arrives after the choice changed", async () => {
    const { fake, get } = await start("admin");
    fake.answer("getEditLog", { entries: [line(3), line(2)], more: true });
    await get().loadEditLog();
    const slowOlder = deferred<unknown>();
    fake.answer("getEditLog", () => slowOlder.promise);
    const more = get().loadMoreEditLog();
    fake.answer("getEditLog", { entries: [line(7, "u2")], more: false });
    await get().setEditLogFilter({ kind: "user", userId: "u2" });
    slowOlder.resolve({ entries: [line(1)], more: false });
    await more;
    expect(get().editLog.data?.entries.map((e) => e.id)).toEqual([7]);
  });

  it("goes back to the own lines on sign-out", async () => {
    const { fake, get } = await start("admin");
    fake.answer("getEditLog", { entries: [], more: false });
    await get().setEditLogFilter({ kind: "all" });
    get().signedOut();
    expect(get().editLogFilter).toEqual({ kind: "mine" });
    expect(get().editLog.status).toBe("idle");
  });
});

describe("selectors", () => {
  const lib = libraryOf(video("c1/001", job("j1", "c1/001")), video("c1/002"));

  it("finds a job, a video and a channel", () => {
    expect(findJob(lib, "c1/001")?.id).toBe("j1");
    expect(findJob(lib, "c1/002")).toBeNull();
    expect(findJob(null, "c1/001")).toBeNull();
    expect(findVideo(lib, "c1/002")?.id).toBe("c1/002");
    expect(findVideo(lib, "zz/002")).toBeNull();
    expect(findVideo(lib, "not-a-video-id")).toBeNull();
    const ws = workspaceOf("c1", "c2");
    expect(findChannel(ws, "c2")?.id).toBe("c2");
    expect(findChannel(ws.channels, "c3")).toBeNull();
    expect(findChannel(null, "c1")).toBeNull();
    expect(findChannel(ws, null)).toBeNull();
  });

  const queue = cast<import("./types").QueueView>({
    jobs: [
      entry(job("a", "c1/001", { state: "running" })),
      entry(job("b", "c1/002", { state: "pausing" })),
      entry(job("c", "c1/003", { state: "paused" })),
      entry(job("d", "c1/004", { state: "queued" })),
      entry(job("e", "c1/005", { state: "stopping", queue: "renders" })),
    ],
    queues: [
      { running: 2, waiting: 1 },
      { running: 1, waiting: 4 },
      { running: 0, waiting: 0 },
    ],
  });

  it("finds queue entries and counts", () => {
    expect(findQueueEntry(queue, "d")?.job.state).toBe("queued");
    expect(findQueueEntry(queue, "zz")).toBeNull();
    expect(findQueueEntry(null, "a")).toBeNull();
    // Running, pausing and stopping hold a slot; paused does not.
    expect(ownJobCounts(queue)).toEqual({ running: 3, waiting: 1 });
    expect(ownJobCounts(null)).toEqual({ running: 0, waiting: 0 });
    expect(lineTotals(queue)).toEqual({ running: 3, waiting: 5 });
    expect(ownRunningEdits(queue)).toBe(2);
    expect(ownRunningEdits(null)).toBe(0);
  });

  it("selects the selected video from the state", async () => {
    const { get } = await start();
    expect(selectSelectedVideo(get())).toBeNull();
    get().selectVideo("c1/001");
    expect(selectSelectedVideo(get())?.id).toBe("c1/001");
  });
});

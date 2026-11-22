import { describe, expect, it } from "vitest";
import type {
  NoteUpdatedPayload,
  Timeline,
  TimelineChangedPayload,
  TimelineClip,
  TimelineNote,
} from "../../types";
import { MockBackend } from "../backend";
import type { ScenarioName } from "../scenarios";
import { ADMIN_EMAIL } from "../seed/session";
import { ADMIN_CHANNEL_BEAUTY } from "../seed/workspace";
import { TIMELINE_VIDEOS } from "../seed/timeline";

const ID = TIMELINE_VIDEOS;

function backendOf(scenarios: ScenarioName[] = ["default"], as: "admin" | "user" = "admin") {
  return new MockBackend({ latencyMs: 0, autoTick: false, scenarios, as });
}

const clipOf = (timeline: Timeline, id: string): TimelineClip => {
  const found = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  if (!found) throw new Error(`no clip ${id}`);
  return found;
};

const hasClip = (timeline: Timeline, id: string) =>
  timeline.tracks.some((t) => t.clips.some((c) => c.id === id));

const arolls = (timeline: Timeline) => timeline.tracks.find((t) => t.index === 0)?.clips ?? [];

async function open(backend: MockBackend, videoId: string = ID.default): Promise<Timeline> {
  const result = await backend.openTimeline({ videoId });
  if (!result.timeline) throw new Error("no timeline");
  return result.timeline;
}

/** Runs ticks until `done` holds (at most `max`). */
function tickUntil(backend: MockBackend, done: () => boolean, max = 80): number {
  for (let i = 1; i <= max; i += 1) {
    backend.tick();
    if (done()) return i;
  }
  throw new Error("did not finish");
}

function recorder(backend: MockBackend) {
  const log: string[] = [];
  const notes: NoteUpdatedPayload[] = [];
  const changed: TimelineChangedPayload[] = [];
  const copies: { done: number; running: boolean }[] = [];
  backend.on.noteUpdated((p) => {
    log.push(`note:${p.removed ? "removed" : p.note.state}`);
    notes.push(p);
  });
  backend.on.timelineChanged((p) => {
    log.push("changed");
    changed.push(p);
  });
  backend.on.previewCopiesChanged((p) => {
    log.push("copies");
    copies.push({ done: p.copies.done, running: p.copies.running });
  });
  return { log, notes, changed, copies };
}

const noteInput = (
  videoId: string,
  rest: Partial<Parameters<MockBackend["addTimelineNote"]>[0]>,
) => ({
  videoId,
  frame: 400,
  shape: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 },
  elementId: null,
  prompt: "Tighten this a little.",
  ...rest,
});

describe("mock timeline area: openTimeline", () => {
  it("opens the seeded project with the result shape of the server", async () => {
    const backend = backendOf();
    const result = await backend.openTimeline({ videoId: ID.default });
    expect(result.violations).toEqual([]);
    expect(result.previewCopies).toEqual({ total: 0, done: 0, running: false });
    expect(result.previewUrl).toMatch(/^\/p\/[A-Za-z0-9_-]{43}\/$/);
    const timeline = result.timeline;
    expect(timeline).not.toBeNull();
    if (!timeline) return;
    expect(timeline.fps).toEqual({ num: 30, den: 1 });
    expect([timeline.width, timeline.height]).toEqual([1920, 1080]);
    expect(timeline.locked).toBeNull();
    expect(timeline.revision).toBe(3);
    expect(timeline.canUndo).toBe(true);
    expect(timeline.canRedo).toBe(false);
    expect(timeline.notes).toEqual([]);
    expect(timeline.tracks.map((t) => t.index)).toEqual([4, 3, 2, 1, 0, 10, 11]);
    expect(timeline.duration).toBe(1480);
    const kinds = new Set(timeline.tracks.flatMap((t) => t.clips.map((c) => c.kind)));
    expect([...kinds].sort()).toEqual(
      ["aroll", "broll", "fade", "graphic", "hit", "music", "overlay", "sfx"].sort(),
    );
    backend.dispose();
  });

  it("keeps the end fade clip at the end of the video", async () => {
    const backend = backendOf();
    const timeline = await open(backend);
    const fade = clipOf(timeline, "fade-1");
    expect(fade.start + fade.duration).toBe(timeline.duration);
    backend.dispose();
  });

  it("opens a Short, an empty project and every scenario video", async () => {
    const backend = backendOf(["timeline"]);
    const short = await open(backend, ID.short);
    expect([short.width, short.height]).toEqual([1080, 1920]);
    const empty = await open(backend, ID.empty);
    expect(empty.duration).toBe(0);
    expect(arolls(empty)).toEqual([]);
    expect((await open(backend, ID.long)).duration).toBe(1500);
    backend.dispose();
  });

  it("gives a different preview address to each video", async () => {
    const backend = backendOf(["timeline"]);
    const a = await backend.openTimeline({ videoId: ID.default });
    const b = await backend.openTimeline({ videoId: ID.long });
    expect(a.previewUrl).not.toBe(b.previewUrl);
    backend.dispose();
  });

  it("answers notFound for a video that does not exist or has no project", async () => {
    const backend = backendOf();
    await expect(backend.openTimeline({ videoId: "nope/none" })).rejects.toMatchObject({
      code: "notFound",
    });
    const bare = backend.world.videos.find(
      (v) => !(`${v.channelId}/${v.folderName}` in backend.world.timelines),
    );
    expect(bare).toBeDefined();
    if (!bare) return;
    await expect(
      backend.openTimeline({ videoId: `${bare.channelId}/${bare.folderName}` }),
    ).rejects.toMatchObject({ code: "notFound" });
    backend.dispose();
  });

  it("answers notFound for another user's video, also to an admin", async () => {
    const admin = backendOf(["timeline"]);
    await expect(admin.openTimeline({ videoId: ID.user })).rejects.toMatchObject({
      code: "notFound",
    });
    const user = new MockBackend({
      latencyMs: 0,
      autoTick: false,
      scenarios: ["timeline"],
      as: "user",
      world: admin.world,
    });
    await expect(user.openTimeline({ videoId: ID.default })).rejects.toMatchObject({
      code: "notFound",
    });
    await expect(
      user.editTimeline({
        videoId: ID.default,
        revision: 3,
        op: { type: "delete", clipId: "a-1" },
      }),
    ).rejects.toMatchObject({ code: "notFound" });
    expect((await user.openTimeline({ videoId: ID.user })).timeline?.duration).toBe(600);
    user.dispose();
    admin.dispose();
  });

  it("needs a signed-in user", async () => {
    const backend = new MockBackend({ latencyMs: 0, autoTick: false, scenarios: ["signed-out"] });
    await expect(backend.openTimeline({ videoId: ID.default })).rejects.toMatchObject({
      code: "unauthenticated",
    });
    backend.dispose();
  });

  it("opens a project that breaks the profile with its violations and refuses hand edits", async () => {
    const backend = backendOf(["timeline-broken"]);
    const result = await backend.openTimeline({ videoId: ID.broken });
    expect(result.timeline).not.toBeNull();
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ rule: 4, elementId: "b-1" });
    await expect(
      backend.editTimeline({
        videoId: ID.broken,
        revision: result.timeline?.revision ?? 0,
        op: { type: "delete", clipId: "a-1" },
      }),
    ).rejects.toThrow(/does not follow VidAI's rules/);
    backend.dispose();
  });

  it("opens a project that cannot be read with no timeline", async () => {
    const backend = backendOf(["timeline-broken"]);
    const result = await backend.openTimeline({ videoId: ID.unreadable });
    expect(result.timeline).toBeNull();
    expect(result.previewUrl).toBeNull();
    expect(result.violations[0]?.message).toContain("cannot be opened");
    await expect(backend.getTimeline({ videoId: ID.unreadable })).rejects.toMatchObject({
      code: "notReady",
    });
    await expect(
      backend.editTimeline({
        videoId: ID.unreadable,
        revision: 1,
        op: { type: "delete", clipId: "a-1" },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await expect(
      backend.addTimelineNote(noteInput(ID.unreadable, { frame: 0 })),
    ).rejects.toMatchObject({ code: "notReady" });
    backend.dispose();
  });

  it("getTimeline returns what openTimeline holds", async () => {
    const backend = backendOf();
    const opened = await open(backend);
    expect(await backend.getTimeline({ videoId: ID.default })).toEqual(opened);
    backend.dispose();
  });
});

describe("mock timeline area: hand edits", () => {
  it("trim on the A-roll ripples the clips after it and keeps the fade at the end", async () => {
    const backend = backendOf();
    const before = await open(backend);
    const a2 = clipOf(before, "a-2");
    const after = await backend.editTimeline({
      videoId: ID.default,
      revision: before.revision,
      op: { type: "trim", clipId: "a-2", edge: "end", frame: a2.start + a2.duration - 40 },
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(clipOf(after, "a-2").duration).toBe(a2.duration - 40);
    expect(clipOf(after, "a-3").start).toBe(clipOf(before, "a-3").start - 40);
    expect(after.duration).toBe(before.duration - 40);
    const fade = clipOf(after, "fade-1");
    expect(fade.start + fade.duration).toBe(after.duration);
    expect(after.canUndo).toBe(true);
    const revisions = await backend.listRevisions({ videoId: ID.default });
    expect(revisions[0]).toMatchObject({
      n: 4,
      label: "Trim A-roll",
      userEmail: ADMIN_EMAIL,
      jobId: null,
      current: true,
    });
    backend.dispose();
  });

  it("emits timeline-changed for the owner with the new revision", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    const before = await open(backend);
    await backend.editTimeline({
      videoId: ID.default,
      revision: before.revision,
      op: { type: "delete", clipId: "h-1" },
    });
    expect(events.changed).toEqual([{ videoId: ID.default, revision: before.revision + 1 }]);
    backend.dispose();
  });

  it("refuses a trim that goes past the source or below two frames", async () => {
    const backend = backendOf();
    const before = await open(backend);
    const b1 = clipOf(before, "b-1");
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: before.revision,
        op: { type: "trim", clipId: "b-1", edge: "end", frame: b1.start + 10_000 },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: before.revision,
        op: { type: "trim", clipId: "b-1", edge: "end", frame: b1.start + 1 },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    expect((await backend.getTimeline({ videoId: ID.default })).revision).toBe(before.revision);
    backend.dispose();
  });

  it("moves a clip on another track and refuses an overlap", async () => {
    const backend = backendOf();
    const before = await open(backend);
    const moved = await backend.editTimeline({
      videoId: ID.default,
      revision: before.revision,
      op: { type: "move", clipId: "o-1", frame: 600 },
    });
    expect(clipOf(moved, "o-1").start).toBe(600);
    expect(moved.duration).toBe(before.duration);
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: moved.revision,
        op: { type: "move", clipId: "b-1", frame: clipOf(moved, "g-1").start },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    backend.dispose();
  });

  it("splits a clip in two and refuses a split outside it or of a graphic", async () => {
    const backend = backendOf();
    const before = await open(backend);
    const a1 = clipOf(before, "a-1");
    const split = await backend.editTimeline({
      videoId: ID.default,
      revision: before.revision,
      op: { type: "split", clipId: "a-1", frame: a1.start + 100 },
    });
    expect(arolls(split)).toHaveLength(arolls(before).length + 1);
    expect(split.duration).toBe(before.duration);
    expect(arolls(split)[0]?.duration).toBe(100);
    expect(arolls(split)[1]?.duration).toBe(a1.duration - 100);
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: split.revision,
        op: { type: "split", clipId: "a-3", frame: 5 },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: split.revision,
        op: { type: "split", clipId: "g-1", frame: clipOf(split, "g-1").start + 20 },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    backend.dispose();
  });

  it("deletes a clip, ripples the A-roll and refuses to delete the last A-roll clip", async () => {
    const backend = backendOf();
    let timeline = await open(backend);
    const length = clipOf(timeline, "a-2").duration;
    const duration = timeline.duration;
    timeline = await backend.editTimeline({
      videoId: ID.default,
      revision: timeline.revision,
      op: { type: "delete", clipId: "a-2" },
    });
    expect(hasClip(timeline, "a-2")).toBe(false);
    expect(timeline.duration).toBe(duration - length);
    for (const id of ["a-1", "a-3"]) {
      timeline = await backend.editTimeline({
        videoId: ID.default,
        revision: timeline.revision,
        op: { type: "delete", clipId: id },
      });
    }
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: timeline.revision,
        op: { type: "delete", clipId: "a-4" },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    backend.dispose();
  });

  it("refuses an unknown clip, an unknown op and a broken op", async () => {
    const backend = backendOf();
    const { revision } = await open(backend);
    const edit = (op: unknown) =>
      backend.editTimeline({ videoId: ID.default, revision, op: op as never });
    await expect(edit({ type: "delete", clipId: "zzz" })).rejects.toMatchObject({
      code: "invalidInput",
      message: 'There is no clip "zzz" in this video.',
    });
    await expect(edit({ type: "rotate", clipId: "a-1" })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(
      edit({ type: "trim", clipId: "a-1", edge: "middle", frame: 3 }),
    ).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(edit({ type: "move", clipId: "o-1", frame: 1.5 })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(edit(null)).rejects.toMatchObject({ code: "invalidInput" });
    backend.dispose();
  });

  it("answers conflict when the revision sent is not the current one", async () => {
    const backend = backendOf();
    const { revision } = await open(backend);
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: revision - 1,
        op: { type: "delete", clipId: "h-1" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    backend.dispose();
  });

  it("refuses edits, undo, redo and restore while a job holds the video", async () => {
    const backend = backendOf(["timeline-locked"]);
    const result = await backend.openTimeline({ videoId: ID.locked });
    const timeline = result.timeline;
    expect(timeline?.locked).toMatchObject({ kind: "timelineEdit" });
    expect(timeline?.locked?.jobId).toBeTruthy();
    const videoId = ID.locked;
    await expect(
      backend.editTimeline({
        videoId,
        revision: timeline?.revision ?? 1,
        op: { type: "delete", clipId: "h-1" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(backend.undoTimeline({ videoId })).rejects.toMatchObject({ code: "conflict" });
    await expect(backend.redoTimeline({ videoId })).rejects.toMatchObject({ code: "conflict" });
    await expect(backend.restoreRevision({ videoId, n: 1 })).rejects.toMatchObject({
      code: "conflict",
    });
    backend.dispose();
  });
});

describe("mock timeline area: undo, redo and revisions", () => {
  it("lists the revisions newest first, the baseline being a job's", async () => {
    const backend = backendOf();
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list.map((r) => r.n)).toEqual([3, 2, 1]);
    expect(list.map((r) => r.current)).toEqual([true, false, false]);
    expect(list[2]).toMatchObject({ label: "Edit", userEmail: null });
    expect(list[2]?.jobId).toBeTruthy();
    expect(list[0]).toMatchObject({ label: "Move B-roll", userEmail: ADMIN_EMAIL, jobId: null });
    backend.dispose();
  });

  it("undoes the hand steps and stops at the job's revision, then redoes them in order", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    const start = await open(backend);
    const one = await backend.undoTimeline({ videoId: ID.default });
    expect(one.revision).toBe(2);
    expect(one.canRedo).toBe(true);
    expect(clipOf(one, "b-2").start).toBe(310);
    const two = await backend.undoTimeline({ videoId: ID.default });
    expect(two.revision).toBe(1);
    expect(two.canUndo).toBe(false);
    expect(clipOf(two, "a-1").duration).toBe(300);
    await expect(backend.undoTimeline({ videoId: ID.default })).rejects.toMatchObject({
      code: "conflict",
    });
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list.map((r) => r.undone)).toEqual([true, true, false]);
    expect(list.map((r) => r.current)).toEqual([false, false, true]);
    expect((await backend.redoTimeline({ videoId: ID.default })).revision).toBe(2);
    const back = await backend.redoTimeline({ videoId: ID.default });
    expect(back).toEqual(start);
    expect(back.canRedo).toBe(false);
    await expect(backend.redoTimeline({ videoId: ID.default })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(events.changed.map((e) => e.revision)).toEqual([2, 1, 2, 3]);
    backend.dispose();
  });

  it("drops the undone steps on a new edit and never reuses a number", async () => {
    const backend = backendOf();
    await backend.undoTimeline({ videoId: ID.default });
    const edited = await backend.editTimeline({
      videoId: ID.default,
      revision: 2,
      op: { type: "delete", clipId: "h-1" },
    });
    expect(edited.revision).toBe(4);
    expect(edited.canRedo).toBe(false);
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list.map((r) => r.n)).toEqual([4, 2, 1]);
    await expect(backend.restoreRevision({ videoId: ID.default, n: 3 })).rejects.toMatchObject({
      code: "notFound",
    });
    backend.dispose();
  });

  it("restores an earlier revision as a new step and keeps the others", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    const restored = await backend.restoreRevision({ videoId: ID.default, n: 1 });
    expect(restored.revision).toBe(4);
    expect(clipOf(restored, "a-1").duration).toBe(300);
    expect(restored.canUndo).toBe(true);
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list.map((r) => r.n)).toEqual([4, 3, 2, 1]);
    expect(list[0]).toMatchObject({
      label: "Restored revision 1",
      userEmail: ADMIN_EMAIL,
      jobId: null,
      current: true,
    });
    expect(events.changed).toEqual([{ videoId: ID.default, revision: 4 }]);
    // the restore is a hand step: undo goes back to where the video was
    const undone = await backend.undoTimeline({ videoId: ID.default });
    expect(undone.revision).toBe(3);
    expect(clipOf(undone, "a-1").duration).toBe(280);
    backend.dispose();
  });

  it("refuses to restore the current revision or one that does not exist", async () => {
    const backend = backendOf();
    await expect(backend.restoreRevision({ videoId: ID.default, n: 3 })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(backend.restoreRevision({ videoId: ID.default, n: 99 })).rejects.toMatchObject({
      code: "notFound",
    });
    backend.dispose();
  });

  it("restoring while steps are undone drops the redo history", async () => {
    const backend = backendOf();
    await backend.undoTimeline({ videoId: ID.default });
    await backend.restoreRevision({ videoId: ID.default, n: 1 });
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list.map((r) => r.n)).toEqual([4, 2, 1]);
    expect(list.some((r) => r.undone)).toBe(false);
    backend.dispose();
  });

  it("keeps the newest 200 revisions", async () => {
    const backend = backendOf();
    let timeline = await open(backend);
    for (let i = 0; i < 205; i += 1) {
      timeline = await backend.editTimeline({
        videoId: ID.default,
        revision: timeline.revision,
        op: { type: "move", clipId: "o-1", frame: i % 2 === 0 ? 600 : 100 },
      });
    }
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list).toHaveLength(200);
    expect(list[0]?.n).toBe(208);
    expect(list[199]?.n).toBe(9);
    await expect(backend.restoreRevision({ videoId: ID.default, n: 1 })).rejects.toMatchObject({
      code: "notFound",
    });
    backend.dispose();
  });
});

describe("mock timeline area: change requests", () => {
  it("validates a request with the server's sentences", async () => {
    const backend = backendOf();
    const add = (rest: Partial<Parameters<MockBackend["addTimelineNote"]>[0]>) =>
      backend.addTimelineNote(noteInput(ID.default, rest));
    await expect(add({ frame: 1480 })).rejects.toThrow(/not inside the video/);
    await expect(add({ frame: -1 })).rejects.toMatchObject({ code: "invalidInput" });
    await expect(add({ frame: 1.5 })).rejects.toMatchObject({ code: "invalidInput" });
    await expect(add({ shape: { cx: 2, cy: 0.5, rx: 0.1, ry: 0.1 } })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(add({ shape: { cx: 0.5, cy: 0.5, rx: 0, ry: 0.1 } })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(add({ elementId: "nope" })).rejects.toThrow(/not in this video/);
    await expect(add({ prompt: "   " })).rejects.toMatchObject({
      code: "invalidInput",
      message: "Write what should change.",
    });
    await expect(add({ prompt: "x".repeat(4001) })).rejects.toMatchObject({
      code: "invalidInput",
    });
    expect(backend.world.jobs.filter((j) => j.view.kind === "timelineEdit")).toHaveLength(0);
    expect((await open(backend)).notes).toEqual([]);
    backend.dispose();
  });

  it("takes a request with no ellipse and trims the prompt", async () => {
    const backend = backendOf();
    const note = await backend.addTimelineNote(
      noteInput(ID.default, { shape: null, prompt: "  Make it pop.  ", elementId: "g-1" }),
    );
    expect(note).toMatchObject({
      state: "pending",
      shape: null,
      prompt: "Make it pop.",
      elementId: "g-1",
      jobId: null,
      frame: 400,
    });
    expect((await open(backend)).notes).toEqual([note]);
    backend.dispose();
  });

  it("moves a request from pending to running to done and changes the clip under its frame", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    const before = await open(backend);
    const note = await backend.addTimelineNote(noteInput(ID.default, { frame: 300 }));
    expect(note.state).toBe("pending");
    // the job takes the video at once: hand edits are refused from now on
    const held = await open(backend);
    expect(held.locked).toMatchObject({ kind: "timelineEdit" });
    await expect(
      backend.editTimeline({
        videoId: ID.default,
        revision: held.revision,
        op: { type: "delete", clipId: "h-1" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    tickUntil(backend, () => events.log.includes("note:done"));
    expect(events.log).toEqual(["note:pending", "note:running", "changed", "note:done"]);
    const running = events.notes[1]?.note;
    expect(running?.jobId).toBeTruthy();
    const after = await open(backend);
    expect(after.locked).toBeNull();
    expect(after.notes[0]).toMatchObject({ id: note.id, state: "done", jobId: running?.jobId });
    expect(after.revision).toBe(before.revision + 1);
    expect(clipOf(after, "a-2").label).toContain("(tightened)");
    expect(clipOf(after, "a-2").duration).toBe(clipOf(before, "a-2").duration - 6);
    const list = await backend.listRevisions({ videoId: ID.default });
    expect(list[0]).toMatchObject({
      label: "Change request",
      userEmail: null,
      jobId: running?.jobId,
    });
    // a job's revision is not undone by hand
    expect(after.canUndo).toBe(false);
    backend.dispose();
  });

  it("changes only the motion graphic's clip for a request on a graphic", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    const before = await open(backend);
    await backend.addTimelineNote(noteInput(ID.default, { frame: 220, elementId: "g-1" }));
    tickUntil(backend, () => events.log.includes("note:done"));
    const after = await open(backend);
    expect(clipOf(after, "g-1").file).toBe("compositions/g-1-v2.html");
    expect(clipOf(after, "g-1").source).toBeNull();
    expect(clipOf(after, "g-1").start).toBe(clipOf(before, "g-1").start);
    expect(after.duration).toBe(before.duration);
    expect(clipOf(after, "a-1")).toEqual(clipOf(before, "a-1"));
    backend.dispose();
  });

  it("gives a B-roll request a new source", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    await backend.addTimelineNote(noteInput(ID.default, { frame: 70, elementId: "b-1" }));
    tickUntil(backend, () => events.log.includes("note:done"));
    const after = await open(backend);
    expect(clipOf(after, "b-1").source).toBe("closeup-v2.mp4");
    backend.dispose();
  });

  it("marks the request failed when the run fails, keeps the project, and sends it again", async () => {
    const backend = backendOf();
    backend.world.failJobsWith = "The agent stopped unexpectedly.";
    const events = recorder(backend);
    const before = await open(backend);
    const note = await backend.addTimelineNote(noteInput(ID.default, {}));
    tickUntil(backend, () => events.log.includes("note:failed"));
    expect(events.log).toEqual(["note:pending", "note:running", "note:failed"]);
    const failed = await open(backend);
    expect(failed.revision).toBe(before.revision);
    expect(failed.locked).toBeNull();
    expect(failed.notes[0]).toMatchObject({
      id: note.id,
      state: "failed",
      error: "The agent stopped unexpectedly.",
    });
    const job = backend.world.jobs.find((j) => j.view.id === failed.notes[0]?.jobId);
    expect(job?.view.error).toBe("The agent stopped unexpectedly.");
    // retry: the same request goes back to pending and gets a new job
    backend.world.failJobsWith = null;
    const again = await backend.retryTimelineNote({ videoId: ID.default, noteId: note.id });
    expect(again).toMatchObject({ id: note.id, state: "pending", jobId: null, error: null });
    tickUntil(backend, () => events.log.filter((e) => e === "note:done").length === 1);
    const done = await open(backend);
    expect(done.notes[0]?.state).toBe("done");
    expect(done.notes[0]?.error).toBeNull();
    expect(done.notes[0]?.jobId).not.toBe(failed.notes[0]?.jobId);
    expect(done.revision).toBe(before.revision + 1);
    backend.dispose();
  });

  it("refuses to retry what has not failed and what does not exist", async () => {
    const backend = backendOf();
    const note = await backend.addTimelineNote(noteInput(ID.default, {}));
    await expect(
      backend.retryTimelineNote({ videoId: ID.default, noteId: note.id }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      backend.retryTimelineNote({ videoId: ID.default, noteId: "note-nope" }),
    ).rejects.toMatchObject({ code: "notFound" });
    backend.dispose();
  });

  it("deletes a pending request with a removed event and refuses once it runs", async () => {
    const backend = backendOf();
    const events = recorder(backend);
    const first = await backend.addTimelineNote(noteInput(ID.default, {}));
    await backend.deleteTimelineNote({ videoId: ID.default, noteId: first.id });
    expect(events.log).toEqual(["note:pending", "note:removed"]);
    expect(events.notes[1]?.note.id).toBe(first.id);
    expect((await open(backend)).notes).toEqual([]);
    await expect(
      backend.deleteTimelineNote({ videoId: ID.default, noteId: first.id }),
    ).rejects.toMatchObject({ code: "notFound" });
    // the first request's job still holds the video; let it end, then add one that runs
    tickUntil(backend, () =>
      backend.world.jobs.every((j) => !["queued", "running"].includes(j.view.state)),
    );
    const second = await backend.addTimelineNote(noteInput(ID.default, {}));
    backend.tick();
    await expect(
      backend.deleteTimelineNote({ videoId: ID.default, noteId: second.id }),
    ).rejects.toMatchObject({ code: "conflict" });
    backend.dispose();
  });

  it("makes a request added while a job works wait, then run on its own job", async () => {
    const backend = backendOf(["timeline-locked"]);
    const events = recorder(backend);
    const jobsBefore = backend.world.jobs.length;
    const waiting = await backend.addTimelineNote(noteInput(ID.locked, { frame: 700 }));
    expect(waiting.state).toBe("pending");
    expect(backend.world.jobs).toHaveLength(jobsBefore);
    tickUntil(backend, () => events.log.filter((e) => e === "note:done").length === 2, 200);
    const timeline = (await backend.openTimeline({ videoId: ID.locked })).timeline;
    expect(timeline?.notes.map((n) => n.state)).toEqual(["done", "done"]);
    expect(timeline?.locked).toBeNull();
    expect(new Set(timeline?.notes.map((n) => n.jobId)).size).toBe(2);
    expect(events.log.filter((e) => e === "changed")).toHaveLength(2);
    backend.dispose();
  });

  it("keeps a request pending when its job fails at launch, and asks for no new job", async () => {
    const backend = backendOf(["timeline"]);
    backend.world.adminSettings.maxTimelineEdits = 1;
    await backend.addTimelineNote(noteInput(ID.long, { frame: 300 }));
    const waiting = await backend.addTimelineNote(noteInput(ID.short, { frame: 100 }));
    const jobOf = (videoId: string) =>
      backend.world.jobs.find((j) => j.view.videoId === videoId && j.view.kind === "timelineEdit");
    const running = jobOf(ID.long);
    const queued = jobOf(ID.short);
    expect([running?.view.state, queued?.view.state]).toEqual(["running", "queued"]);
    // the folder is lost while the request's job waits; it fails when its turn comes
    const channel = backend.world.channels.find((c) => c.id === ADMIN_CHANNEL_BEAUTY);
    if (!channel || !running) throw new Error("no channel or job");
    channel.available = false;
    await backend.stopJob({ jobId: running.view.id });
    backend.tick();
    expect(queued?.view).toMatchObject({ state: "failed" });
    const jobs = backend.world.jobs.length;
    for (let i = 0; i < 5; i += 1) backend.tick();
    // as the server: the next request is refused (`resolveVideoType`), so no job on every tick
    expect(backend.world.jobs).toHaveLength(jobs);
    channel.available = true;
    const timeline = (await backend.openTimeline({ videoId: ID.short })).timeline;
    expect(timeline?.notes.find((n) => n.id === waiting.id)).toMatchObject({
      state: "pending",
      jobId: null,
    });
    backend.dispose();
  });

  it("shows a request of every state in the notes scenario, with the lock on", async () => {
    const backend = backendOf(["timeline-notes"]);
    const timeline = (await backend.openTimeline({ videoId: ID.notes })).timeline;
    expect(timeline?.notes.map((n) => n.state)).toEqual(["done", "failed", "running", "pending"]);
    expect(timeline?.notes[2]?.shape).toBeNull();
    expect(timeline?.locked).not.toBeNull();
    backend.dispose();
  });

  it("keeps each user's requests and events apart", async () => {
    const admin = backendOf(["timeline"]);
    const user = new MockBackend({
      latencyMs: 0,
      autoTick: false,
      scenarios: ["timeline"],
      as: "user",
      world: admin.world,
    });
    const adminEvents = recorder(admin);
    const userEvents = recorder(user);
    const note = await user.addTimelineNote(noteInput(ID.user, { frame: 100 }));
    tickUntil(user, () => userEvents.log.includes("note:done"));
    expect(adminEvents.log).toEqual([]);
    expect(note.state).toBe("pending");
    const opened = await user.openTimeline({ videoId: ID.user });
    expect(opened.timeline?.notes[0]?.state).toBe("done");
    // the admin's own video is untouched
    expect((await open(admin)).notes).toEqual([]);
    const edit = await admin.editTimeline({
      videoId: ID.long,
      revision: (await open(admin, ID.long)).revision,
      op: { type: "delete", clipId: "h-1" },
    });
    expect(edit.revision).toBe(2);
    expect(userEvents.changed.filter((e) => e.videoId === ID.long)).toEqual([]);
    expect(adminEvents.changed).toEqual([{ videoId: ID.long, revision: 2 }]);
    user.dispose();
    admin.dispose();
  });

  it("answers notReady when the server cannot start edits and keeps no request", async () => {
    const backend = backendOf(["not-ready"]);
    await expect(backend.addTimelineNote(noteInput(ID.default, {}))).rejects.toMatchObject({
      code: "notReady",
    });
    expect((await open(backend)).notes).toEqual([]);
    backend.dispose();
  });
});

describe("mock timeline area: preview copies", () => {
  it("finishes one copy per tick, with an event each, then stays quiet", async () => {
    const backend = backendOf(["timeline-copies"]);
    const events = recorder(backend);
    const opened = await backend.openTimeline({ videoId: ID.copies });
    expect(opened.previewCopies).toEqual({ total: 3, done: 0, running: true });
    backend.tick();
    backend.tick();
    backend.tick();
    backend.tick();
    expect(events.copies).toEqual([
      { done: 1, running: true },
      { done: 2, running: true },
      { done: 3, running: false },
    ]);
    const after = await backend.openTimeline({ videoId: ID.copies });
    expect(after.previewCopies).toEqual({ total: 3, done: 3, running: false });
    backend.dispose();
  });
});

describe("mock timeline area: types", () => {
  it("returns notes as the wire has them", async () => {
    const backend = backendOf();
    const note: TimelineNote = await backend.addTimelineNote(noteInput(ID.default, {}));
    expect(Object.keys(note).sort()).toEqual(
      [
        "createdAt",
        "elementId",
        "error",
        "frame",
        "id",
        "jobId",
        "prompt",
        "shape",
        "state",
      ].sort(),
    );
    expect(note.error).toBeNull();
    backend.dispose();
  });
});

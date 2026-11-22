import { describe, expect, it } from "vitest";
import type { TimelineNote } from "@/lib/types";
import {
  activeNoteCount,
  adjacentNote,
  noteClip,
  noteExcerpt,
  noteFrame,
  noteStatus,
  notesAtFrame,
  sortNotes,
} from "./notes";
import { sample } from "./testTimeline";

function note(
  id: string,
  frame: number,
  state: TimelineNote["state"],
  rest: Partial<TimelineNote> = {},
): TimelineNote {
  return {
    id,
    frame,
    shape: null,
    elementId: null,
    prompt: `Fix ${id}`,
    state,
    jobId: null,
    error: null,
    createdAt: 1000,
    ...rest,
  };
}

describe("note states", () => {
  it.each([
    ["pending", true, false, true],
    ["running", false, false, true],
    ["done", false, false, false],
    ["failed", false, true, false],
  ] as const)("%s: delete %s, retry %s, active %s", (state, del, retry, active) => {
    const status = noteStatus({ state });
    expect(status).toMatchObject({ state, canDelete: del, canRetry: retry, active, canJump: true });
    expect(status.label.length).toBeGreaterThan(0);
  });
});

describe("order and lookup", () => {
  const notes = [
    note("n3", 50, "done", { createdAt: 5 }),
    note("n1", 10, "pending"),
    note("n2", 50, "failed", { createdAt: 2 }),
  ];
  it("sorts by frame, then creation, without changing the input", () => {
    expect(sortNotes(notes).map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(notes[0]?.id).toBe("n3");
    expect(sortNotes([])).toEqual([]);
    const tie = [note("b", 5, "done"), note("a", 5, "done")];
    expect(sortNotes(tie).map((n) => n.id)).toEqual(["a", "b"]);
  });
  it("finds the notes at a frame and the neighbours", () => {
    expect(notesAtFrame(notes, 50).map((n) => n.id)).toEqual(["n2", "n3"]);
    expect(notesAtFrame(notes, 51)).toEqual([]);
    expect(adjacentNote(notes, 10, 1)?.id).toBe("n2");
    expect(adjacentNote(notes, 50, 1)).toBeNull();
    expect(adjacentNote(notes, 50, -1)?.id).toBe("n1");
    expect(adjacentNote(notes, 10, -1)).toBeNull();
    expect(adjacentNote(notes, 0, 1)?.id).toBe("n1");
  });
  it("counts waiting and running requests", () => {
    expect(activeNoteCount(notes)).toBe(1);
    expect(activeNoteCount([note("a", 0, "running"), note("b", 0, "pending")])).toBe(2);
    expect(activeNoteCount([])).toBe(0);
  });
  it("keeps the frame inside the video and finds the clip", () => {
    const timeline = sample();
    expect(noteFrame(note("a", 9999, "done"), timeline)).toBe(399);
    expect(noteFrame(note("a", 12, "done"), timeline)).toBe(12);
    expect(noteFrame(note("a", -3, "done"), timeline)).toBe(0);
    expect(noteClip(timeline, note("a", 0, "done", { elementId: "b-1" }))?.id).toBe("b-1");
    expect(noteClip(timeline, note("a", 0, "done", { elementId: "gone" }))).toBeNull();
    expect(noteClip(timeline, note("a", 0, "done"))).toBeNull();
  });
  it("cuts a long text for a list", () => {
    expect(noteExcerpt({ prompt: "  Make   it\n shorter " })).toBe("Make it shorter");
    const long = noteExcerpt({ prompt: "x".repeat(200) }, 20);
    expect(Array.from(long)).toHaveLength(20);
    expect(long.endsWith("...")).toBe(true);
  });
});

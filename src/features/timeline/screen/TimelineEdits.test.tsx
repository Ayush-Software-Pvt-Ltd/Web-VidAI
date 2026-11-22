import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioName } from "@/lib/mock";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import { dragToOp, findClip, fitZoom } from "../model";
import { CONFLICT_TITLE, REFUSED_TITLE } from "./useEdits";
import { clipElement, openReady, renderTimeline, type TimelineTest } from "./testSupport";

// Stand-ins for `../requests` (built by another engineer).
vi.mock("../requests", () => ({
  FrameOverlay: () => null,
  RequestsPanel: () => null,
}));

const LONG = TIMELINE_VIDEOS.long;
const px = fitZoom(1500, 600);
const at = (frame: number) => frame * px;
const keys = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, ...init });

async function open(videoId = LONG, scenarios: readonly ScenarioName[] = ["default", "timeline"]) {
  const test = await renderTimeline(videoId, { scenarios: [...scenarios] });
  await openReady(test);
  return test;
}
const revisionOf = (test: TimelineTest, videoId = LONG) =>
  test.store.getState().timelines[videoId]?.timeline.data?.revision ?? -1;
const timelineOf = (test: TimelineTest, videoId = LONG) => {
  const timeline = test.store.getState().timelines[videoId]?.timeline.data;
  if (!timeline) throw new Error("no timeline");
  return timeline;
};
const select = (id: string, clientX = 100) =>
  fireEvent.pointerDown(clipElement(id), { button: 0, clientX });

describe("hand edits by keys and buttons", () => {
  it("deletes the selected clip with Delete, sending the current revision", async () => {
    const test = await open();
    select("b-1");
    const revision = revisionOf(test);
    keys("Delete");
    await waitFor(() => expect(revisionOf(test)).toBe(revision + 1));
    expect(test.calls("editTimeline")).toEqual([
      { videoId: LONG, revision, op: { type: "delete", clipId: "b-1" } },
    ]);
    expect(findClip(timelineOf(test), "b-1")).toBeNull();
    expect(screen.getByText(`Revision ${revision + 1}`)).toBeInTheDocument();
  });

  it("deletes with Backspace and with the button", async () => {
    const test = await open();
    select("b-1");
    keys("Backspace");
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(1));
    select("b-2");
    fireEvent.click(screen.getByRole("button", { name: "Delete clip" }));
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(2));
    expect(test.calls("editTimeline")[1]).toMatchObject({ op: { type: "delete", clipId: "b-2" } });
  });

  it("splits at the playhead with S, Cmd+B and the button", async () => {
    const test = await open();
    select("a-2", at(400));
    test.bridge.emit({ type: "frame", frame: 400 });
    keys("s");
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(1));
    expect(test.calls("editTimeline")[0]).toMatchObject({
      op: { type: "split", clipId: "a-2", frame: 400 },
    });
    const right = timelineOf(test)
      .tracks.find((t) => t.index === 0)
      ?.clips.find((c) => c.start === 400);
    expect(right).toBeDefined();
    select(right?.id ?? "", at(450));
    test.bridge.emit({ type: "frame", frame: 500 });
    keys("b", { metaKey: true });
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(2));
    expect(test.calls("editTimeline")[1]).toMatchObject({ op: { type: "split", frame: 500 } });
    const rest = timelineOf(test)
      .tracks.find((t) => t.index === 0)
      ?.clips.find((c) => c.start === 500);
    select(rest?.id ?? "", at(550));
    test.bridge.emit({ type: "frame", frame: 600 });
    fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(3));
  });

  it("does not offer a split outside the clip, and says why", async () => {
    const test = await open();
    select("a-2", at(400));
    test.bridge.emit({ type: "frame", frame: 10 });
    const button = await screen.findByRole("button", { name: "Split at playhead" });
    expect(button).toBeDisabled();
    expect(button.closest("span")).toHaveAttribute(
      "title",
      "A clip can only be split at a frame inside it.",
    );
    keys("s");
    expect(test.calls("editTimeline")).toHaveLength(0);
  });

  it("uses Ctrl for the keys on Windows", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    );
    const test = await open(TIMELINE_VIDEOS.default, ["default"]);
    keys("z", { metaKey: true });
    expect(test.calls("undoTimeline")).toHaveLength(0);
    keys("z", { ctrlKey: true });
    await waitFor(() => expect(test.calls("undoTimeline")).toHaveLength(1));
  });
});

describe("hand edits by dragging", () => {
  it("trims an edge: one edit on release, with a preview while dragging", async () => {
    const test = await open();
    const edge = clipElement("b-2").querySelector('[data-part="end"]') as HTMLElement;
    const revision = revisionOf(test);
    fireEvent.pointerDown(edge, { button: 0, clientX: at(420) - 2 });
    expect(screen.queryByTestId("drag-preview")).not.toBeInTheDocument();
    fireEvent.pointerMove(window, { clientX: at(400) });
    expect(screen.getByTestId("drag-preview")).toBeInTheDocument();
    expect(test.calls("editTimeline")).toHaveLength(0);
    fireEvent.pointerUp(window, { clientX: at(400) });
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(1));
    expect(test.calls("editTimeline")[0]).toEqual({
      videoId: LONG,
      revision,
      op: { type: "trim", clipId: "b-2", edge: "end", frame: 400 },
    });
    expect(findClip(timelineOf(test), "b-2")?.duration).toBe(70);
    expect(screen.queryByTestId("drag-preview")).not.toBeInTheDocument();
  });

  it("trims to the frame under the pointer under a page zoom (the text size)", async () => {
    const zoom = 1.4;
    const left = 40;
    const test = await renderTimeline(LONG, {
      scenarios: ["default", "timeline"],
      zoom,
      measure: {
        area: { width: 800, height: 450 },
        tracks: { width: 600, height: 240, left },
        body: { width: 1400, height: 800 },
      },
    });
    await openReady(test);
    const screenX = (frame: number) => (left + at(frame)) * zoom;
    const edge = clipElement("b-2").querySelector('[data-part="end"]') as HTMLElement;
    const revision = revisionOf(test);
    fireEvent.pointerDown(edge, { button: 0, clientX: screenX(420) - 2 });
    fireEvent.pointerMove(window, { clientX: screenX(400) });
    fireEvent.pointerUp(window, { clientX: screenX(400) });
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(1));
    expect(test.calls("editTimeline")[0]).toEqual({
      videoId: LONG,
      revision,
      op: { type: "trim", clipId: "b-2", edge: "end", frame: 400 },
    });
  });

  it("moves a clip by its body and snaps its edge to a neighbour, with a snap line", async () => {
    const test = await open();
    const revision = revisionOf(test);
    fireEvent.pointerDown(clipElement("b-2"), { button: 0, clientX: at(375) });
    fireEvent.pointerMove(window, { clientX: at(395) });
    expect(screen.getByTestId("snap-line")).toBeInTheDocument();
    fireEvent.pointerUp(window, { clientX: at(395) });
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(1));
    // The clip's end (440) is within reach of the keyword hit at 450, so it lands there.
    expect(test.calls("editTimeline")[0]).toEqual({
      videoId: LONG,
      revision,
      op: { type: "move", clipId: "b-2", frame: 360 },
    });
  });

  it("stops a drag at a rule, says why, and sends the held frame", async () => {
    const test = await open();
    const clip = findClip(timelineOf(test), "b-2");
    const edge = clipElement("b-2").querySelector('[data-part="end"]') as HTMLElement;
    fireEvent.pointerDown(edge, { button: 0, clientX: at(420) - 2 });
    fireEvent.pointerMove(window, { clientX: at(900) });
    const expected = dragToOp(timelineOf(test), {
      clip: clip as NonNullable<typeof clip>,
      part: "end",
      fromFrame: 420,
      toFrame: 880,
    });
    expect(expected.limit).not.toBeNull();
    expect(screen.getByTestId("drag-note")).toHaveTextContent(expected.limit?.reason ?? "?");
    fireEvent.pointerUp(window, { clientX: at(900) });
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(1));
    const op = (test.calls("editTimeline")[0] as { op: { frame: number } }).op;
    expect(op.frame).toBeLessThan(880);
  });

  it("cancels a drag with Escape", async () => {
    const test = await open();
    const edge = clipElement("b-2").querySelector('[data-part="end"]') as HTMLElement;
    fireEvent.pointerDown(edge, { button: 0, clientX: at(420) - 2 });
    fireEvent.pointerMove(window, { clientX: at(400) });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("drag-preview")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { clientX: at(400) });
    expect(test.calls("editTimeline")).toHaveLength(0);
  });

  it("treats a click without movement as a selection, not an edit", async () => {
    const test = await open();
    select("b-2", at(375));
    fireEvent.pointerUp(window, { clientX: at(375) });
    expect(clipElement("b-2")).toHaveAttribute("aria-pressed", "true");
    expect(test.calls("editTimeline")).toHaveLength(0);
  });

  it("offers no drag while the project is locked", async () => {
    const test = await open(TIMELINE_VIDEOS.locked, ["default", "timeline-locked"]);
    const edge = clipElement("b-1").querySelector('[data-part="end"]') as HTMLElement;
    expect(edge.className).toContain("cursor-not-allowed");
    fireEvent.pointerDown(edge, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 140 });
    expect(screen.queryByTestId("drag-preview")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { clientX: 140 });
    expect(test.calls("editTimeline")).toHaveLength(0);
  });
});

describe("conflict and refusal", () => {
  it("loads the timeline again and says so on a conflict", async () => {
    const test = await open();
    test.refuse("editTimeline", "conflict", "The project changed.");
    select("b-1");
    keys("Delete");
    expect(await screen.findByText(CONFLICT_TITLE)).toBeInTheDocument();
    await waitFor(() => expect(test.calls("getTimeline").length).toBeGreaterThanOrEqual(1));
    expect(findClip(timelineOf(test), "b-1")).not.toBeNull();
  });

  it("shows the server's sentence on a refusal and changes nothing", async () => {
    const test = await open();
    const revision = revisionOf(test);
    test.refuse("editTimeline", "invalidInput", "This clip cannot be made shorter than 2 frames.");
    select("b-1");
    keys("Delete");
    expect(await screen.findByText(REFUSED_TITLE)).toBeInTheDocument();
    expect(screen.getByText("This clip cannot be made shorter than 2 frames.")).toBeInTheDocument();
    expect(revisionOf(test)).toBe(revision);
    expect(findClip(timelineOf(test), "b-1")).not.toBeNull();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});

describe("undo, redo and revisions", () => {
  const withHistory = () => open(TIMELINE_VIDEOS.default, ["default"]);

  it("undoes and redoes with the buttons", async () => {
    const test = await withHistory();
    const id = TIMELINE_VIDEOS.default;
    const revision = revisionOf(test, id);
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(test.calls("undoTimeline")).toEqual([{ videoId: id }]));
    await waitFor(() => expect(revisionOf(test, id)).not.toBe(revision));
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(test.calls("redoTimeline")).toHaveLength(1));
    await waitFor(() => expect(revisionOf(test, id)).toBe(revision));
  });

  it("undoes and redoes with Cmd+Z and Shift+Cmd+Z, never from a text field", async () => {
    const test = await withHistory();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Volume" }), { key: "z", metaKey: true });
    expect(test.calls("undoTimeline")).toHaveLength(0);
    keys("z", { metaKey: true });
    await waitFor(() => expect(test.calls("undoTimeline")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled());
    keys("z", { metaKey: true, shiftKey: true });
    await waitFor(() => expect(test.calls("redoTimeline")).toHaveLength(1));
  });

  it("lists the revisions and restores one after a confirmation", async () => {
    const test = await withHistory();
    const id = TIMELINE_VIDEOS.default;
    fireEvent.click(screen.getByRole("button", { name: "Revisions" }));
    const dialog = await screen.findByRole("dialog", { name: "Revisions" });
    const list = await within(dialog).findByRole("list", { name: "Revisions" });
    const rows = within(list).getAllByRole("listitem");
    const listed = test.store.getState().timelines[id]?.revisions.data ?? [];
    expect(rows).toHaveLength(listed.length);
    expect(within(list).getByText("Current")).toBeInTheDocument();
    const restore = within(list).getAllByRole("button", { name: /Restore revision/ })[0];
    const n = Number(/(\d+)$/.exec(restore?.getAttribute("aria-label") ?? "")?.[1]);
    fireEvent.click(restore as HTMLElement);
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent(`Restore revision ${n}?`);
    expect(confirm).toHaveTextContent("the later revisions stay in the list");
    expect(test.calls("restoreRevision")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(test.calls("restoreRevision")).toEqual([{ videoId: id, n }]));
  });
});

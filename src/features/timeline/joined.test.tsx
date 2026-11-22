/**
 * The timeline screen and its change requests as one screen: the real `TimelineView` with the real
 * `RequestsPanel` and `FrameOverlay` (no stand-in), the screen's fake player (`screen/testSupport`)
 * and the mock backend, jobs ticked by hand.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import { timeCode } from "./model";
import { openReady, renderTimeline, type TimelineTest } from "./screen/testSupport";

const LONG = TIMELINE_VIDEOS.long;
const FPS = { num: 30, den: 1 };
const SCENARIOS = ["default", "timeline"] as const;
const key = (name: string, init: KeyboardEventInit = {}, on: Element = document.body) =>
  fireEvent.keyDown(on, { key: name, ...init });

async function open(videoId = LONG, scenarios: string[] = [...SCENARIOS], frame = 70) {
  const test = await renderTimeline(videoId, { scenarios: scenarios as never });
  await openReady(test);
  if (frame > 0) test.bridge.emit({ type: "frame", frame });
  return test;
}

async function tickUntil(test: TimelineTest, done: () => boolean, max = 40) {
  for (let n = 0; n < max && !done(); n += 1) await act(async () => test.tick());
  // The ticks can run ahead of the screen (its updates arrive through events and refetches), so
  // the last one may still be on its way: wait for it instead of checking once.
  await waitFor(() => {
    expect(done()).toBe(true);
  });
}

const timelineOf = (test: TimelineTest, videoId = LONG) => {
  const found = test.store.getState().timelines[videoId]?.timeline.data;
  if (!found) throw new Error("the timeline is not open");
  return found;
};
const clipOf = (test: TimelineTest, id: string, videoId = LONG) => {
  const found = timelineOf(test, videoId)
    .tracks.flatMap((track) => track.clips)
    .find((clip) => clip.id === id);
  if (!found) throw new Error(`no clip ${id}`);
  return found;
};
const frameBox = () => screen.getByTestId("frame-box");
const overlay = () => screen.getByRole("group", { name: "Draw on the frame" });
const noteRows = () => Array.from(document.querySelectorAll<HTMLElement>("li[data-note]"));
function drag(from: [number, number], to: [number, number]) {
  const at = ([x, y]: [number, number]) => ({
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.pointerDown(overlay(), at(from));
  fireEvent.pointerMove(overlay(), at(to));
  fireEvent.pointerUp(overlay(), at(to));
}
const textField = () => screen.getByRole("textbox", { name: "What should change?" });
const write = (text: string) => fireEvent.change(textField(), { target: { value: text } });
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send" }));

describe("the layout", () => {
  it("has the panel in a 360 px side column with Render Final pinned at its bottom", async () => {
    await open();
    expect(document.querySelector("[data-layout]")).toHaveAttribute("data-layout", "side");
    const panel = screen.getByRole("complementary", { name: "Change requests and Render Final" });
    expect((panel.parentElement as HTMLElement).style.width).toBe("360px");
    const footer = panel.lastElementChild as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Render Final" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Ask for a Change/ })).toBeInTheDocument();
  });

  it("puts the overlay in the frame box, above the player, with the measured box", async () => {
    await open();
    const box = frameBox();
    expect(box.style.width).toBe("800px");
    expect(box.style.height).toBe("450px");
    const [host, over] = Array.from(box.children) as HTMLElement[];
    expect(host?.className).toContain("inset-0");
    expect(over?.className).toContain("inset-0");
    const svg = over?.querySelector("svg");
    expect(svg).toHaveAttribute("width", "800");
    expect(svg).toHaveAttribute("height", "450");
  });

  it("puts the column under the player, which stays pinned, in a narrow window", async () => {
    const test = await renderTimeline(LONG, {
      scenarios: [...SCENARIOS],
      measure: {
        area: { width: 800, height: 450 },
        tracks: { width: 600, height: 240 },
        body: { width: 900, height: 700 },
      },
    });
    await openReady(test);
    const body = document.querySelector("[data-layout]") as HTMLElement;
    expect(body).toHaveAttribute("data-layout", "stacked");
    expect(body.className).toContain("overflow-y-auto");
    const panel = screen.getByRole("complementary", { name: "Change requests and Render Final" });
    expect(body.contains(panel)).toBe(true);
    expect((panel.parentElement as HTMLElement).style.width).toBe("");
    expect(frameBox().parentElement?.parentElement?.className).toContain("sticky");
  });
});

describe("asking for a change", () => {
  it("pauses the player and starts at the playhead from the button and from the key C", async () => {
    const test = await open();
    fireEvent.click(screen.getByRole("button", { name: /Ask for a Change/ }));
    expect(test.bridge.count("pause")).toBe(1);
    expect(screen.getByTestId("ask-time")).toHaveTextContent(timeCode(70, FPS));
    expect(overlay()).toBeInTheDocument();
    key("Escape", {}, textField());
    expect(screen.queryByRole("form", { name: "New change request" })).toBeNull();
    key("c");
    expect(test.bridge.count("pause")).toBe(2);
    expect(screen.getByRole("form", { name: "New change request" })).toBeInTheDocument();
    expect(screen.getByTestId("ask-time")).toHaveTextContent(timeCode(70, FPS));
  });

  it("sends a request, locks the video, and applies it when the job ends", async () => {
    const test = await open();
    key("c");
    drag([200, 100], [400, 250]);
    write("Make the bottle bigger.");
    send();
    await waitFor(() => expect(noteRows()).toHaveLength(1));
    expect(test.calls("addTimelineNote")).toEqual([
      expect.objectContaining({ videoId: LONG, frame: 70, prompt: "Make the bottle bigger." }),
    ]);
    // The video is locked: the line, and hand edits off with their reason.
    expect(await screen.findByTestId("lock-line")).toHaveTextContent(
      "A change request is working on this video",
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    const before = timelineOf(test).revision;
    const reloads = test.bridge.count("reload");
    await tickUntil(test, () => screen.queryByText(/^Applied in revision \d+$/) !== null);
    // The timeline was loaded again at the same frame, and the lock is gone.
    const after = timelineOf(test);
    expect(after.revision).toBe(before + 1);
    await waitFor(() => expect(screen.queryByTestId("lock-line")).toBeNull());
    await waitFor(() => expect(test.bridge.count("reload")).toBe(reloads + 1));
    test.bridge.ready();
    expect(test.bridge.seeks()).toContain(70);
    expect(screen.getByText(`Applied in revision ${after.revision}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revisions" }));
    const list = await screen.findByRole("list", { name: "Revisions" });
    expect(within(list).getByText("Change request")).toBeInTheDocument();
  });

  it("shows the mark on the frame and the marker on the ruler at the same frame", async () => {
    const test = await open(TIMELINE_VIDEOS.notes, ["default", "timeline", "timeline-notes"], 340);
    expect(frameBox().querySelector("[data-note]")).not.toBeNull();
    const markers = screen.getAllByTestId("note-marker");
    expect(markers).toHaveLength(4);
    const tc340 = timeCode(340, timelineOf(test, TIMELINE_VIDEOS.notes).fps);
    expect(markers.filter((m) => m.getAttribute("aria-label")?.includes(tc340))).toHaveLength(1);
    // A frame with no request has no mark on the frame.
    test.bridge.emit({ type: "frame", frame: 600 });
    expect(frameBox().querySelector("[data-note]")).toBeNull();
  });

  it("seeks the player and the playhead from a time code, and walks previous and next", async () => {
    const test = await open(TIMELINE_VIDEOS.notes, ["default", "timeline", "timeline-notes"], 0);
    const fps = timelineOf(test, TIMELINE_VIDEOS.notes).fps;
    fireEvent.click(screen.getByRole("button", { name: `Go to ${timeCode(215, fps)}` }));
    expect(test.bridge.seeks().at(-1)).toBe(215);
    expect(screen.getByTestId("playhead")).toHaveAttribute("aria-valuenow", "215");
    expect(screen.getByTestId("time-code")).toHaveTextContent(timeCode(215, fps));
    fireEvent.click(screen.getByRole("button", { name: "Next request" }));
    expect(test.bridge.seeks().at(-1)).toBe(340);
    expect(screen.getByTestId("playhead")).toHaveAttribute("aria-valuenow", "340");
    fireEvent.click(screen.getByRole("button", { name: "Previous request" }));
    expect(test.bridge.seeks().at(-1)).toBe(215);
    fireEvent.click(screen.getAllByTestId("note-marker")[3] as HTMLElement);
    expect(test.bridge.seeks().at(-1)).toBe(800);
  });

  it("changes only the motion graphic's file after a request about it", async () => {
    const test = await open(LONG, [...SCENARIOS], 210);
    const clips = () => JSON.stringify(timelineOf(test).tracks.flatMap((track) => track.clips));
    const others = () =>
      timelineOf(test)
        .tracks.flatMap((track) => track.clips)
        .filter((clip) => clip.id !== "g-1");
    const beforeOthers = JSON.stringify(others());
    const beforeGraphic = clipOf(test, "g-1");
    expect(beforeGraphic.file).toBe("compositions/g-1.html");
    key("c");
    drag([300, 150], [500, 300]);
    expect(screen.getByText(/This is a motion graphic/)).toBeInTheDocument();
    write("Use the brand colour.");
    send();
    await tickUntil(test, () => screen.queryByText(/^Applied in revision \d+$/) !== null);
    expect(clipOf(test, "g-1").file).not.toBe(beforeGraphic.file);
    expect(clipOf(test, "g-1").source).toBeNull();
    expect(JSON.stringify(others())).toBe(beforeOthers);
    expect(clips()).not.toBe("");
  });

  it("shows why a request failed, and Try Again sends it again", async () => {
    const test = await open();
    test.backend.world.failJobsWith = "The graphic could not be drawn: a font is missing.";
    key("c");
    write("Sharpen the bottle.");
    fireEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    send();
    await tickUntil(test, () => screen.queryByText("Failed") !== null);
    expect(
      within(noteRows()[0] as HTMLElement).getByText(
        "The graphic could not be drawn: a font is missing.",
      ),
    ).toBeInTheDocument();
    test.backend.world.failJobsWith = null;
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await tickUntil(test, () => screen.queryByText(/^Applied in revision \d+$/) !== null);
    expect(screen.queryByText("Failed")).toBeNull();
  });
});

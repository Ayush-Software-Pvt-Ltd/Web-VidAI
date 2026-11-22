import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isValidShape } from "../model";
import { FrameOverlay } from "./FrameOverlay";
import { requestsStoreFor } from "./requestsState";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import { must, notesOf, requestsApp } from "./testApp";

const BOX = { width: 640, height: 360 };

function stubRect(box = BOX) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: box.width,
    bottom: box.height,
    width: box.width,
    height: box.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

async function setup(box = BOX, frame = 0) {
  const app = await requestsApp(TIMELINE_VIDEOS.notes, undefined, { frame });
  app.mount(<FrameOverlay videoId={app.videoId} box={box} />);
  const requests = requestsStoreFor(app.playback);
  return { app, requests };
}

const pointer = (
  target: Element,
  type: "pointerDown" | "pointerMove" | "pointerUp",
  x: number,
  y: number,
) =>
  fireEvent[type](target, {
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  });

describe("FrameOverlay while idle", () => {
  it("lets every pointer event through to the player", async () => {
    await setup();
    const overlay = must(document.querySelector<HTMLElement>("[aria-hidden=true]"));
    expect(overlay.style.pointerEvents).toBe("none");
    expect(overlay.style.touchAction).toBe("");
  });

  it("shows the marks of the requests at the playhead in the colour of their state", async () => {
    const { app } = await setup(BOX, 340);
    const mark = document.querySelector("[data-note]");
    // The request at frame 340 is being worked on and is about a clip, without a shape.
    expect(mark).not.toBeNull();
    expect(must(mark).getAttribute("class")).toContain("text-accent");
    expect(document.querySelectorAll("[data-note]")).toHaveLength(1);
    act(() => {
      app.playback.report({ frame: 40 });
    });
    const done = document.querySelector("[data-note] ellipse");
    expect(done).not.toBeNull();
    expect(must(document.querySelector("[data-note]")?.parentElement).innerHTML).toContain(
      "text-success",
    );
    act(() => {
      app.playback.report({ frame: 41 });
    });
    expect(document.querySelectorAll("[data-note]")).toHaveLength(0);
  });

  it("emphasises the selected request", async () => {
    const { app, requests } = await setup(BOX, 800);
    const note = must(notesOf(app).find((n) => n.frame === 800));
    expect(document.querySelector("[data-selected]")).toBeNull();
    act(() => {
      requests.getState().select(note.id);
    });
    expect(document.querySelector("[data-selected]")).not.toBeNull();
  });
});

describe("FrameOverlay while drawing", () => {
  it("takes the pointer and turns touch scrolling off only while drawing", async () => {
    const { requests } = await setup();
    act(() => {
      requests.getState().start(10);
    });
    const overlay = screen.getByRole("group", { name: "Draw on the frame" });
    expect(overlay.style.pointerEvents).toBe("auto");
    expect(overlay.style.touchAction).toBe("none");
    act(() => {
      requests.getState().cancel();
    });
    expect(document.querySelector("[data-drawing]")).toBeNull();
  });

  it.each([
    { width: 640, height: 360 },
    { width: 360, height: 640 },
    { width: 1000, height: 562 },
  ])("a drag draws an ellipse in fractions of a $width x $height frame", async (box) => {
    stubRect(box);
    const { requests } = await setup(box);
    act(() => {
      requests.getState().start(10);
    });
    const overlay = screen.getByRole("group", { name: "Draw on the frame" });
    pointer(overlay, "pointerDown", box.width * 0.25, box.height * 0.25);
    pointer(overlay, "pointerMove", box.width * 0.5, box.height * 0.5);
    expect(document.querySelectorAll("ellipse").length).toBeGreaterThan(0);
    pointer(overlay, "pointerUp", box.width * 0.75, box.height * 0.5);
    const shape = must(requests.getState().shape);
    expect(shape.cx).toBeCloseTo(0.5, 5);
    expect(shape.cy).toBeCloseTo(0.375, 5);
    expect(shape.rx).toBeCloseTo(0.25, 5);
    expect(shape.ry).toBeCloseTo(0.125, 5);
    expect(isValidShape(shape)).toBe(true);
  });

  it("keeps a drag that leaves the frame inside it", async () => {
    stubRect();
    const { requests } = await setup();
    act(() => {
      requests.getState().start(10);
    });
    const overlay = screen.getByRole("group", { name: "Draw on the frame" });
    pointer(overlay, "pointerDown", 500, 200);
    pointer(overlay, "pointerUp", 900, 700);
    const shape = must(requests.getState().shape);
    expect(shape.cx + shape.rx).toBeLessThanOrEqual(1 + 1e-9);
    expect(shape.cy + shape.ry).toBeLessThanOrEqual(1 + 1e-9);
    expect(isValidShape(shape)).toBe(true);
  });

  it("marks a point with a click, and draws again over an earlier ellipse", async () => {
    stubRect();
    const { requests } = await setup();
    act(() => {
      requests.getState().start(10);
    });
    const overlay = screen.getByRole("group", { name: "Draw on the frame" });
    pointer(overlay, "pointerDown", 320, 180);
    pointer(overlay, "pointerUp", 321, 181);
    const point = must(requests.getState().shape);
    expect(point.cx).toBeCloseTo(0.5, 2);
    expect(point.cy).toBeCloseTo(0.5, 2);
    expect(point.rx).toBeCloseTo(24 / 640, 5);
    pointer(overlay, "pointerDown", 64, 36);
    pointer(overlay, "pointerUp", 192, 108);
    const again = must(requests.getState().shape);
    expect(again.cx).toBeCloseTo(0.2, 5);
    expect(again.rx).toBeCloseTo(0.1, 5);
  });

  it("measures the pointer against the frame when the page is scaled", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 420,
      bottom: 230,
      width: 320,
      height: 180,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    const { requests } = await setup();
    act(() => {
      requests.getState().start(10);
    });
    const overlay = screen.getByRole("group", { name: "Draw on the frame" });
    pointer(overlay, "pointerDown", 100, 50);
    pointer(overlay, "pointerUp", 420, 230);
    const shape = must(requests.getState().shape);
    expect(shape.cx).toBeCloseTo(0.5, 5);
    expect(shape.rx).toBeCloseTo(0.5, 5);
  });

  it("clears the mark when the playhead moves to another frame, and keeps the text", async () => {
    const { app, requests } = await setup();
    act(() => {
      requests.getState().start(10);
      requests.getState().setText("Make it bigger");
      requests.getState().setShape({ cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 });
    });
    act(() => {
      app.playback.report({ frame: 60 });
    });
    expect(requests.getState().frame).toBe(60);
    expect(requests.getState().shape).toBeNull();
    expect(requests.getState().text).toBe("Make it bigger");
    expect(requests.getState().drawing).toBe(true);
  });

  it("pauses the player when drawing starts", async () => {
    const { app, requests } = await setup();
    act(() => {
      requests.getState().start(10);
    });
    expect(app.driver.pauses).toBe(1);
  });
});

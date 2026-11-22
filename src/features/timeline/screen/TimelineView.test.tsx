import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import { LOCKED_REASON, ROW_HEIGHT, fitZoom } from "../model";
import { createPlayerBridge, type PlayerEvent } from "./playerBridge";
import { clipElement, openReady, renderTimeline } from "./testSupport";

// Stand-ins for `../requests` (built by another engineer): the overlay shows the box it got.
vi.mock("../requests", () => ({
  FrameOverlay: ({ videoId, box }: { videoId: string; box: { width: number; height: number } }) => (
    <div data-testid="frame-overlay" data-video={videoId} data-box={`${box.width}x${box.height}`} />
  ),
  RequestsPanel: ({ videoId }: { videoId: string }) => (
    <div data-testid="requests-panel" data-video={videoId} />
  ),
}));

const LONG = TIMELINE_VIDEOS.long;
const px = fitZoom(1500, 600);
const keys = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, ...init });

describe("opening states", () => {
  it("shows loading, then the timeline with its header", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    expect(screen.getByText("Opening the timeline")).toBeInTheDocument();
    await openReady(test);
    expect(await screen.findByRole("heading", { name: /Timeline Long/ })).toBeInTheDocument();
    expect(screen.getByText("Revision 1")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    for (const name of ["Back to Library", "Undo", "Redo", "Revisions", "Keyboard shortcuts"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByTestId("requests-panel")).toHaveAttribute("data-video", LONG);
  });

  it("says so, with a way back, when the video is not the user's", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.user, {
      scenarios: ["default", "timeline"],
    });
    expect(await screen.findByText("This timeline cannot be opened")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try Again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Library" }));
    expect(test.store.getState().view).toBe("main");
  });

  it("says there is no project yet for a video that was not edited", async () => {
    const probe = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    const unedited = probe.store
      .getState()
      .library.data?.channels.flatMap((channel) => channel.videos)
      .find((video) => !video.edited && video.job === null);
    expect(unedited).toBeDefined();
    probe.store.getState().showTimeline(unedited?.id ?? "");
    const test = await renderTimeline(unedited?.id ?? "", { scenarios: ["default", "timeline"] });
    expect(await screen.findByText("There is no project to show yet")).toBeInTheDocument();
    expect(test.bridges).toHaveLength(0);
  });

  it("lists the violations of a project that cannot be read, and plays nothing", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.unreadable, {
      scenarios: ["default", "timeline-broken"],
    });
    expect(await screen.findByText("This project cannot be opened")).toBeInTheDocument();
    const violations = test.store.getState().timelines[TIMELINE_VIDEOS.unreadable]?.violations;
    expect(violations?.length).toBeGreaterThan(0);
    for (const violation of violations ?? []) {
      expect(screen.getByText(violation.message)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("frame-box")).not.toBeInTheDocument();
  });

  it("plays a project with violations, with hand edits off and a callout", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.broken, {
      scenarios: ["default", "timeline-broken"],
    });
    await openReady(test);
    expect(await screen.findByText(/does not follow VidAI's rules yet/)).toBeInTheDocument();
    expect(screen.getByText(/Ask for a change request or run Re-Edit/)).toBeInTheDocument();
    fireEvent.pointerDown(clipElement("b-1"), { button: 0, clientX: 100 });
    const remove = screen.getByRole("button", { name: "Delete clip" });
    expect(remove).toBeDisabled();
    expect(remove.closest("span")).toHaveAttribute("title", expect.stringContaining("rules"));
  });

  it("shows a quiet line while a job holds the project, and switches edits off", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.locked, {
      scenarios: ["default", "timeline-locked"],
    });
    await openReady(test);
    const line = await screen.findByTestId("lock-line");
    expect(line).toHaveTextContent("A change request is working on this video");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    fireEvent.pointerDown(clipElement("b-1"), { button: 0, clientX: 80 });
    expect(screen.getByTestId("drag-note")).toHaveTextContent(LOCKED_REASON);
    await waitFor(() => expect(test.calls("editTimeline")).toHaveLength(0));
  });
});

describe("the player", () => {
  it("sizes the frame box to the letterboxed frame and mounts the overlay in it", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const box = screen.getByTestId("frame-box");
    expect(box).toHaveStyle({ width: "800px", height: "450px" });
    expect(within(box).getByTestId("frame-overlay")).toHaveAttribute("data-box", "800x450");
    expect(test.bridge.host && box.contains(test.bridge.host)).toBe(true);
  });

  it("letterboxes a Short (9:16) frame", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.short, {
      scenarios: ["default", "timeline"],
    });
    await openReady(test);
    expect(screen.getByTestId("frame-box")).toHaveStyle({ width: "253px", height: "450px" });
  });

  it("loads the preview address into the player", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const url = test.store.getState().timelines[LONG]?.previewUrl;
    expect(url).toMatch(/^\/p\//);
    expect(test.bridge.commands).toContain(`load:${url}`);
  });

  it("shows a clear error when the player script cannot be loaded, and loads it again on Try Again", async () => {
    let attempts = 0;
    const test = await renderTimeline(LONG, {
      scenarios: ["default", "timeline"],
      env: {
        loadScript: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve();
        },
      },
    });
    expect(await screen.findByText("The video player could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await openReady(test);
    expect(attempts).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks for a new preview address once, then shows an error with Try Again", async () => {
    const test = await renderTimeline(LONG, {
      scenarios: ["default", "timeline"],
      env: { readyTimeoutMs: 40 },
    });
    await screen.findByTestId("frame-box");
    expect(await screen.findByText("The preview could not be shown.")).toBeInTheDocument();
    expect(test.calls("openTimeline")).toHaveLength(2);
    expect(test.bridge.commands.filter((c) => c.startsWith("load:"))).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(test.calls("openTimeline")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() => expect(test.calls("openTimeline")).toHaveLength(3));
    test.bridge.ready();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows the preview copies line while copies are being made", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.copies, {
      scenarios: ["default", "timeline-copies"],
    });
    await openReady(test);
    const copies = test.store.getState().timelines[TIMELINE_VIDEOS.copies]?.previewCopies;
    expect(copies?.running).toBe(true);
    expect(
      await screen.findByText(
        `Preparing smooth preview (${(copies?.done ?? 0) + 1} of ${copies?.total})`,
        {
          exact: false,
        },
      ),
    ).toBeInTheDocument();
  });

  it("reloads the preview when a preview copy comes ready, so it plays the copy and not the original", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.copies, {
      scenarios: ["default", "timeline-copies"],
    });
    await openReady(test);
    const copies = () => test.store.getState().timelines[TIMELINE_VIDEOS.copies]?.previewCopies;
    expect(copies()?.running).toBe(true);
    expect(test.bridge.count("reload")).toBe(0);
    test.bridge.emit({ type: "frame", frame: 120 });
    const total = copies()?.total ?? 0;
    for (let i = 0; i < total; i++) await test.tick();
    await waitFor(() => expect(copies()?.running).toBe(false));
    // A file the player opened keeps playing from the original, which a browser may play without
    // sound (an audio codec it cannot decode), so every finished copy reloads the player.
    await waitFor(() => expect(test.bridge.count("reload")).toBe(total));
    test.bridge.ready();
    expect(test.bridge.seeks().at(-1)).toBe(120);
  });

  it("reloads the preview after a change and puts the playhead back", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    test.bridge.emit({ type: "frame", frame: 400 });
    fireEvent.pointerDown(clipElement("b-1"), { button: 0, clientX: 90 });
    keys("Delete");
    await waitFor(() => expect(test.bridge.count("reload")).toBe(1));
    test.bridge.ready();
    expect(test.bridge.seeks().at(-1)).toBe(400);
  });
});

describe("transport", () => {
  it("drives the player with the buttons and follows what it reports", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    expect(screen.getByTestId("time-code")).toHaveTextContent("00:00:00");
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(test.bridge.commands).toContain("play");
    test.bridge.emit({ type: "playing", playing: true });
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(test.bridge.commands).toContain("pause");
    test.bridge.emit({ type: "playing", playing: false });
    test.bridge.emit({ type: "frame", frame: 45 });
    expect(screen.getByTestId("time-code")).toHaveTextContent("00:01:15");
    expect(screen.getByRole("slider", { name: "Playhead" })).toHaveAttribute("aria-valuenow", "45");
    fireEvent.click(screen.getByRole("button", { name: "Forward one frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Back one frame" }));
    fireEvent.click(screen.getByRole("button", { name: "To end" }));
    fireEvent.click(screen.getByRole("button", { name: "To start" }));
    expect(test.bridge.seeks()).toEqual([46, 45, 1499, 0]);
  });

  it("does not offer Play before the player is ready", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await screen.findByTestId("frame-box");
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    await openReady(test);
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
  });

  it("answers the keys: Space and K, arrows, Shift arrows, Home and End", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    keys(" ");
    expect(test.bridge.count("play")).toBe(1);
    test.bridge.emit({ type: "playing", playing: true });
    keys("k");
    expect(test.bridge.count("pause")).toBe(1);
    keys("ArrowRight");
    keys("ArrowRight", { shiftKey: true });
    keys("ArrowLeft");
    keys("End");
    keys("Home");
    expect(test.bridge.seeks()).toEqual([1, 11, 10, 1499, 0]);
  });

  it("uses J and L only when the player supports rates", async () => {
    const plain = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(plain);
    keys("l");
    expect(plain.bridge.commands.some((c) => c.startsWith("rate:1.5"))).toBe(false);
    const rated = await renderTimeline(LONG, { scenarios: ["default", "timeline"], rates: true });
    await openReady(rated);
    keys("l");
    await waitFor(() => expect(rated.bridge.commands).toContain("rate:1.5"));
  });

  it("sets the volume and the mute", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.5" } });
    await waitFor(() => expect(test.bridge.commands).toContain("volume:0.5"));
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => expect(test.bridge.commands).toContain("muted:true"));
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
  });

  it("does not take keys while a text field has focus", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "ArrowRight" });
    field.remove();
    expect(test.bridge.seeks()).toEqual([]);
  });
});

describe("ruler, zoom and tracks", () => {
  it("scrubs: seeks on press, follows the drag throttled, and lands on the release frame", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const ruler = screen.getByTestId("ruler");
    fireEvent.pointerDown(ruler, { button: 0, clientX: 100 });
    fireEvent.pointerMove(ruler, { clientX: 200 });
    fireEvent.pointerUp(ruler, { clientX: 300 });
    const seeks = test.bridge.seeks();
    expect(seeks[0]).toBe(Math.round(100 / px));
    expect(seeks.at(-1)).toBe(Math.round(300 / px));
    expect(seeks.length).toBeLessThanOrEqual(3);
    expect(screen.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
      "aria-valuenow",
      String(Math.round(300 / px)),
    );
  });

  // The app's text size is a CSS `zoom` on <html> (1.15 by default, up to 1.54): the pointer and
  // `getBoundingClientRect` count in screen px, layout (and so the clip widths) in CSS px.
  it.each([1.15, 1.4, 1.54])(
    "scrubs to the frame under the pointer under a page zoom of %s",
    async (zoom) => {
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
      const ruler = screen.getByTestId("ruler");
      const screenX = (layoutX: number) => (left + layoutX) * zoom;
      fireEvent.pointerDown(ruler, { button: 0, clientX: screenX(100) });
      expect(test.bridge.seeks().at(-1)).toBe(Math.round(100 / px));
      fireEvent.pointerMove(ruler, { clientX: screenX(250) });
      fireEvent.pointerUp(ruler, { clientX: screenX(300) });
      expect(test.bridge.seeks().at(-1)).toBe(Math.round(300 / px));
      // The playhead is drawn under the pointer (layout px, like the clips).
      const head = screen.getByTestId("playhead");
      expect(Number.parseFloat(head.style.left)).toBeCloseTo(Math.round(300 / px) * px, 3);
    },
  );

  it("draws every track with its clips, and a marker per change request that seeks on click", async () => {
    const test = await renderTimeline(TIMELINE_VIDEOS.notes, {
      scenarios: ["default", "timeline-notes"],
    });
    await openReady(test);
    expect(screen.getByText("A-roll")).toBeInTheDocument();
    expect(clipElement("a-1")).toHaveAttribute("data-kind", "aroll");
    expect(clipElement("a-1")).toHaveAttribute("title", expect.stringContaining("Intro"));
    const markers = screen.getAllByTestId("note-marker");
    const notes = test.store.getState().timelines[TIMELINE_VIDEOS.notes]?.timeline.data?.notes;
    expect(markers).toHaveLength(notes?.length ?? -1);
    fireEvent.click(markers[0] as HTMLElement);
    expect(test.bridge.seeks()).toHaveLength(1);
  });

  it("zooms with the buttons, with Ctrl and the wheel around the pointer, and fits", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const width = () => Number.parseFloat(clipElement("a-1").style.width);
    const fitted = width();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = width();
    expect(zoomed).toBeGreaterThan(fitted * 1.4);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(width()).toBeCloseTo(fitted, 3);
    const tracks = document.querySelector<HTMLElement>('[data-measure="tracks"]');
    fireEvent.wheel(tracks as HTMLElement, { ctrlKey: true, deltaY: -100, clientX: 300 });
    expect(width()).toBeGreaterThan(fitted * 1.4);
    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(width()).toBeCloseTo(fitted, 3);
    expect(test.bridge.seeks()).toEqual([]);
  });

  it("renders only the clips near the viewport when zoomed in", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const before = document.querySelectorAll("[data-clip]").length;
    for (let n = 0; n < 6; n += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    expect(document.querySelectorAll("[data-clip]").length).toBeLessThan(before);
  });

  it("renders only the clips near the viewport when a timeline has several hundred cuts", async () => {
    const test = await renderTimeline(LONG, {
      scenarios: ["default", "timeline"],
      prepare: (backend) => {
        const sim = backend.world.timelines[LONG];
        const track = sim?.timeline.tracks.find((t) => t.index === 1);
        const sample = track?.clips[0];
        if (!track || !sample) throw new Error("no b-roll track");
        track.clips = Array.from({ length: 700 }, (_, i) => ({
          ...sample,
          id: `x-${i}`,
          label: `Cut ${i}`,
          start: Math.floor(i * 2.1),
          duration: 2,
        }));
      },
    });
    await openReady(test);
    for (let n = 0; n < 8; n += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    expect(document.querySelectorAll("[data-clip]").length).toBeLessThan(120);
    expect(document.querySelectorAll("[data-clip]").length).toBeGreaterThan(0);
  });

  it("scrolls with the wheel and keeps a playing playhead in view", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    for (let n = 0; n < 4; n += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    test.bridge.emit({ type: "frame", frame: 1400 });
    const left = () => Number.parseFloat(screen.getByTestId("playhead").style.left);
    await waitFor(() => expect(left()).toBeLessThanOrEqual(600));
    expect(left()).toBeGreaterThanOrEqual(0);
    const tracks = document.querySelector<HTMLElement>('[data-measure="tracks"]');
    const was = left();
    fireEvent.wheel(tracks as HTMLElement, { deltaY: -50 });
    expect(left()).toBeGreaterThan(was);
  });

  it("selects a clip by click, moves between clips with the arrows, and deselects on empty space", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    fireEvent.pointerDown(clipElement("a-2"), { button: 0, clientX: 150 });
    fireEvent.pointerUp(window);
    expect(clipElement("a-2")).toHaveAttribute("aria-pressed", "true");
    clipElement("a-2").focus();
    fireEvent.keyDown(clipElement("a-2"), { key: "ArrowRight" });
    await waitFor(() => expect(clipElement("a-3")).toHaveAttribute("aria-pressed", "true"));
    expect(clipElement("a-3")).toHaveFocus();
    fireEvent.keyDown(clipElement("a-3"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-clip][aria-pressed="true"]')).toHaveLength(1),
    );
    expect(clipElement("a-3")).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerDown(screen.getByTestId("rows"), { button: 0, clientX: 590 });
    expect(document.querySelectorAll('[data-clip][aria-pressed="true"]')).toHaveLength(0);
    expect(test.bridge.seeks()).toEqual([]);
  });

  it("stacks the tracks like Premiere Pro: top layer first, the A-roll above the sound, headers in line with the lanes", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    const names = [
      [4, "End fade"],
      [3, "Keyword hits"],
      [2, "Overlays"],
      [1, "B-roll and graphics"],
      [0, "A-roll"],
      [10, "Sound 1"],
      [11, "Sound 2"],
    ] as const;
    const headers = screen.getAllByTestId("track-header");
    const lanes = screen.getAllByTestId("track-lane");
    expect(headers.map((h) => [Number(h.dataset.track), h.textContent])).toEqual(
      names.map((n) => [...n]),
    );
    expect(lanes.map((l) => Number(l.dataset.track))).toEqual(names.map(([index]) => index));
    lanes.forEach((lane, i) => {
      expect(lane.style.top).toBe(`${i * ROW_HEIGHT}px`);
      expect(headers[i]?.style.height).toBe(`${ROW_HEIGHT}px`);
    });
    const laneOf = (id: string) =>
      Number(clipElement(id).closest<HTMLElement>("[data-track]")?.dataset.track);
    expect(laneOf("a-1")).toBe(0);
    expect(laneOf("b-1")).toBe(1);
    // ArrowUp goes to the layer above the A-roll (B-roll), ArrowDown to the sound below it.
    clipElement("a-2").focus();
    fireEvent.keyDown(clipElement("a-2"), { key: "ArrowUp" });
    await waitFor(() =>
      expect(document.querySelector('[data-clip][aria-pressed="true"]')).toHaveAttribute(
        "data-kind",
        "broll",
      ),
    );
    fireEvent.keyDown(clipElement("a-2"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(["music", "sfx"]).toContain(
        document.querySelector('[data-clip][aria-pressed="true"]')?.getAttribute("data-kind"),
      ),
    );
  });

  it("opens the keyboard help", async () => {
    const test = await renderTimeline(LONG, { scenarios: ["default", "timeline"] });
    await openReady(test);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Play or pause")).toBeInTheDocument();
  });
});

describe("the real player bridge", () => {
  function setup() {
    const host = document.createElement("div");
    document.body.append(host);
    const bridge = createPlayerBridge(host);
    const events: PlayerEvent[] = [];
    bridge.subscribe((event) => events.push(event));
    bridge.load("/p/token/", { num: 30, den: 1 });
    const element = host.querySelector("hyperframes-player") as HTMLElement;
    return { host, bridge, events, element };
  }

  it("turns the element's events into frames and ignores anything malformed", () => {
    const { bridge, events, element, host } = setup();
    expect(element.getAttribute("src")).toBe("/p/token/");
    element.dispatchEvent(new CustomEvent("timeupdate", { detail: { currentTime: 2 } }));
    element.dispatchEvent(
      new CustomEvent("timeupdate", { detail: { currentTime: "<img onerror>" } }),
    );
    element.dispatchEvent(new CustomEvent("timeupdate", { detail: { currentTime: Number.NaN } }));
    element.dispatchEvent(new CustomEvent("timeupdate", { detail: null }));
    expect(events).toEqual([{ type: "frame", frame: 60 }]);
    bridge.destroy();
    host.remove();
  });

  it("ignores messages from a foreign frame", () => {
    const { bridge, events, host } = setup();
    const foreign = document.createElement("iframe");
    document.body.append(foreign);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: foreign.contentWindow,
          data: { source: "hf-preview", type: "timeupdate", currentTime: 5 },
        }),
      );
    });
    expect(events).toEqual([]);
    foreign.remove();
    bridge.destroy();
    host.remove();
  });
});

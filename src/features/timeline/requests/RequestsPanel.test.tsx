import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioName } from "@/lib/mock";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import { FrameOverlay } from "./FrameOverlay";
import { RequestsPanel } from "./RequestsPanel";
import { requestsStoreFor } from "./requestsState";
import { must, notesOf, requestsApp } from "./testApp";

const BOX = { width: 640, height: 360 };

function stubRect() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: BOX.width,
    bottom: BOX.height,
    width: BOX.width,
    height: BOX.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

async function setup(
  videoId: string = TIMELINE_VIDEOS.long,
  frame = 0,
  scenarios?: ScenarioName[],
) {
  const app = await requestsApp(videoId, scenarios, { frame });
  app.mount(
    <>
      <FrameOverlay videoId={app.videoId} box={BOX} />
      <RequestsPanel videoId={app.videoId} />
    </>,
  );
  return { app, requests: requestsStoreFor(app.playback) };
}

const ask = () => userEvent.click(screen.getByRole("button", { name: /Ask for a Change/ }));
const drag = (from: [number, number], to: [number, number]) => {
  const overlay = screen.getByRole("group", { name: "Draw on the frame" });
  const at = ([x, y]: [number, number]) => ({
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.pointerDown(overlay, at(from));
  fireEvent.pointerMove(overlay, at(to));
  fireEvent.pointerUp(overlay, at(to));
};
const type = (text: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), {
    target: { value: text },
  });

describe("asking for a change", () => {
  it("pauses the player, turns drawing on and names the frame", async () => {
    const { app, requests } = await setup(TIMELINE_VIDEOS.long, 215);
    expect(screen.queryByRole("form", { name: "New change request" })).toBeNull();
    await ask();
    expect(app.driver.pauses).toBe(1);
    expect(requests.getState().drawing).toBe(true);
    const form = screen.getByRole("form", { name: "New change request" });
    expect(within(form).getByText("00:07:05")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Draw on the frame" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ask for a Change/ })).toBeDisabled();
  });

  it("starts with the key C unless a text field has focus or a modifier is held", async () => {
    const { app, requests } = await setup();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await userEvent.keyboard("c");
    expect(requests.getState().drawing).toBe(false);
    input.blur();
    input.remove();
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(requests.getState().drawing).toBe(false);
    await userEvent.keyboard("c");
    expect(requests.getState().drawing).toBe(true);
    expect(app.driver.pauses).toBe(1);
    // The text field of the form now has focus, so a typed c is text.
    await userEvent.keyboard("c");
    expect(must(document.activeElement)).toBe(
      screen.getByRole("textbox", { name: "What should change?" }),
    );
    expect(requests.getState().text).toBe("c");
  });

  it("sends an ellipse in fractions with the clip under the mark, and selects the new request", async () => {
    stubRect();
    const { app, requests } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    drag([160, 90], [480, 270]);
    expect(screen.getByRole("radio", { name: "B-roll: Bottle close-up" })).toBeChecked();
    type("  Make the bottle label bigger  ");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
    const note = must(notesOf(app)[0]);
    expect(note).toMatchObject({
      frame: 70,
      elementId: "b-1",
      prompt: "Make the bottle label bigger",
      state: "pending",
      shape: { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25 },
    });
    expect(requests.getState().drawing).toBe(false);
    expect(requests.getState().selectedId).toBe(note.id);
    expect(screen.queryByRole("form", { name: "New change request" })).toBeNull();
    expect(screen.getByText("Make the bottle label bigger")).toBeInTheDocument();
  });

  it("names a motion graphic and says what happens to it", async () => {
    stubRect();
    const { app } = await setup(TIMELINE_VIDEOS.long, 215);
    await ask();
    drag([100, 100], [300, 200]);
    expect(screen.getByRole("radio", { name: "Motion graphic: Price card" })).toBeChecked();
    expect(
      screen.getByText(/Only this graphic is made again, with your request, and replaced/),
    ).toBeInTheDocument();
    type("Use the brand colour");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
    expect(must(notesOf(app)[0]).elementId).toBe("g-1");
  });

  it("lets the user choose another clip or the whole picture", async () => {
    stubRect();
    const { app } = await setup(TIMELINE_VIDEOS.long, 215);
    await ask();
    drag([100, 100], [300, 200]);
    await userEvent.click(
      screen.getByRole("radio", {
        name: "A-roll: Intro",
      }),
    );
    expect(screen.queryByText(/Only this graphic is made again/)).toBeNull();
    type("Cut the shadow");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
    expect(must(notesOf(app)[0]).elementId).toBe("a-1");
  });

  it("sends the whole frame without a shape", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    expect(screen.getByText("The whole frame.")).toBeInTheDocument();
    type("Make everything warmer");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
    expect(must(notesOf(app)[0])).toMatchObject({ shape: null, elementId: null, frame: 70 });
  });

  it("marks a point with a click", async () => {
    stubRect();
    const { app } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    drag([320, 180], [321, 181]);
    type("Remove this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
    const shape = must(must(notesOf(app)[0]).shape);
    expect(shape.cx).toBeCloseTo(0.5, 2);
    expect(shape.rx).toBeCloseTo(24 / 640, 5);
  });

  it("sends with Cmd+Enter", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    await userEvent.click(screen.getByRole("textbox", { name: "What should change?" }));
    await userEvent.keyboard("Brighter");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
  });

  it("uses Ctrl+Enter, not the Windows key, on Windows", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    const { app } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    await userEvent.click(screen.getByRole("textbox", { name: "What should change?" }));
    await userEvent.keyboard("Brighter");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(notesOf(app)).toHaveLength(0);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
  });
});

describe("validation", () => {
  it("asks for text and for an area after a Send, and sends nothing", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long, 700);
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Write what should change.")).toBeInTheDocument();
    expect(
      screen.getByText("Circle what should change on the picture, or choose Whole frame."),
    ).toBeInTheDocument();
    expect(notesOf(app)).toHaveLength(0);
  });

  it("treats a text of blanks as empty", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    type("   \n  ");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Write what should change.")).toBeInTheDocument();
    expect(notesOf(app)).toHaveLength(0);
  });

  it("allows 4000 characters, refuses 4001 and shows the count near the limit", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    expect(screen.queryByText(/ \/ 4000/)).toBeNull();
    type("x".repeat(4001));
    expect(screen.getByText("4001 / 4000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("The text can have at most 4000 characters.")).toBeInTheDocument();
    expect(notesOf(app)).toHaveLength(0);
    type("x".repeat(4000));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
  });
});

describe("a refusal of the server", () => {
  it("keeps the sentence, the text and the mark in the form", async () => {
    stubRect();
    const { app, requests } = await setup(TIMELINE_VIDEOS.long, 70);
    app.backend.world.readinessUser = {
      problem: "claudeLoggedOut",
      message: "Claude is not signed in on this server. Ask an admin.",
    };
    await ask();
    drag([160, 90], [480, 270]);
    type("Make it bigger");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Claude is not signed in on this server. Ask an admin.",
    );
    expect(requests.getState().drawing).toBe(true);
    expect(requests.getState().shape).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "What should change?" })).toHaveValue(
      "Make it bigger",
    );
    expect(notesOf(app)).toHaveLength(0);
    // The user can send again once the server is ready.
    app.backend.world.readinessUser = { problem: null, message: null };
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(1);
    });
  });
});

describe("cancelling", () => {
  it("Cancel throws the request away", async () => {
    const { requests } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    type("Something");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(requests.getState()).toMatchObject({ drawing: false, text: "", shape: null });
    expect(screen.queryByRole("form", { name: "New change request" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Draw on the frame" })).toBeNull();
  });

  it("Esc cancels from the text field and from the picture", async () => {
    const { requests } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    type("Something");
    await userEvent.keyboard("{Escape}");
    expect(requests.getState().drawing).toBe(false);
    await userEvent.keyboard("c");
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("{Escape}");
    expect(requests.getState().drawing).toBe(false);
  });
});

describe("the frame changing while drawing", () => {
  it("moves the request to the new frame and clears the mark without asking", async () => {
    stubRect();
    const { app, requests } = await setup(TIMELINE_VIDEOS.long, 70);
    await ask();
    drag([160, 90], [480, 270]);
    type("Bigger");
    act(() => {
      app.playback.report({ frame: 215 });
    });
    const form = screen.getByRole("form", { name: "New change request" });
    expect(within(form).getByText("00:07:05")).toBeInTheDocument();
    expect(requests.getState().shape).toBeNull();
    expect(screen.getByRole("textbox", { name: "What should change?" })).toHaveValue("Bigger");
    expect(screen.getByText(/Drag on the picture to circle/)).toBeInTheDocument();
  });
});

describe("asking while the project is busy", () => {
  it("says the request is sent when the video is free, and the server takes it", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.locked, 90, ["timeline", "timeline-locked"]);
    await ask();
    expect(
      screen.getByText(/Your request is saved and sent as soon as the video is free/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    type("Also brighten the sky");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(notesOf(app)).toHaveLength(2);
    });
  });
});

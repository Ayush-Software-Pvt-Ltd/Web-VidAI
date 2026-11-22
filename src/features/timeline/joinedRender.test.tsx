/** Render Final, the keys and the missing preview of the timeline screen, with the real panel. */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import { openReady, renderTimeline, type TimelineTest } from "./screen/testSupport";

const LONG = TIMELINE_VIDEOS.long;
const renderButton = () => screen.getByRole("button", { name: "Render Final" });
const textField = () => screen.getByRole("textbox", { name: "What should change?" });

async function open(videoId = LONG, scenarios: string[] = ["default", "timeline"]) {
  const test = await renderTimeline(videoId, { scenarios: scenarios as never });
  await openReady(test);
  return test;
}
async function tickUntil(test: TimelineTest, done: () => boolean, max = 60) {
  for (let n = 0; n < max && !done(); n += 1) await act(async () => test.tick());
  // The ticks can run ahead of the screen (its updates arrive through events and refetches), so
  // the last one may still be on its way: wait for it instead of checking once.
  await waitFor(() => {
    expect(done()).toBe(true);
  });
}

describe("Render Final in the timeline screen", () => {
  it("waits with its reason while a request waits, then renders and lists the finished video", async () => {
    const test = await open();
    expect(renderButton()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Ask for a Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "Whole Frame" }));
    fireEvent.change(textField(), { target: { value: "Brighter." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(renderButton()).toBeDisabled());
    expect(renderButton()).toHaveAccessibleDescription(/change request is applied/);
    await tickUntil(test, () => screen.queryByText(/^Applied in revision \d+$/) !== null);
    await waitFor(() => expect(renderButton()).toBeEnabled());
    fireEvent.click(renderButton());
    const dialog = await screen.findByRole("dialog", { name: "Render Final" });
    const submit = within(dialog).getAllByRole("button", { name: "Render Final" }).at(-1);
    if (!submit) throw new Error("the sheet has no Render Final button");
    fireEvent.click(submit);
    await waitFor(() => expect(renderButton()).toBeDisabled());
    expect(renderButton()).toHaveAccessibleDescription(/final render of this video/);
    expect(screen.queryByTestId("lock-line")).not.toBeNull();
    await tickUntil(test, () => screen.queryByText("Finished videos") !== null, 80);
    await waitFor(() => expect(renderButton()).toBeEnabled());
    expect(screen.queryByTestId("lock-line")).toBeNull();
  });
});

describe("keys while the request's text field has focus", () => {
  it("types instead of acting, and Space does not play", async () => {
    const test = await open();
    test.bridge.emit({ type: "frame", frame: 70 });
    fireEvent.keyDown(document.body, { key: "c" });
    const field = textField();
    field.focus();
    const plays = test.bridge.count("play");
    const seeks = test.bridge.seeks().length;
    const revision = test.store.getState().timelines[LONG]?.timeline.data?.revision;
    for (const key of ["s", " ", "j", "k", "l", "Backspace", "ArrowLeft", "ArrowRight", "c"]) {
      fireEvent.keyDown(field, { key });
    }
    expect(test.bridge.count("play")).toBe(plays);
    expect(test.bridge.seeks()).toHaveLength(seeks);
    expect(test.store.getState().timelines[LONG]?.timeline.data?.revision).toBe(revision);
    expect(screen.getByRole("form", { name: "New change request" })).toBeInTheDocument();
  });

  it("lets Escape in the text field cancel the drawing and nothing else", async () => {
    const test = await open();
    fireEvent.keyDown(document.body, { key: "c" });
    fireEvent.keyDown(textField(), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "New change request" })).toBeNull();
    expect(screen.getByRole("button", { name: /Ask for a Change/ })).toBeInTheDocument();
    expect(test.calls("addTimelineNote")).toHaveLength(0);
  });
});

describe("a timeline without a preview", () => {
  it("says why there is no picture instead of loading for ever", async () => {
    const test = await open();
    // The server answers `previewUrl: null` when it has no preview tool.
    act(() => {
      test.store.setState((state) => {
        const entry = state.timelines[LONG];
        return entry
          ? { timelines: { ...state.timelines, [LONG]: { ...entry, previewUrl: null } } }
          : state;
      });
    });
    const note = await screen.findByTestId("no-preview");
    expect(note).toHaveTextContent("There is no preview of this video");
    expect(note).toHaveTextContent(/install HyperFrames/);
    expect(screen.queryByText("Loading the preview")).toBeNull();
  });
});

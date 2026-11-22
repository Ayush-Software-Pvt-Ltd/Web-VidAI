import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import type { JobView, TimelineNote } from "@/lib/types";
import { FAILED_FALLBACK, failureSentence } from "./requestsState";
import { RequestsPanel } from "./RequestsPanel";
import { requestsStoreFor } from "./requestsState";
import { must, notesOf, requestsApp, type RequestsApp } from "./testApp";

async function setup(videoId: string = TIMELINE_VIDEOS.notes, frame = 0) {
  const app = await requestsApp(videoId, undefined, { frame });
  app.mount(<RequestsPanel videoId={app.videoId} />);
  return { app, requests: requestsStoreFor(app.playback) };
}

const rows = () => screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-note"));
const rowAt = (prefix: string) =>
  must(
    rows().find((row) => row.textContent.includes(prefix)),
    `row ${prefix}`,
  );

async function addNote(app: RequestsApp, frame: number, prompt = "Make it brighter") {
  await act(async () => {
    await app.store
      .getState()
      .addTimelineNote(app.videoId, { frame, shape: null, elementId: null, prompt });
  });
}

describe("the list", () => {
  it("explains the feature in two sentences when there are no requests", async () => {
    await setup(TIMELINE_VIDEOS.long);
    expect(
      screen.getByText(
        "Pause on a frame and circle what should look different, then say how. VidAI changes only that part and the timeline updates.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next request" })).toBeNull();
  });

  it("lists every request by frame with its time code, text and state", async () => {
    await setup();
    const list = rows();
    expect(list).toHaveLength(4);
    expect(within(must(list[0])).getByText("00:01:10")).toBeInTheDocument();
    expect(within(must(list[0])).getByText("Done")).toBeInTheDocument();
    expect(
      within(must(list[0])).getByText("Remove the shadow under the chin."),
    ).toBeInTheDocument();
    expect(within(must(list[1])).getByText("Failed")).toBeInTheDocument();
    expect(within(must(list[2])).getByText("Working on it")).toBeInTheDocument();
    expect(within(must(list[3])).getByText("Waiting")).toBeInTheDocument();
  });

  it("names the clip a request is about", async () => {
    await setup();
    expect(within(rowAt("price card")).getByText("Motion graphic: Price card")).toBeInTheDocument();
    expect(within(rowAt("sparkle")).getByText("The whole picture")).toBeInTheDocument();
  });

  it("shows a running request's progress and a waiting one's reason", async () => {
    await setup();
    const running = rowAt("slower swatch");
    expect(within(running).getByRole("progressbar")).toBeInTheDocument();
    expect(within(rowAt("sparkle")).getByText(/Waiting for the other work/)).toBeInTheDocument();
  });

  it("says a request waits for the video's other work while a change request runs", async () => {
    const app = await requestsApp(TIMELINE_VIDEOS.locked, ["timeline", "timeline-locked"]);
    app.mount(<RequestsPanel videoId={app.videoId} />);
    await addNote(app, 100);
    const row = must(rows().find((r) => r.textContent.includes("Make it brighter")));
    expect(within(row).getByText("Waiting")).toBeInTheDocument();
    expect(
      within(row).getByText("Waiting for the other work on this video to finish."),
    ).toBeInTheDocument();
    expect(within(must(rows()[0])).getByText("Working on it")).toBeInTheDocument();
  });

  it("shows the sentence a failed request carries, whether or not its job is known", async () => {
    const { app } = await setup();
    const sentence = must(notesOf(app).find((n) => n.state === "failed")?.error);
    expect(within(rowAt("price card")).getByText(sentence)).toBeInTheDocument();
    expect(within(rowAt("price card")).queryByText(FAILED_FALLBACK)).toBeNull();
  });

  it("says a failed request could not be made when neither it nor its job has a sentence", async () => {
    const app = await requestsApp(TIMELINE_VIDEOS.notes, undefined, {
      prepare: (backend) => {
        for (const note of must(backend.world.timelines[TIMELINE_VIDEOS.notes]).notes) {
          if (note.state === "failed") note.error = null;
        }
      },
    });
    app.mount(<RequestsPanel videoId={app.videoId} />);
    expect(within(rowAt("price card")).getByText(FAILED_FALLBACK)).toBeInTheDocument();
  });

  it("puts the note's sentence before its job's, and the job's before the fallback", () => {
    const note = { error: "Its own." } as TimelineNote;
    const job = { error: "The job's." } as JobView;
    expect(failureSentence(note, job)).toBe("Its own.");
    expect(failureSentence({ ...note, error: null }, job)).toBe("The job's.");
    expect(failureSentence({ ...note, error: null }, null)).toBe(FAILED_FALLBACK);
  });

  it("shows the full text on demand for a long request", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long);
    const long = `${"Make the whole intro calmer and slower. ".repeat(8)}The end.`;
    await addNote(app, 100, long);
    const row = must(rows()[0]);
    expect(within(row).queryByText(/The end\./)).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Show all" }));
    expect(within(row).getByText(long.trim())).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Show less" }));
    expect(within(row).queryByText(/The end\./)).toBeNull();
  });

  it("jumps to the frame and selects the request on a click", async () => {
    const { app, requests } = await setup();
    await userEvent.click(
      within(rowAt("price card")).getByRole("button", { name: /Make the price card/ }),
    );
    expect(app.driver.seeks).toEqual([215]);
    expect(app.playback.getState().frame).toBe(215);
    const note = must(notesOf(app).find((n) => n.frame === 215));
    expect(requests.getState().selectedId).toBe(note.id);
    expect(rowAt("price card")).toHaveAttribute("aria-current", "true");
    await userEvent.click(within(rowAt("sparkle")).getByRole("button", { name: "Go to 00:26:20" }));
    expect(app.driver.seeks).toEqual([215, 800]);
    expect(rowAt("price card")).not.toHaveAttribute("aria-current");
  });

  it("goes to the previous and next request around the playhead", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.notes, 300);
    await userEvent.click(screen.getByRole("button", { name: "Next request" }));
    expect(app.driver.seeks).toEqual([340]);
    await userEvent.click(screen.getByRole("button", { name: "Previous request" }));
    expect(app.driver.seeks).toEqual([340, 215]);
    act(() => {
      app.playback.report({ frame: 800 });
    });
    expect(screen.getByRole("button", { name: "Next request" })).toBeDisabled();
    act(() => {
      app.playback.report({ frame: 0 });
    });
    expect(screen.getByRole("button", { name: "Previous request" })).toBeDisabled();
  });
});

describe("delete and try again", () => {
  it("offers Delete only on a waiting request and Try Again only on a failed one", async () => {
    await setup();
    expect(within(rowAt("sparkle")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(rowAt("sparkle")).queryByRole("button", { name: "Try Again" })).toBeNull();
    expect(
      within(rowAt("price card")).getByRole("button", { name: "Try Again" }),
    ).toBeInTheDocument();
    expect(within(rowAt("price card")).queryByRole("button", { name: "Delete" })).toBeNull();
    for (const prefix of ["shadow", "slower swatch"]) {
      expect(within(rowAt(prefix)).queryByRole("button", { name: /Delete|Try Again/ })).toBeNull();
    }
  });

  it("deletes a waiting request", async () => {
    const { app } = await setup();
    await userEvent.click(within(rowAt("sparkle")).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(notesOf(app).some((n) => n.frame === 800)).toBe(false);
  });

  it("shows the server's sentence when a delete is refused because the request has started", async () => {
    const { app } = await setup();
    // The request starts between the click being possible and the server seeing it.
    const note = must(app.backend.world.timelines[app.videoId]?.notes.find((n) => n.frame === 800));
    note.state = "running";
    await userEvent.click(within(rowAt("sparkle")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a request that has not started yet can be deleted.",
    );
    expect(rows()).toHaveLength(4);
  });

  it("sends a failed request again, and it waits", async () => {
    const { app } = await setup();
    await userEvent.click(within(rowAt("price card")).getByRole("button", { name: "Try Again" }));
    await waitFor(() => {
      expect(within(rowAt("price card")).getByText("Waiting")).toBeInTheDocument();
    });
    expect(must(notesOf(app).find((n) => n.frame === 215)).state).toBe("pending");
  });
});

describe("the life of a request", () => {
  it("goes from waiting to being edited to done as the job runs", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long);
    await addNote(app, 100, "Sharpen the bottle");
    const state = () =>
      within(must(rows()[0])).queryByText(/^(Waiting|Working on it|Done|Failed)$/)?.textContent;
    expect(state()).toBe("Waiting");
    const seen = new Set<string | undefined>([state()]);
    for (let n = 0; n < 12 && state() !== "Done"; n += 1) {
      await app.tick();
      seen.add(state());
    }
    expect(state()).toBe("Done");
    expect(seen.has("Working on it")).toBe(true);
    expect(within(must(rows()[0])).getByText(/^Applied/)).toBeInTheDocument();
  });

  it("says in which revision a finished request was applied", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long);
    await addNote(app, 100, "Sharpen the bottle");
    for (let n = 0; n < 12 && !screen.queryByText("Done"); n += 1) await app.tick();
    await waitFor(() => {
      expect(within(must(rows()[0])).getByText(/^Applied in revision \d+$/)).toBeInTheDocument();
    });
  });

  it("shows the job's sentence on a failed request", async () => {
    const { app } = await setup(TIMELINE_VIDEOS.long);
    app.backend.world.failJobsWith = "The graphic g-1 has an error: a missing file.";
    await addNote(app, 100, "Sharpen the bottle");
    for (let n = 0; n < 12 && !screen.queryByText("Failed"); n += 1) await app.tick();
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(
      within(must(rows()[0])).getByText("The graphic g-1 has an error: a missing file."),
    ).toBeInTheDocument();
    expect(within(must(rows()[0])).getByRole("button", { name: "Try Again" })).toBeInTheDocument();
  });
});

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOG_ENTRIES, type JobKind, type JobState, type LogEntry } from "@/lib/types";
import { jobsControllerFor } from "@/features/jobs";
import { recordedApp } from "@/features/jobs/recordedApp";
import type { MockBackend, ScenarioName } from "@/lib/mock";
import { addJob } from "@/lib/mock/seed/jobs";
import { ADMIN_ID } from "@/lib/mock/seed/session";
import { ADMIN_CHANNEL_BEAUTY } from "@/lib/mock/seed/workspace";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { ActivityPanel } from "./ActivityPanel";
import { isAtBottom, logToText } from "./logFormat";
import { useActivityTab } from "./tabStore";

let env: TestApp;

async function openPanel(
  prefix: string,
  prepare?: SetupOptions["prepare"],
  scenarios: ScenarioName[] = ["default"],
): Promise<HTMLElement> {
  env = await setupApp(scenarios, { prepare });
  env.render(<ActivityPanel />);
  act(() => {
    env.store.getState().selectVideo(env.video(prefix).id);
  });
  return screen.findByRole("complementary", { name: "Activity" });
}

function logRows(): HTMLElement[] {
  return Array.from(screen.getByRole("log").querySelectorAll<HTMLElement>("[data-kind]"));
}

/** Changes the latest job of the video whose folder starts with `prefix`, before anything loads. */
function changeJob(
  prefix: string,
  change: (view: MockBackend["world"]["jobs"][0]["view"]) => void,
) {
  return (backend: MockBackend) => {
    for (const job of backend.world.jobs) {
      if (job.view.videoId.includes(`/${prefix}`)) change(job.view);
    }
  };
}

/** Puts a job of `kind` in `state` on a video of the beauty channel. */
function addBeautyJob(folderName: string, state: JobState, kind: JobKind, error?: string) {
  return (backend: MockBackend) => {
    addJob(
      backend.world,
      { channelId: ADMIN_CHANNEL_BEAUTY, folderName, userId: ADMIN_ID, state, kind, error },
      Date.now(),
    );
  };
}

beforeEach(() => {
  useActivityTab.getState().reset();
});

describe("ActivityPanel header", () => {
  it("renders nothing without a selection", async () => {
    env = await setupApp();
    const { container } = env.render(<ActivityPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the running job: status, clock, cost, line, program, service, model and buttons", async () => {
    const panel = await openPanel("Serum A", undefined, ["busy"]);
    const header = within(panel).getByRole("banner");
    expect(within(header).getByRole("heading", { name: "Serum A" })).toBeInTheDocument();
    expect(within(header).getByText("Editing")).toBeInTheDocument();
    // "Editing" already says what kind of job it is.
    expect(within(header).queryByText("Edit")).not.toBeInTheDocument();
    // 8 steps of 20 seconds, plus the 15 seconds the job has been running now.
    expect(within(header).getByLabelText("Active time")).toHaveTextContent(/^\d+m \d\ds$/);
    expect(within(header).getByLabelText("Cost")).toHaveTextContent("$0.32");
    expect(within(header).getByText("Queue").nextElementSibling).toHaveTextContent("Edits");
    expect(within(header).getByText("Program").nextElementSibling).toHaveTextContent("Claude Code");
    expect(within(header).getByText("Service").nextElementSibling).toHaveTextContent(
      "Claude Subscription",
    );
    expect(within(header).getByText("Model").nextElementSibling).toHaveTextContent("Default model");
    expect(within(header).getByRole("button", { name: "Pause Editing" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Stop Editing" })).toBeInTheDocument();
    // The job has no session id any more.
    expect(within(header).queryByText("Session")).not.toBeInTheDocument();
  });

  it("names the program and service of the job, and the model by the harness view", async () => {
    const panel = await openPanel(
      "Serum A",
      (backend) => {
        changeJob("Serum A", (view) => {
          view.setup = "opencodeGo";
          view.harness = "opencode2";
          view.model = "glm-5.3";
          view.effort = "high";
        })(backend);
        backend.world.harnessPublic = {
          setup: "opencodeGo",
          program: "opencode2",
          model: "glm-5.3",
          modelName: "GLM-5.3",
          effort: "high",
        };
      },
      ["busy"],
    );
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Program").nextElementSibling).toHaveTextContent("OpenCode 2");
    expect(within(header).getByText("Service").nextElementSibling).toHaveTextContent("OpenCode Go");
    expect(within(header).getByText("Model").nextElementSibling).toHaveTextContent(
      "GLM-5.3, High effort",
    );
  });

  it("keeps the job's own program and model when the admin has changed the model since", async () => {
    const panel = await openPanel(
      "Serum A",
      (backend) => {
        changeJob("Serum A", (view) => {
          view.setup = "anthropicApi";
          view.harness = "claudeCode";
          view.model = "claude-sonnet-5-5";
          view.effort = null;
        })(backend);
        backend.world.harnessPublic = {
          setup: "openaiApi",
          program: "opencode2",
          model: "gpt-5.3",
          modelName: "GPT 5.3",
          effort: "low",
        };
      },
      ["busy"],
    );
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Program").nextElementSibling).toHaveTextContent("Claude Code");
    expect(within(header).getByText("Service").nextElementSibling).toHaveTextContent(
      "Anthropic Compatible API",
    );
    expect(within(header).getByText("Model").nextElementSibling).toHaveTextContent(
      "claude-sonnet-5-5",
    );
  });

  it("shows the stage, the percent, the time left and a bar across the header", async () => {
    const panel = await openPanel(
      "Serum A",
      changeJob("Serum A", (view) => {
        view.progress = { percent: 33, stage: "Transcribing", secondsLeft: 245 };
      }),
      ["busy"],
    );
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Transcribing")).toBeVisible();
    expect(within(header).getByText(/About 5 min left/)).toBeVisible();
    expect(within(header).getByText("33%")).toBeVisible();
    const bar = within(header).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "33");
    expect(bar).toHaveAccessibleName(/^Progress of Serum A, Transcribing$/);
  });

  it("leaves out the time left when the server cannot tell it", async () => {
    const panel = await openPanel(
      "Serum A",
      changeJob("Serum A", (view) => {
        view.progress = { percent: 33, stage: "Transcribing", secondsLeft: null };
      }),
      ["busy"],
    );
    expect(within(panel).queryByText(/left$/)).not.toBeInTheDocument();
  });

  it("freezes the bar of a paused job and shows none for a video never edited", async () => {
    const panel = await openPanel("Serum D", undefined, ["busy"]);
    const bar = within(within(panel).getByRole("banner")).getByRole("progressbar");
    expect(bar).toHaveAttribute("data-tone", "muted");
    expect(bar).toHaveAttribute("aria-valuetext", expect.stringMatching(/^\d+%, paused$/));

    act(() => {
      env.store.getState().selectVideo(env.video("Draft Without").id);
    });
    await waitFor(() => {
      expect(within(screen.getByRole("banner")).queryByRole("progressbar")).toBeNull();
    });
  });

  it("says where a waiting job stands in line", async () => {
    const panel = await openPanel("Desk Lamp Review", undefined, ["urgent"]);
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Queued")).toBeInTheDocument();
    expect(within(header).getByText("Waiting, position 2")).toBeVisible();
    expect(within(header).queryByText("Urgent")).not.toBeInTheDocument();
    expect(within(header).getByText("Queue").nextElementSibling).toHaveTextContent("Edits");
    // A job that never ran has no clock, no cost and no time left.
    expect(within(header).queryByLabelText("Active time")).toBeNull();
    expect(within(header).queryByLabelText("Cost")).toBeNull();
    expect(within(header).getByRole("button", { name: "Stop Editing" })).toBeInTheDocument();
  });

  it("marks an Urgent job that waits, in front of the others", async () => {
    const panel = await openPanel("Webcam Comparison", undefined, ["urgent"]);
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Waiting, position 1")).toBeVisible();
    expect(within(header).getByText("Urgent")).toBeVisible();
  });

  it("says Starts in while the start delay holds an edit, and counts it down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      env = await setupApp(["start-delay"], { user: "user" });
      env.render(<ActivityPanel />);
      act(() => {
        env.store.getState().selectVideo(env.video("Held A").id);
      });
      const header = screen.getByRole("banner");
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(within(header).getByText(/^Waiting, position \d+$/)).toBeVisible();
      const timer = within(header).getByRole("timer");
      const first = timer.textContent;
      expect(first).toMatch(/^(Earliest start|Starts) in \d+ (min|s)$/);
      expect(screen.getByRole("heading", { name: "Waiting for the start delay" })).toBeVisible();
      await act(() => vi.advanceTimersByTimeAsync(31_000));
      expect(within(header).getByRole("timer").textContent).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the per-job cost only when the program reported one", async () => {
    const panel = await openPanel(
      "Serum A",
      changeJob("Serum A", (view) => {
        view.costUsd = null;
      }),
      ["busy"],
    );
    expect(within(panel).queryByLabelText("Cost")).toBeNull();
  });

  it("shows a render as Rendering in the Final renders queue", async () => {
    const panel = await openPanel(
      "Serum Launch",
      addBeautyJob("Serum Launch", "running", "render"),
    );
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Rendering")).toBeInTheDocument();
    expect(within(header).getByText("Queue").nextElementSibling).toHaveTextContent("Final renders");
  });

  it("runs the job buttons through the jobs controller", async () => {
    const panel = await openPanel("Serum A", undefined, ["busy"]);
    await userEvent.click(within(panel).getByRole("button", { name: "Pause Editing" }));
    await waitFor(() => {
      expect(within(panel).getByText("Pausing")).toBeInTheDocument();
    });
    // While pausing the server offers no actions.
    expect(within(panel).queryByRole("button", { name: "Stop Editing" })).not.toBeInTheDocument();

    act(() => {
      env.store.getState().selectVideo(env.video("Serum D").id);
    });
    await userEvent.click(await screen.findByRole("button", { name: "Stop Editing" }));
    expect(jobsControllerFor(env.backend, env.store).state.getState().dialog).toMatchObject({
      kind: "stop",
      video: { id: env.video("Serum D").id },
    });
  });

  it("pauses with the id of the job", async () => {
    const recorded = await recordedApp({ scenarios: ["busy"] });
    recorded.render(<ActivityPanel />);
    act(() => {
      recorded.store.getState().selectVideo(recorded.video("Serum A").id);
    });
    await userEvent.click(await screen.findByRole("button", { name: "Pause Editing" }));
    expect(recorded.calls("pauseJob")).toEqual([
      { jobId: recorded.video("Serum A").job?.id ?? "" },
    ]);
  });

  it("shows the job kind next to the status only when the status does not say it", async () => {
    const tagOf = (panel: HTMLElement) =>
      within(within(panel).getByRole("banner")).queryByText(
        /^(Edit|Re-Edit|Change requests|Final render)( stopped)?$/,
      )?.textContent ?? null;
    const cases = [
      ["Serum D", "Paused", "Edit"],
      ["Serum A", "Editing", null],
      ["Serum E", "Queued", "Edit"],
      ["Serum C", "Pausing", "Edit"],
    ] as const;
    await openPanel("Serum D", undefined, ["busy"]);
    for (const [prefix, status, tag] of cases) {
      act(() => {
        env.store.getState().selectVideo(env.video(prefix).id);
      });
      const panel = await screen.findByRole("complementary", { name: "Activity" });
      await waitFor(() => {
        expect(within(panel).getByRole("heading", { level: 2 })).toHaveTextContent(prefix);
      });
      expect(within(within(panel).getByRole("banner")).getByText(status)).toBeInTheDocument();
      expect(tagOf(panel)).toBe(tag);
    }
  });

  it("shows the server's sentence of a failed job with what to do next", async () => {
    const panel = await openPanel("Foundation Test");
    const header = within(panel).getByRole("banner");
    const alert = within(header).getByRole("alert");
    expect(alert).toHaveTextContent(
      "The editing program ran out of credit. Add credit, then continue.",
    );
    expect(alert).toHaveTextContent("Continue Editing resumes the same session");
    expect(within(header).getByText("Needs attention")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Continue Editing" })).toBeInTheDocument();
    expect(within(header).getByLabelText("Active time")).toHaveTextContent("1m 00s");
  });

  it("tells a usage limit to wait, in the words of the program that ran", async () => {
    const panel = await openPanel(
      "Foundation Test",
      changeJob("Foundation Test", (view) => {
        view.error = "The usage limit was reached. It resets at 4:30 PM.";
        view.harness = "opencode2";
        view.setup = "opencodeGo";
      }),
    );
    const alert = within(within(panel).getByRole("banner")).getByRole("alert");
    expect(alert).toHaveTextContent("The usage limit was reached. It resets at 4:30 PM.");
    expect(alert).toHaveTextContent(
      "Wait until the limit resets, then press Continue Editing. OpenCode 2 picks up in the same session.",
    );
  });

  it("shows a failed render with its own sentence and how to start it again", async () => {
    const panel = await openPanel(
      "Serum Launch",
      addBeautyJob("Serum Launch", "failed", "render", "A source file is missing: clip_04.mp4."),
    );
    const alert = within(within(panel).getByRole("banner")).getByRole("alert");
    expect(alert).toHaveTextContent("A source file is missing: clip_04.mp4.");
    expect(alert).toHaveTextContent("Render Final starts the render again from the first frame.");
  });

  it("explains a stopped job and what comes next", async () => {
    const panel = await openPanel("Mascara Quick Look");
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Stopped")).toBeInTheDocument();
    const note = within(header).getByRole("note");
    expect(note).toHaveTextContent("Editing was stopped.");
    expect(note).toHaveTextContent("Start Editing begins again.");
  });

  it("shows no queue line, clock or cost for a video without a job", async () => {
    const panel = await openPanel("Draft Without");
    const header = within(panel).getByRole("banner");
    expect(within(header).getByText("Not edited")).toBeInTheDocument();
    expect(within(header).queryByLabelText("Active time")).not.toBeInTheDocument();
    expect(within(header).queryByLabelText("Cost")).not.toBeInTheDocument();
    expect(within(header).queryByText("Queue")).not.toBeInTheDocument();
    expect(within(header).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ActivityPanel log", () => {
  it("renders log entries by kind, with nested sub-agent entries", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    await waitFor(() => {
      expect(logRows().length).toBe(8);
    });
    const kinds = new Set(logRows().map((row) => row.dataset.kind));
    expect(kinds).toEqual(new Set(["status", "assistant", "tool", "toolResult"]));
    expect(screen.getAllByText("Bash", { selector: "span" }).length).toBeGreaterThan(0);
  });

  it("shows nested sub-agent entries indented", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    await waitFor(() => {
      expect(logRows().length).toBe(8);
    });
    // The next steps of the script: the Task, then the three entries of its sub-agent.
    await act(async () => {
      await env.tick(6);
    });
    await waitFor(() => {
      expect(logRows().filter((row) => row.dataset.nested === "true")).toHaveLength(3);
    });
    const nested = logRows().filter((row) => row.dataset.nested === "true");
    expect(nested.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Glob\s*Broll\/\*\*\/\*\.mp4$/),
      expect.stringMatching(/37 files$/),
      expect.stringMatching(/Matched 22 of 24 beats/),
    ]);
  });

  it("loads the log of the job by its id and forgets it when the panel closes", async () => {
    const recorded = await recordedApp({ scenarios: ["busy"] });
    recorded.render(<ActivityPanel />);
    const video = recorded.video("Serum A");
    act(() => {
      recorded.store.getState().selectVideo(video.id);
    });
    await waitFor(() => {
      expect(recorded.store.getState().jobLogs[video.id]?.status).toBe("ready");
    });
    expect(recorded.calls("getJobLog")).toEqual([{ jobId: video.job?.id ?? "", after: null }]);
    await userEvent.click(await screen.findByRole("button", { name: "Close activity" }));
    expect(recorded.store.getState().jobLogs[video.id]).toBeUndefined();
  });

  it("appends live entries from job-log events", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    await waitFor(() => {
      expect(logRows()).toHaveLength(8);
    });
    await act(async () => {
      await env.tick();
    });
    await waitFor(() => {
      expect(logRows()).toHaveLength(9);
    });
    // One entry per line of the log, once each, in the order of their numbers.
    const seqs = env.store.getState().jobLogs[env.video("Serum A").id]?.entries.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps at most the last 5,000 entries and shows only a window of them", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    const video = env.video("Serum A");
    const job = video.job;
    if (!job) throw new Error("no job");
    await waitFor(() => {
      expect(logRows()).toHaveLength(8);
    });
    const entries: LogEntry[] = Array.from({ length: MAX_LOG_ENTRIES + 100 }, (_, i) => ({
      seq: 100 + i,
      ts: new Date(Date.UTC(2026, 10, 14, 10, 0, i)).toISOString(),
      kind: i % 2 === 0 ? "tool" : "toolResult",
      text: i % 2 === 0 ? `Bash: Step ${i + 1}` : `Result ${i + 1}`,
      detail: null,
      nested: i % 10 === 3,
    }));
    act(() => {
      env.store.getState().appendJobLog({ videoId: video.id, jobId: job.id, entries });
    });
    expect(env.store.getState().jobLogs[video.id]?.entries).toHaveLength(MAX_LOG_ENTRIES);
    await waitFor(() => {
      expect(screen.getByText(`Result ${MAX_LOG_ENTRIES + 100}`)).toBeInTheDocument();
    });
    expect(logRows().length).toBeLessThan(150);
    expect(screen.queryByText("Step 1")).not.toBeInTheDocument();
  });

  it("formats Markdown as text, links safely, and copies the original", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    const job = env.video("Serum A").job;
    if (!job) throw new Error("no job");
    const markdown =
      "## Plan\n\nUse **bold** and `code` and [the docs](javascript:alert(1)) or [the site](https://example.com/a).\n\n- one\n- two\n\n<img src=x onerror=alert(1)>";
    const entries: LogEntry[] = [
      {
        seq: 1,
        ts: "2026-11-14T10:00:00Z",
        kind: "assistant",
        text: markdown,
        detail: null,
        nested: false,
      },
    ];
    act(() => {
      env.store.setState((s) => ({
        jobLogs: {
          ...s.jobLogs,
          [job.videoId]: { jobId: job.id, entries, status: "ready", error: null },
        },
      }));
    });
    const log = await screen.findByRole("log");
    await waitFor(() => {
      expect(within(log).getByText("bold", { selector: "strong" })).toBeInTheDocument();
    });
    expect(within(log).getByText("code", { selector: "code" })).toBeInTheDocument();
    expect(within(log).getByText("Plan")).toHaveClass("font-semibold");
    expect(
      within(log)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["•one", "•two"]);
    expect(log.textContent).not.toMatch(/\*\*|`|##/);
    // Only web addresses are links, and they open in a new tab without a referrer.
    expect(log.querySelectorAll("a")).toHaveLength(1);
    const link = within(log).getByRole("link", { name: "the site" });
    expect(link).toHaveAttribute("href", "https://example.com/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(within(log).getByText("the docs")).toHaveAttribute("title", "javascript:alert(1)");
    // Markup in the text stays text.
    expect(log.querySelector("img")).toBeNull();
    expect(log).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(logToText(entries)).toContain(`Claude: ${markdown}`);
  });

  it("expands the detail of a tool call", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    const toggles = await screen.findAllByRole("button", { name: "Show details" });
    const first = toggles[0];
    if (!first) throw new Error("no detail toggle");
    await userEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    const detail = /"file_path": ".*\/MEMORY\.md"/;
    expect(screen.getByText(detail, { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeInTheDocument();
    await userEvent.click(first);
    expect(screen.queryByText(detail, { selector: "pre" })).not.toBeInTheDocument();
  });

  it("stops following when scrolled up and offers Jump to latest", async () => {
    await openPanel("Serum A", undefined, ["busy"]);
    await waitFor(() => {
      expect(logRows()).toHaveLength(8);
    });
    const viewport = screen
      .getByRole("log")
      .closest<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!viewport) throw new Error("no viewport");
    Object.defineProperty(viewport, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });

    // At the bottom: following, no button.
    viewport.scrollTop = 1600;
    fireEvent.scroll(viewport);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();

    // Scrolled up: the log stops following and offers the button.
    viewport.scrollTop = 900;
    fireEvent.scroll(viewport);
    const jump = await screen.findByRole("button", { name: /Jump to latest/ });
    await act(async () => {
      await env.tick(2);
    });
    await waitFor(() => {
      expect(jump).toHaveTextContent("2 new");
    });
    // New entries did not move the reader.
    expect(viewport.scrollTop).toBe(900);

    await userEvent.click(jump);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
    expect(viewport.scrollTop).toBe(2000);
  });

  it("shows a spinner while the log loads and an error with Try Again when it fails", async () => {
    const recorded = await recordedApp({ scenarios: ["busy"] });
    recorded.refuse("getJobLog", "io", "The server could not be reached.");
    recorded.render(<ActivityPanel />);
    act(() => {
      recorded.store.getState().selectVideo(recorded.video("Serum A").id);
    });
    expect(await screen.findByText("Could not load the log")).toBeVisible();
    expect(screen.getByText("The server could not be reached.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() => {
      expect(logRows()).toHaveLength(8);
    });
  });

  it("says when a queued job has no log yet", async () => {
    const panel = await openPanel("Serum E", undefined, ["busy"]);
    await waitFor(() => {
      expect(within(panel).getByRole("heading", { name: "Waiting for a free slot" })).toBeVisible();
    });
    expect(
      within(panel).getByText(/The log starts as soon as Claude Code starts working/),
    ).toBeVisible();
  });

  it("names OpenCode 2 in the empty log of a job that runs on it", async () => {
    const panel = await openPanel(
      "Serum E",
      changeJob("Serum E", (view) => {
        view.harness = "opencode2";
        view.setup = "opencodeGo";
      }),
      ["busy"],
    );
    await waitFor(() => {
      expect(within(panel).getByRole("heading", { name: "Waiting for a free slot" })).toBeVisible();
    });
    expect(within(panel).getByText(/as soon as OpenCode 2 starts working/)).toBeVisible();
  });

  it("shows an empty state for a video that was never edited", async () => {
    const panel = await openPanel("Draft Without");
    expect(within(panel).getByText("Not edited yet")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Start Editing" })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("tab", { name: "Outputs" }));
    expect(within(panel).getByText("No outputs yet")).toBeInTheDocument();
  });
});

describe("ActivityPanel frame", () => {
  it("remembers the tab the user chose for the next video", async () => {
    const panel = await openPanel("Serum Launch");
    // Never chosen: the edited video opens on Outputs.
    expect(within(panel).getByRole("tab", { name: "Outputs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(within(panel).getByRole("tab", { name: "Log" }));
    act(() => {
      env.store.getState().selectVideo(env.video("Draft Without").id);
    });
    expect(await within(panel).findByText("Not edited")).toBeInTheDocument();
    expect(within(panel).getByRole("tab", { name: "Log" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(within(panel).getByRole("tab", { name: "Outputs" }));
    act(() => {
      env.store.getState().selectVideo(env.video("Serum Launch").id);
    });
    expect(await within(panel).findByText("Edited")).toBeInTheDocument();
    expect(within(panel).getByRole("tab", { name: "Outputs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens a running job on its log", async () => {
    const panel = await openPanel("Serum A", undefined, ["busy"]);
    expect(within(panel).getByRole("tab", { name: "Log" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("closes with the close button and with Escape, clearing the selection", async () => {
    const panel = await openPanel("Serum A", undefined, ["busy"]);
    await userEvent.click(within(panel).getByRole("button", { name: "Close activity" }));
    expect(env.store.getState().selectedVideoId).toBeNull();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    act(() => {
      env.store.getState().selectVideo(env.video("Serum A").id);
    });
    const again = await screen.findByRole("complementary", { name: "Activity" });
    within(again).getByRole("tab", { name: "Log" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(env.store.getState().selectedVideoId).toBeNull();
  });

  it("says when the video is gone", async () => {
    const panel = await openPanel("Serum A", undefined, ["busy"]);
    act(() => {
      env.store.setState({ selectedVideoId: "nobody/Nothing" });
    });
    expect(await within(panel).findByText("This video is gone")).toBeVisible();
  });
});

describe("log helpers", () => {
  it("decides when the log is at its end", () => {
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 580 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 500 })).toBe(false);
  });

  it("copies the log as readable text", () => {
    const text = logToText([
      {
        seq: 1,
        ts: "2026-11-14T10:00:00Z",
        kind: "tool",
        text: "Bash: Probe",
        detail: "ffprobe a.mp4",
        nested: false,
      },
      {
        seq: 2,
        ts: "2026-11-14T10:00:05Z",
        kind: "assistant",
        text: "Done",
        detail: null,
        nested: true,
      },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Bash: Probe$/);
    expect(lines[1]).toMatch(/^\s+ffprobe a\.mp4$/);
    expect(lines[2]).toMatch(/ {6}Claude: Done$/);
  });
});

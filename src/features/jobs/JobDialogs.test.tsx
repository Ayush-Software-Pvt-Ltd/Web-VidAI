import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui";
import { DiskCleanupPage } from "@/features/disk";
import type { MockBackend } from "@/lib/mock";
import type { VideoAction, VideoView } from "@/lib/types";
import { JobDialogs } from "./JobDialogs";
import { recordedApp, type RecordedApp, type RecordedOptions } from "./recordedApp";
import { URGENT_HINT } from "./UrgentField";

type Env = RecordedApp;

async function setup(options: RecordedOptions = {}): Promise<Env> {
  const env = await recordedApp(options);
  env.render(<JobDialogs />);
  return env;
}

async function open(env: Env, prefix: string, action: VideoAction): Promise<VideoView> {
  const video = env.video(prefix);
  act(() => {
    env.controller.runJobAction(video, action);
  });
  await screen.findByRole(action === "stop" ? "alertdialog" : "dialog");
  return video;
}

/** A channel's prompt of the video's type, to make it empty or give it another text. */
function channelOf(backend: MockBackend, folderName: string) {
  const video = backend.world.videos.find((v) => v.folderName === folderName);
  const channel = backend.world.channels.find((c) => c.id === video?.channelId);
  if (!channel) throw new Error(`No channel for ${folderName}`);
  return channel;
}

const startButton = () =>
  within(screen.getByRole("dialog")).getByRole("button", { name: "Start Editing" });

describe("Start Editing", () => {
  it("sends the trimmed inputs, then starts the edit, and the row shows the job", async () => {
    const env = await setup();
    const inputs = () => env.calls("setVideoInputs");
    const start = () => env.calls("startEdit");
    const video = await open(env, "Hair Oil", "startEdit");
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Start Editing" });
    expect(dialog).toHaveTextContent("Hair Oil Review");
    expect(dialog).toHaveTextContent("Long 16:9");
    await user.type(
      within(dialog).getByLabelText(/Product links/),
      "  https://example.com/a  \n\nshop.example.in/p",
    );
    await user.type(within(dialog).getByLabelText(/Notes/), "  Keep it short.  ");
    await user.click(startButton());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(inputs()).toContainEqual({
      videoId: video.id,
      inputs: {
        productLinks: "https://example.com/a\nshop.example.in/p",
        notes: "Keep it short.",
        promptSlot: 0,
        styleSlot: 0,
      },
    });
    expect(start()).toContainEqual({ videoId: video.id, urgent: false });
    await waitFor(() => {
      expect(env.video("Hair Oil").job).not.toBeNull();
    });
    expect(env.video("Hair Oil").actions).toContain("stop");
  });

  it("fills in what was used last time, and falls back when a slot is no longer offered", async () => {
    const env = await setup({
      prepare: (backend) => {
        const video = backend.world.videos.find((v) => v.folderName === "Hair Oil Review");
        if (!video) throw new Error("seed changed");
        video.inputs = {
          productLinks: "https://example.com/aloe",
          notes: "Remembered note.",
          promptSlot: 3,
          styleSlot: 0,
        };
      },
    });
    const inputs = () => env.calls("setVideoInputs");
    await open(env, "Hair Oil", "startEdit");
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByLabelText(/Product links/)).toHaveValue(
        "https://example.com/aloe",
      );
    });
    expect(within(dialog).getByLabelText(/Notes/)).toHaveValue("Remembered note.");
    await userEvent.setup().click(startButton());
    await waitFor(() => {
      expect(inputs()).not.toHaveLength(0);
    });
    // Slot 3 of the prompts is empty, so the first offered prompt is sent.
    expect((inputs()[0] as { inputs: object }).inputs).toMatchObject({
      promptSlot: 0,
      styleSlot: 0,
    });
  });

  it("sends the remembered prompt slot while it is offered", async () => {
    const env = await setup({
      prepare: (backend) => {
        const channel = channelOf(backend, "Hair Oil Review");
        const slot = channel.long.prompts[2];
        if (slot) slot.text = "A second prompt.";
        const video = backend.world.videos.find((v) => v.folderName === "Hair Oil Review");
        if (video) video.inputs = { ...video.inputs, promptSlot: 2 };
      },
    });
    const inputs = () => env.calls("setVideoInputs");
    await open(env, "Hair Oil", "startEdit");
    await waitFor(() => {
      expect(screen.getByLabelText("Prompt")).toHaveTextContent(/./);
    });
    await userEvent.setup().click(startButton());
    await waitFor(() => {
      expect(inputs()).not.toHaveLength(0);
    });
    expect((inputs()[0] as { inputs: { promptSlot: number } }).inputs.promptSlot).toBe(2);
  });

  it("warns and keeps Start Editing off while the prompt of the channel is empty", async () => {
    const env = await setup({
      prepare: (backend) => {
        const slot = channelOf(backend, "Hair Oil Review").long.prompts[0];
        if (slot) slot.text = "";
      },
    });
    const start = () => env.calls("startEdit");
    await open(env, "Hair Oil", "startEdit");
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/prompt of .* is empty/);
    expect(startButton()).toBeDisabled();
    await userEvent.setup().keyboard("{Meta>}{Enter}{/Meta}");
    expect(start()).toHaveLength(0);
  });

  it("shows what is wrong with the links and does not start", async () => {
    const env = await setup();
    const start = () => env.calls("startEdit");
    await open(env, "Hair Oil", "startEdit");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Product links/), "hair oil");
    await user.click(startButton());
    expect(await screen.findByText(/does not look like a link/)).toBeInTheDocument();
    expect(start()).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("starts with Cmd+Enter, and a second press while it is on its way does nothing", async () => {
    const env = await setup();
    const start = () => env.calls("startEdit");
    await open(env, "Hair Oil", "startEdit");
    await waitFor(() => {
      expect(startButton()).toBeEnabled();
    });
    const user = userEvent.setup();
    await user.keyboard("{Meta>}{Enter}{Enter}{/Meta}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(start()).toHaveLength(1);
  });

  it("closes with Escape and with Cancel without starting anything", async () => {
    const env = await setup();
    const start = () => env.calls("startEdit");
    await open(env, "Hair Oil", "startEdit");
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await open(env, "Hair Oil", "startEdit");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(start()).toHaveLength(0);
  });

  it("shows the refusal of the server in the sheet and lets the user try again", async () => {
    const env = await setup();
    const start = () => env.calls("startEdit");
    env.refuse("startEdit", "conflict", "This video already has an edit.");
    await open(env, "Hair Oil", "startEdit");
    await waitFor(() => {
      expect(startButton()).toBeEnabled();
    });
    await userEvent.setup().click(startButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This video already has an edit.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => {
      expect(startButton()).toBeEnabled();
    });
    await userEvent.setup().click(startButton());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(start()).toHaveLength(2);
  });

  describe("Urgent", () => {
    it("is offered to a user who may mark an edit Urgent, with the hint, and is sent", async () => {
      const env = await setup({ user: "admin" });
      const start = () => env.calls("startEdit");
      await open(env, "Hair Oil", "startEdit");
      const dialog = screen.getByRole("dialog");
      const box = within(dialog).getByRole("checkbox", { name: "Urgent" });
      expect(box).toHaveAccessibleDescription(URGENT_HINT);
      expect(box).not.toBeChecked();
      await waitFor(() => {
        expect(startButton()).toBeEnabled();
      });
      const user = userEvent.setup();
      await user.click(box);
      await user.click(startButton());
      await waitFor(() => {
        expect(start()).toContainEqual({ videoId: env.video("Hair Oil").id, urgent: true });
      });
    });

    it("says the hint of SPEC section 16 word for word", () => {
      expect(URGENT_HINT).toBe(
        "Starts before the other waiting videos, after those already being edited and earlier urgent ones.",
      );
    });

    it("is not shown to a user who may not mark an edit Urgent, and is never sent", async () => {
      const env = await setup({ user: "user" });
      const start = () => env.calls("startEdit");
      await open(env, "Lisbon Day 1", "startEdit");
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(dialog).not.toHaveTextContent(URGENT_HINT);
      await waitFor(() => {
        expect(startButton()).toBeEnabled();
      });
      await userEvent.setup().click(startButton());
      await waitFor(() => {
        expect(start()).toContainEqual({
          videoId: env.video("Lisbon Day 1").id,
          urgent: false,
        });
      });
    });
  });

  describe("when the server cannot start edits", () => {
    const message = "Claude Code is not logged in on the server.";

    it("shows the server's sentence to an admin, with a link to the Admin area", async () => {
      const env = await setup({
        prepare: (backend) => {
          backend.world.readinessAdmin = { problem: "claudeLoggedOut", message };
        },
      });
      const start = () => env.calls("startEdit");
      await open(env, "Hair Oil", "startEdit");
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Claude Code not logged in")).toBeInTheDocument();
      expect(within(dialog).getByText(message)).toBeInTheDocument();
      expect(startButton()).toBeDisabled();
      await userEvent.setup().click(within(dialog).getByRole("button", { name: "Open Admin" }));
      expect(env.store.getState().view).toBe("admin");
      expect(env.store.getState().adminSection).toBe("system");
      expect(start()).toHaveLength(0);
    });

    it("opens the harness settings for a problem that is fixed there", async () => {
      const env = await setup({
        prepare: (backend) => {
          backend.world.readinessAdmin = {
            problem: "apiKeyMissing",
            message: "The key is missing.",
          };
        },
      });
      await open(env, "Hair Oil", "startEdit");
      await userEvent
        .setup()
        .click(within(screen.getByRole("dialog")).getByRole("button", { name: "Open Admin" }));
      expect(env.store.getState().adminSection).toBe("harness");
    });

    it("tells a user to ask the admin, without a link", async () => {
      const env = await setup({
        user: "user",
        prepare: (backend) => {
          backend.world.readinessUser = { problem: "claudeLoggedOut", message };
        },
      });
      await open(env, "Lisbon Day 1", "startEdit");
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText(/Claude Code is not logged in on the server\./),
      ).toBeInTheDocument();
      expect(dialog).toHaveTextContent("Ask your admin.");
      expect(within(dialog).queryByRole("button", { name: "Open Admin" })).not.toBeInTheDocument();
      expect(startButton()).toBeDisabled();
    });

    it("does not add a second ask when the server already says it", async () => {
      const env = await setup({
        user: "user",
        prepare: (backend) => {
          backend.world.readinessUser = {
            problem: "claudeLoggedOut",
            message: "Claude Code is not logged in. Ask an admin to fix it.",
          };
        },
      });
      await open(env, "Lisbon Day 1", "startEdit");
      expect(screen.getByRole("dialog")).not.toHaveTextContent("Ask your admin.");
    });

    it("keeps the button on for a server that is ready", async () => {
      const env = await setup();
      await open(env, "Hair Oil", "startEdit");
      await waitFor(() => {
        expect(startButton()).toBeEnabled();
      });
      expect(
        within(screen.getByRole("dialog")).queryByText(/not installed|not logged in/),
      ).toBeNull();
    });

    it("shows a refusal of the server that came after the page checked (notReady)", async () => {
      const env = await setup();
      env.refuse("startEdit", "notReady", "The server has not been prepared yet.");
      await open(env, "Hair Oil", "startEdit");
      await waitFor(() => {
        expect(startButton()).toBeEnabled();
      });
      await userEvent.setup().click(startButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The server has not been prepared yet.",
      );
    });
  });
});

describe("Re-Edit", () => {
  it("needs the text, sends it trimmed with the video id, and closes", async () => {
    const env = await setup();
    const reEdit = () => env.calls("reEdit");
    const video = await open(env, "Serum Launch", "reEdit");
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Re-Edit" });
    await user.click(within(dialog).getByRole("button", { name: "Re-Edit" }));
    expect(await within(dialog).findByText("Describe what should change.")).toBeInTheDocument();
    expect(reEdit()).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/What should change/), "  Shorter intro.  ");
    await user.click(within(dialog).getByRole("button", { name: "Re-Edit" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(reEdit()).toContainEqual({
      videoId: video.id,
      text: "Shorter intro.",
      urgent: false,
    });
  });

  it("offers Urgent only to a user who may, and sends it", async () => {
    const env = await setup({ user: "admin" });
    const reEdit = () => env.calls("reEdit");
    const video = await open(env, "Serum Launch", "reEdit");
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog");
    const box = within(dialog).getByRole("checkbox", { name: "Urgent" });
    expect(box).toHaveAccessibleDescription(URGENT_HINT);
    await user.click(box);
    await user.type(within(dialog).getByLabelText(/What should change/), "Louder music.");
    await user.click(within(dialog).getByRole("button", { name: "Re-Edit" }));
    await waitFor(() => {
      expect(reEdit()).toContainEqual({
        videoId: video.id,
        text: "Louder music.",
        urgent: true,
      });
    });
  });

  it("shows no Urgent checkbox to a user who may not mark an edit Urgent", async () => {
    const env = await setup({
      user: "user",
      prepare: (backend) => {
        // A finished edit of the user's, so Re-Edit is possible.
        const video = backend.world.videos.find((v) => v.folderName === "Lisbon Day 1");
        if (!video) return;
        video.edited = true;
        video.output = {
          ...video.output,
          project: { path: "Lisbon.fcpxmld", modifiedAt: Date.now() },
        };
      },
    });
    const video = env.video("Lisbon Day 1");
    act(() => {
      env.controller.runJobAction(video, "reEdit");
    });
    const dialog = await screen.findByRole("dialog", { name: "Re-Edit" });
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("refuses a text over 8000 characters before asking the server", async () => {
    const env = await setup();
    const reEdit = () => env.calls("reEdit");
    await open(env, "Serum Launch", "reEdit");
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText(/What should change/);
    await act(async () => {
      await userEvent.setup({ delay: null }).click(field);
      await userEvent.setup({ delay: null }).paste("a".repeat(8001));
    });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Re-Edit" }));
    expect(
      await within(dialog).findByText("Keep the text under 8000 characters."),
    ).toBeInTheDocument();
    expect(reEdit()).toHaveLength(0);
  });

  it("shows the refusal of the server in the sheet", async () => {
    const env = await setup();
    env.refuse("reEdit", "conflict", "A job is running on this video.");
    await open(env, "Serum Launch", "reEdit");
    const dialog = screen.getByRole("dialog");
    await userEvent.setup().type(within(dialog).getByLabelText(/What should change/), "x");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Re-Edit" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A job is running on this video.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Render Final", () => {
  const renderButton = () =>
    within(screen.getByRole("dialog")).getByRole("button", { name: "Render Final" });

  it("says what is rendered and names the sizes of a Long video", async () => {
    const env = await setup();
    await open(env, "Serum Launch", "renderFinal");
    const dialog = screen.getByRole("dialog", { name: "Render Final" });
    expect(dialog).toHaveTextContent("VidAI renders the video as it is in the timeline now.");
    expect(dialog).toHaveTextContent("1080p - 1920 x 1080");
    expect(within(dialog).getByRole("radio", { name: "1080p" })).toBeChecked();
    await userEvent.setup().click(within(dialog).getByRole("radio", { name: "4K" }));
    expect(dialog).toHaveTextContent("4K - 3840 x 2160");
    // No review software, timeline file or notes.
    expect(within(dialog).queryByLabelText(/Notes/)).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/Final Cut|Premiere|timeline file/i);
  });

  it("words the sizes for a Short video", async () => {
    const env = await setup();
    await open(env, "Earbuds Short", "renderFinal");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("1080p - 1080 x 1920");
    await userEvent.setup().click(within(dialog).getByRole("radio", { name: "4K" }));
    expect(dialog).toHaveTextContent("4K - 2160 x 3840");
  });

  it("sends 1080 by default and 2160 for 4K, with the video id", async () => {
    const env = await setup();
    const render = () => env.calls("renderFinal");
    const video = await open(env, "Serum Launch", "renderFinal");
    const user = userEvent.setup();
    await user.click(renderButton());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(render().at(-1)).toEqual({ videoId: video.id, resolution: 1080 });
    await waitFor(() => {
      expect(env.video("Serum Launch").job?.kind).toBe("render");
    });
  });

  it("sends 2160 when 4K is chosen", async () => {
    const env = await setup();
    const render = () => env.calls("renderFinal");
    const video = await open(env, "Serum Launch", "renderFinal");
    const user = userEvent.setup();
    await user.click(within(screen.getByRole("dialog")).getByRole("radio", { name: "4K" }));
    await user.click(renderButton());
    await waitFor(() => {
      expect(render()).toContainEqual({ videoId: video.id, resolution: 2160 });
    });
  });

  it.each([
    ["notReady", "The renderer is not prepared yet. Ask an admin to prepare it."],
    ["invalidInput", "The project did not pass its check: clip 3 has no media."],
    ["conflict", "A job is running on this video."],
  ] as const)(
    "shows the refusal %s as the server words it and keeps the sheet",
    async (code, text) => {
      const env = await setup();
      const render = () => env.calls("renderFinal");
      env.refuse("renderFinal", code, text);
      await open(env, "Serum Launch", "renderFinal");
      await userEvent.setup().click(renderButton());
      expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(text);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // The user can try again once the cause is gone.
      await userEvent.setup().click(renderButton());
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(render()).toHaveLength(2);
    },
  );

  it("refreshes the readiness after a notReady refusal", async () => {
    const env = await setup();
    env.refuse("renderFinal", "notReady", "The renderer is not prepared.");
    const readinessBefore = env.calls("getReadiness").length;
    await open(env, "Serum Launch", "renderFinal");
    await userEvent.setup().click(renderButton());
    await screen.findByRole("alert");
    await waitFor(() => {
      expect(env.calls("getReadiness").length).toBeGreaterThan(readinessBefore);
    });
  });
});

describe("Stop", () => {
  it("asks first, then stops the job by its own id and not by the video id", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const stop = () => env.calls("stopJob");
    const video = await open(env, "Serum A", "stop");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Stop editing?");
    expect(dialog).toHaveTextContent("The working files are kept");
    expect(stop()).toHaveLength(0);
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Stop Editing" }));
    await waitFor(() => {
      expect(stop()).toContainEqual({ jobId: video.job?.id });
    });
    expect(video.job?.id).not.toBe(video.id);
    expect(stop()).not.toContainEqual({ jobId: video.id });
  });

  it("offers to keep the job and does not stop it", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const stop = () => env.calls("stopJob");
    await open(env, "Serum A", "stop");
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep Editing" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(stop()).toHaveLength(0);
  });

  it("says that a waiting job will not start", async () => {
    const env = await setup({ scenarios: ["busy"] });
    await open(env, "Serum E", "stop");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove from the queue?");
    expect(dialog).toHaveTextContent("has not started yet and will not start");
    expect(within(dialog).getByRole("button", { name: "Keep in Queue" })).toBeInTheDocument();
  });

  it("words the stop of a final render for a render", async () => {
    const env = await setup({ scenarios: ["queue-full"] });
    await open(env, "Render A", "stop");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Stop rendering?");
    expect(dialog).toHaveTextContent("starts at the first frame");
    expect(within(dialog).getByRole("button", { name: "Stop Rendering" })).toBeInTheDocument();
  });

  it("words the stop of change requests: the project is put back", async () => {
    const env = await setup({ scenarios: ["queue-full"] });
    await open(env, "Timeline A", "stop");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      /put back as it was.*marked as failed/,
    );
  });
});

describe("Pause, continue and start now", () => {
  it("pauses and continues by the job id", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const pause = () => env.calls("pauseJob");
    const resume = () => env.calls("continueJob");
    const running = env.video("Serum A");
    act(() => {
      env.controller.runJobAction(running, "pause");
    });
    await waitFor(() => {
      expect(pause()).toContainEqual({ jobId: running.job?.id });
    });
    const paused = env.video("Serum D");
    act(() => {
      env.controller.runJobAction(paused, "continue");
    });
    await waitFor(() => {
      expect(resume()).toContainEqual({ jobId: paused.job?.id });
    });
  });

  it("ignores a second action on a video while one is in flight", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const pause = () => env.calls("pauseJob");
    const video = env.video("Serum A");
    act(() => {
      env.controller.runJobAction(video, "pause");
      env.controller.runJobAction(video, "pause");
    });
    expect(env.controller.state.getState().pending[video.id]).toBe("pause");
    await waitFor(() => {
      expect(env.controller.state.getState().pending[video.id]).toBeUndefined();
    });
    expect(pause()).toHaveLength(1);
  });

  it("shows the refusal of the server as a toast", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const error = vi.spyOn(toast, "error").mockImplementation(() => 0);
    env.refuse("pauseJob", "conflict", "This job already ended.");
    act(() => {
      env.controller.runJobAction(env.video("Serum A"), "pause");
    });
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Could not pause editing", "This job already ended.");
    });
  });

  it("lets an admin start a held edit now, by the job id", async () => {
    const env = await setup({
      prepare: (backend) => {
        backend.world.adminSettings.maxEditsPerUser = 0;
      },
    });
    await env.backend.startEdit({ videoId: env.video("Hair Oil").id, urgent: false });
    const held = await env.backend.startEdit({
      videoId: env.video("Night Cream").id,
      urgent: false,
    });
    expect(held.startsAt).not.toBeNull();
    await act(() => env.store.getState().refreshLibrary());
    const row = env.video("Night Cream");
    expect(row.actions).toContain("startNow");
    act(() => {
      env.controller.runJobAction(row, "startNow");
    });
    await waitFor(() => {
      expect(env.calls("adminStartJobNow")).toContainEqual({ jobId: held.id });
    });
    expect(held.id).not.toBe(row.id);
  });
});

describe("Actions that open another place", () => {
  it("opens the timeline for Review", async () => {
    const env = await setup();
    const video = env.video("Serum Launch");
    act(() => {
      env.controller.runJobAction(video, "review");
    });
    expect(env.store.getState().view).toBe("timeline");
    expect(env.store.getState().timelineVideoId).toBe(video.id);
  });

  it("opens Disk Cleanup, and asks the upload dialog's owner for Upload", async () => {
    const env = await setup();
    const video = env.video("Serum Launch");
    act(() => {
      env.controller.runJobAction(video, "upload");
    });
    expect(env.controller.state.getState().uploadFor).toBe(video.id);
    act(() => {
      env.controller.closeUpload();
      env.controller.runJobAction(video, "diskCleanup");
    });
    expect(env.controller.state.getState().uploadFor).toBeNull();
    expect(env.store.getState().view).toBe("diskCleanup");
  });

  it("opens Disk Cleanup with the confirmation for the video whose menu asked", async () => {
    const env = await setup();
    const video = env.video("Laptop Teardown");
    expect(video.actions).toContain("diskCleanup");
    act(() => {
      env.controller.runJobAction(video, "diskCleanup");
    });
    env.render(<DiskCleanupPage />);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Laptop Teardown")).toBeInTheDocument();
    expect(within(dialog).getByText(/This frees 3\.1 GB\./)).toBeInTheDocument();
  });
});

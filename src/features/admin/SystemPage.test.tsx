/**
 * Admin, System (SPEC sections 5 and 7): the facts the server found, each program missing,
 * Prepare from its press to done (driven by the mock's ticks, followed live through
 * `system-changed`), a step that fails, the button that is off while Prepare runs, a second admin
 * who sees the same run, and what a user gets.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { formatBytes } from "@/lib/format";
import type { ScenarioName } from "@/lib/mock";
import { prepareSim } from "@/lib/mock/seed/prepare";
import { renderApp, setupApp, type SetupOptions } from "@/test/app";
import { SystemPage } from "./SystemPage";

async function setup(scenarios?: ScenarioName[], options?: SetupOptions) {
  const app = await renderApp(<SystemPage />, scenarios, options);
  await screen.findByRole("region", { name: "Prepare" });
  return { user: userEvent.setup(), ...app };
}

const region = (name: string) => within(screen.getByRole("region", { name }));
const step = (label: string) => {
  const found = screen
    .getAllByTestId("prepare-step")
    .find((li) => within(li).queryByText(label) !== null);
  if (!found) throw new Error(`No step ${label}`);
  return found;
};
const prepareButton = () => screen.getByRole("button", { name: "Prepare" });

describe("The facts", () => {
  it("shows the server, its addresses, the data folder with its free space and the version", async () => {
    const { backend } = await setup();
    const { server, dataDir, addresses } = backend.world.system;
    const group = region("This server");
    expect(group.getByText(server.version)).toBeInTheDocument();
    expect(group.getByText(server.hostname)).toBeInTheDocument();
    expect(group.getByText(new RegExp(`Node.js ${server.node}`))).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "This server" })).toHaveTextContent(
      addresses[0] ?? "x",
    );
    expect(screen.getByRole("region", { name: "This server" })).toHaveTextContent(dataDir.path);
    expect(
      group.getByText(
        `${formatBytes(dataDir.freeBytes ?? 0)} free of ${formatBytes(dataDir.totalBytes ?? 0)}`,
      ),
    ).toBeInTheDocument();
    expect(group.getByRole("button", { name: "Copy the data folder path" })).toBeInTheDocument();
    expect(group.getByRole("button", { name: `Copy ${addresses[0] ?? "x"}` })).toBeInTheDocument();
  });

  it("says when the free space cannot be read and when there is no address", async () => {
    await setup(undefined, {
      prepare: (backend) => {
        backend.world.system.dataDir.freeBytes = null;
        backend.world.system.addresses = [];
      },
    });
    const group = region("This server");
    expect(group.getByText("The free space of its disk could not be read.")).toBeInTheDocument();
    expect(
      group.getByText("The server does not know an address it can be reached at."),
    ).toBeInTheDocument();
  });

  it("lists every program with its version and path, and the note the server gives", async () => {
    const { backend } = await setup();
    const group = region("Programs");
    for (const program of backend.world.system.programs) {
      expect(group.getByText(program.label)).toBeInTheDocument();
      expect(group.getByText(program.path ?? "x")).toBeInTheDocument();
    }
    expect(group.getAllByText("Found")).toHaveLength(backend.world.system.programs.length);
    expect(group.getByText("Hardware encoders found: nvenc.")).toBeInTheDocument();
    expect(group.getByText("Logged in")).toBeInTheDocument();
    expect(group.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the toolkit's version and where it lies", async () => {
    const { backend } = await setup();
    const { toolkit } = backend.world.system;
    const group = region("Toolkit");
    expect(group.getByText("Up to date")).toBeInTheDocument();
    expect(group.getByText("Version 1, the one this server ships.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Toolkit" })).toHaveTextContent(toolkit.folder);
    expect(screen.getByRole("region", { name: "Toolkit" })).toHaveTextContent(toolkit.python);
  });

  it("says when the toolkit needs an upgrade or could not be installed, and turns Prepare off", async () => {
    await setup(undefined, {
      prepare: (backend) => {
        const { toolkit } = backend.world.system;
        toolkit.installedVersion = null;
        toolkit.upToDate = false;
        toolkit.installError = "The data folder is read-only.";
      },
    });
    const group = region("Toolkit");
    expect(group.getByText("Not installed")).toBeInTheDocument();
    expect(group.getByText("The toolkit could not be installed")).toBeInTheDocument();
    expect(group.getByText("The data folder is read-only.")).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
  });

  it("shows the processor and graphics card limits in force", async () => {
    await setup(undefined, {
      prepare: (backend) => {
        backend.world.system.cpu = { processors: 12, running: 0, budget: 9 };
        backend.world.system.gpu = {
          total: 2,
          perJob: 1,
          slots: [
            { index: 0, jobId: "job-7", pid: 4242, at: Date.now(), ageMs: 90_000, state: "held" },
          ],
        };
      },
    });
    const group = region("Limits in force");
    expect(
      group.getByText("0 jobs run now and may use 9 of the 12 processors together."),
    ).toBeInTheDocument();
    expect(group.getByText("1 of 2 slots taken, 1 per job.")).toBeInTheDocument();
    expect(group.getByText(/Slot 1: in use, job job-7/)).toBeInTheDocument();
  });

  it("says when no graphics card slot is counted", async () => {
    await setup();
    expect(
      region("Limits in force").getByText("No graphics card slot is counted on this computer."),
    ).toBeInTheDocument();
  });
});

describe("Programs that are missing", () => {
  it("marks each one with the sentence the server gives, and the one no edit needs quietly", async () => {
    const { backend } = await setup(["system-problems"]);
    const group = region("Programs");
    for (const program of backend.world.system.programs.filter((p) => !p.found)) {
      expect(group.getByText(program.note ?? "x")).toBeInTheDocument();
    }
    expect(group.getAllByText("Not found")).toHaveLength(
      backend.world.system.programs.filter((p) => !p.found).length,
    );
    // New edits run with Claude Code, so OpenCode 2 is not needed.
    expect(group.getByText("Not needed while new edits run with Claude Code.")).toBeInTheDocument();
    expect(group.getAllByText(/Not needed while/)).toHaveLength(1);
  });

  it("makes Claude Code the quiet one when edits run with OpenCode 2", async () => {
    await setup(["setup-opencode-go", "system-problems"], {
      prepare: (backend) => {
        backend.world.system.programs = backend.world.system.programs.map((p) =>
          p.id === "claude"
            ? { ...p, found: false, path: null, version: null, note: "Claude Code was not found." }
            : p,
        );
      },
    });
    const group = region("Programs");
    await waitFor(() => {
      expect(
        group.getByText("Not needed while new edits run with OpenCode 2."),
      ).toBeInTheDocument();
    });
    // Its own note is shown, and the Claude login is not asked for.
    expect(group.getByText("Claude Code was not found.")).toBeInTheDocument();
    expect(group.queryByText("Claude login")).not.toBeInTheDocument();
  });

  it("says when Claude Code is not logged in, and where to log in", async () => {
    await setup(["not-ready"]);
    const group = region("Programs");
    expect(await group.findByText("Not logged in")).toBeInTheDocument();
    expect(group.getByText(/run claude in a terminal on it and sign in/)).toBeInTheDocument();
  });
});

describe("Prepare", () => {
  it("shows what is not possible while the environment is not prepared", async () => {
    await setup(["system-problems"]);
    const callout = screen.getByText("Edits cannot start yet").parentElement as HTMLElement;
    expect(callout).toHaveTextContent("Edits need every step up to the speech model.");
    for (const li of screen.getAllByTestId("prepare-step")) {
      expect(li).toHaveAttribute("data-state", "pending");
    }
    expect(within(step("Speech model")).getByText("Waiting")).toBeInTheDocument();
    expect(
      within(step("Speech model")).getByText("Edits cannot start until this step is done."),
    ).toBeInTheDocument();
    expect(
      within(step("Renderer browser")).getByText(
        "Render Final cannot run until this step is done.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Prepare log" })).toHaveTextContent(
      "Nothing has been printed yet.",
    );
    expect(prepareButton()).toBeEnabled();
  });

  it("runs from the press to done, step by step, and edits become possible", async () => {
    const { user, backend, tick } = await setup(["system-problems"]);
    await user.click(prepareButton());
    // It answers at once: the first step runs and the button is off.
    await waitFor(() => {
      expect(step("Python")).toHaveAttribute("data-state", "running");
    });
    expect(screen.getByText("Prepare is running")).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
    expect(backend.world.system.prepare.running).toBe(true);

    await tick(1);
    await waitFor(() => {
      expect(step("Python")).toHaveAttribute("data-state", "done");
    });
    expect(within(step("Python")).getByText(/Python 3\.12 at /)).toBeInTheDocument();
    expect(step("Python environment")).toHaveAttribute("data-state", "running");
    expect(screen.getByRole("log", { name: "Prepare log" })).toHaveTextContent(
      "== Python environment ==",
    );

    await tick(7);
    expect(await screen.findByText("Everything is prepared")).toBeInTheDocument();
    for (const li of screen.getAllByTestId("prepare-step")) {
      expect(li).toHaveAttribute("data-state", "done");
    }
    expect(backend.world.system.prepare.editReady).toBe(true);
    expect(backend.world.system.prepare.renderReady).toBe(true);
    expect(screen.getByRole("log", { name: "Prepare log" })).toHaveTextContent(
      "ok: The test render finished.",
    );
    await waitFor(() => {
      expect(prepareButton()).toBeEnabled();
    });
    expect(screen.queryByText("Prepare is running")).not.toBeInTheDocument();
  });

  it("does not start a second run while one runs", async () => {
    const { user, backend } = await setup(["system-problems"]);
    await user.click(prepareButton());
    await waitFor(() => {
      expect(prepareButton()).toBeDisabled();
    });
    const startedAt = backend.world.system.prepare.startedAt;
    await user.click(prepareButton());
    expect(backend.world.system.prepare.startedAt).toBe(startedAt);
  });

  it("stops at a failing step, says why and what it holds back, and the later steps wait", async () => {
    const { user, backend, tick } = await setup(["system-prepare-fails"]);
    await user.click(prepareButton());
    await tick(6);
    const callout = (await screen.findByText("Python packages failed"))
      .parentElement as HTMLElement;
    expect(callout).toHaveTextContent("Installing the Python packages failed.");
    expect(callout).toHaveTextContent("Edits cannot start until this step is done.");
    expect(callout).toHaveTextContent("Fix it, then press Prepare again.");
    expect(step("Python packages")).toHaveAttribute("data-state", "failed");
    expect(within(step("Python packages")).getByText("Failed")).toBeInTheDocument();
    // Steps that need the packages wait; the ones that do not carry on.
    expect(step("Toolkit check")).toHaveAttribute("data-state", "pending");
    expect(
      within(step("Toolkit check")).getByText('Waits for "Python packages".'),
    ).toBeInTheDocument();
    expect(step("Speech model")).toHaveAttribute("data-state", "pending");
    expect(step("Python")).toHaveAttribute("data-state", "done");
    expect(step("ffmpeg and ffprobe")).toHaveAttribute("data-state", "done");
    expect(screen.getByRole("log", { name: "Prepare log" })).toHaveTextContent(
      "FAILED: Installing the Python packages failed.",
    );
    expect(backend.world.system.prepare.editReady).toBe(false);
    // Nothing runs any more: Prepare can be pressed again.
    await waitFor(() => {
      expect(prepareButton()).toBeEnabled();
    });
    // Once what was wrong is fixed on the server, the same press succeeds.
    prepareSim(backend.world).failStep = null;
    await user.click(prepareButton());
    await tick(8);
    expect(await screen.findByText("Everything is prepared")).toBeInTheDocument();
    expect(screen.queryByText("Python packages failed")).not.toBeInTheDocument();
  });

  it("says that Render Final waits when only the renderer's steps are missing", async () => {
    await setup(undefined, {
      prepare: (backend) => {
        const { prepare } = backend.world.system;
        prepare.renderReady = false;
        prepare.steps = prepare.steps.map((s) =>
          s.blocks === "rendering" ? { ...s, state: "pending" as const, message: null } : s,
        );
      },
    });
    const callout = screen.getByText("Edits can start, Render Final cannot yet")
      .parentElement as HTMLElement;
    expect(callout).toHaveTextContent(
      "Render Final also needs the renderer browser and the test render.",
    );
  });

  it("follows a run another admin started, through the server's event", async () => {
    const first = await setup(["system-problems"]);
    // A second browser of the same server presses Prepare and the mock's clock moves.
    const second = await setupApp(["system-problems"], { world: first.backend.world });
    await second.backend.adminPrepareToolkit();
    await waitFor(() => {
      expect(step("Python")).toHaveAttribute("data-state", "running");
    });
    expect(prepareButton()).toBeDisabled();
    await first.tick(1);
    await waitFor(() => {
      expect(step("Python")).toHaveAttribute("data-state", "done");
    });
  });
});

describe("Who may see it", () => {
  it("gives a user the server's refusal and no facts or Prepare button", async () => {
    await renderApp(<SystemPage />, undefined, { user: "user" });
    expect(await screen.findByText("The System page could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Prepare" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "This server" })).not.toBeInTheDocument();
  });
});

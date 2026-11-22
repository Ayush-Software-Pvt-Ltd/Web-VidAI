/**
 * The Program group of Admin, Harness and Model (SPEC sections 5 and 7): what the selected setup
 * needs on the server's computer, as the server found it, and the sentences when it is missing,
 * logged out or not prepared. Nothing here installs or logs in: it is all read-only and says
 * plainly that those happen on the computer that runs VidAI.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockBackend, ScenarioName } from "@/lib/mock";
import { harnessSim, putKey, syncHarness } from "@/lib/mock/seed/harness";
import { renderApp, type SetupOptions } from "@/test/app";
import { HarnessPage } from "./HarnessPage";

async function setup(scenarios?: ScenarioName[], options?: SetupOptions) {
  const app = await renderApp(<HarnessPage />, scenarios, options);
  return { user: userEvent.setup(), ...app };
}

const program = async () => within(await screen.findByRole("region", { name: "Program" }));

const found = (backend: MockBackend, id: string) => {
  const info = backend.world.system.programs.find((p) => p.id === id);
  if (!info) throw new Error(`No program ${id}`);
  return info;
};

/** The server does not have the program (what `system-problems` does for OpenCode 2). */
const without = (id: string, note: string) => (backend: MockBackend) => {
  backend.world.system.programs = backend.world.system.programs.map((p) =>
    p.id === id ? { ...p, found: false, path: null, version: null, note } : p,
  );
  syncHarness(backend.world);
};

describe("The Program group", () => {
  it("shows Claude Code for the subscription, with its version, path and login", async () => {
    const { backend } = await setup(["setup-ready"]);
    const group = await program();
    expect(
      group.getByText(/New edits run with Claude Code on the computer that runs VidAI/),
    ).toBeInTheDocument();
    expect(await group.findByText("Installed")).toBeInTheDocument();
    const claude = found(backend, "claude");
    expect(group.getByText(new RegExp(`Version ${claude.version ?? "x"}`))).toBeInTheDocument();
    expect(group.getByText(claude.path ?? "x")).toBeInTheDocument();
    expect(group.getByText("Logged in")).toBeInTheDocument();
    expect(group.queryByText("OpenCode 2")).not.toBeInTheDocument();
    // Nothing to press: installing and logging in happen on the server's computer.
    expect(group.queryByRole("button")).not.toBeInTheDocument();
    expect(
      group.getByText(
        /Logging in cannot be done from this page: run claude in a terminal on that computer/,
      ),
    ).toBeInTheDocument();
  });

  it("says when Claude Code is logged out, with the server's sentence", async () => {
    const { backend } = await setup(["not-ready"]);
    const group = await program();
    expect(await group.findByText("Not logged in")).toBeInTheDocument();
    const callout = group.getByText("New edits cannot start yet").parentElement as HTMLElement;
    expect(callout).toHaveTextContent(backend.world.readinessAdmin.message ?? "x");
    expect(callout).toHaveTextContent("Run claude once in a terminal there and sign in.");
  });

  it("says Claude Code is missing, without an install button, and the login as unknown", async () => {
    await setup(["setup-ready"], {
      prepare: without(
        "claude",
        "Claude Code was not found. Install it on the computer that runs VidAI.",
      ),
    });
    const group = await program();
    expect(await group.findByText("Not installed")).toBeInTheDocument();
    expect(group.getByText("Claude Code is not installed")).toBeInTheDocument();
    expect(
      group.getByText(/Installing it happens on the computer that runs VidAI/),
    ).toBeInTheDocument();
    expect(group.getByText("Unknown")).toBeInTheDocument();
    expect(group.queryByRole("button")).not.toBeInTheDocument();
    expect(group.getByText("New edits cannot start yet")).toBeInTheDocument();
    expect(
      group.getAllByText(/Claude Code is not installed on the computer that runs VidAI/).length,
    ).toBeGreaterThan(0);
  });

  it("shows OpenCode 2, not Claude Code, for OpenCode Go", async () => {
    const { backend } = await setup(["setup-opencode-go"]);
    const group = await program();
    expect(
      group.getByText(/New edits run with OpenCode 2 on the computer that runs VidAI/),
    ).toBeInTheDocument();
    expect(await group.findByText("Installed")).toBeInTheDocument();
    expect(group.getByText(found(backend, "opencode").path ?? "x")).toBeInTheDocument();
    expect(group.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(group.queryByText("Claude login")).not.toBeInTheDocument();
  });

  it("says when OpenCode 2 is missing, with the sentence the server gives", async () => {
    const { backend } = await setup(["setup-opencode-go"], {
      prepare: without(
        "opencode",
        "OpenCode 2 was not found. Install it on the computer that runs VidAI.",
      ),
    });
    const group = await program();
    expect(await group.findByText("OpenCode 2 is not installed")).toBeInTheDocument();
    expect(group.getByText("Not installed")).toBeInTheDocument();
    expect(
      group.getByText("OpenCode 2 was not found. Install it on the computer that runs VidAI."),
    ).toBeInTheDocument();
    expect(group.getByText("New edits cannot start yet")).toBeInTheDocument();
    expect(group.getByText(backend.world.readinessAdmin.message ?? "x")).toBeInTheDocument();
    expect(group.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says when the computer is not prepared for edits yet, and where Prepare is", async () => {
    await setup(["setup-ready", "system-problems"]);
    const group = await program();
    const callout = (await group.findByText("New edits cannot start yet"))
      .parentElement as HTMLElement;
    expect(callout).toHaveTextContent(
      "The computer that runs VidAI is not prepared for edits yet.",
    );
    expect(callout).toHaveTextContent("Press Prepare in Admin, System.");
  });

  it("follows the setup chosen on the page", async () => {
    const { user } = await setup(["setup-ready"], {
      prepare: (backend) => {
        putKey(backend.world, "opencodeGo", "oc_sk_live_0123456789ab");
        backend.world.harness.options.opencodeGo.model = "glm-5.3";
        syncHarness(backend.world);
      },
    });
    const radio = await screen.findByRole("radio", { name: /OpenCode Go/ });
    await waitFor(() => {
      expect(radio).toBeEnabled();
    });
    expect((await program()).getByText(/with Claude Code/)).toBeInTheDocument();
    await user.click(radio);
    expect(await (await program()).findByText(/with OpenCode 2/)).toBeInTheDocument();
  });

  it.each([true, false])(
    "needs no Claude login while edits run on an Anthropic API (key saved: %s)",
    async (keySaved) => {
      const { backend } = await setup(["setup-anthropic-api"], {
        prepare: (b) => {
          harnessSim(b.world).claudeLoggedOut = true;
          if (!keySaved) putKey(b.world, "anthropicApi", null);
          syncHarness(b.world);
        },
      });
      const group = await program();
      expect(await group.findByText("Installed")).toBeInTheDocument();
      expect(group.queryByText("Claude login")).not.toBeInTheDocument();
      expect(group.queryByText("Not logged in")).not.toBeInTheDocument();
      expect(group.queryByText("New edits cannot start yet")).not.toBeInTheDocument();
      expect(backend.world.readinessAdmin.problem).toBeNull();
    },
  );
});

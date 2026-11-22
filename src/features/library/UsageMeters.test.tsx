import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockBackend } from "@/lib/mock";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import type { Setup } from "@/lib/types";
import { UsageMeters } from "./UsageMeters";

let app: TestApp;

async function setup(scenarios: Parameters<typeof setupApp>[0], options?: SetupOptions) {
  app = await setupApp(scenarios, options);
}

function renderMeters() {
  return app.render(<UsageMeters />);
}

/** The server runs edits on `setup` (the public harness state and the admin's own copy). */
function runOn(setup: Setup) {
  return (backend: MockBackend) => {
    const program = setup === "opencodeGo" || setup === "openaiApi" ? "opencode2" : "claudeCode";
    backend.world.harness = { ...backend.world.harness, setup, program };
    backend.world.harnessPublic = { ...backend.world.harnessPublic, setup, program };
  };
}

const claudeTrigger = () => screen.getByRole("button", { name: /^Usage limits/ });

function meterFill(name: string): HTMLElement {
  const meter = within(claudeTrigger()).getByRole("meter", { name });
  return meter.firstElementChild as HTMLElement;
}

describe("UsageMeters on the Claude subscription", () => {
  it("shows compact meters with normal tones below 70 %", async () => {
    await setup(["default"]);
    renderMeters();
    expect(claudeTrigger()).toHaveTextContent("5h21%");
    expect(claudeTrigger()).toHaveTextContent("Week33%");
    expect(claudeTrigger()).toHaveAttribute("data-tone", "normal");
    expect(meterFill("5-hour limit")).toHaveClass("bg-accent");
  });

  it("switches to warning from 70 % and critical from 90 % (scenario usage-critical)", async () => {
    await setup(["usage-critical"]);
    renderMeters();
    expect(meterFill("5-hour limit")).toHaveClass("bg-danger");
    expect(meterFill("Weekly limit")).toHaveClass("bg-warning");
    expect(claudeTrigger()).toHaveAttribute("data-tone", "critical");
  });

  it("opens details on click: whose usage it is, label, exact percent, reset time, Refresh", async () => {
    const user = userEvent.setup();
    await setup(["default"]);
    renderMeters();
    await user.click(claudeTrigger());
    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    expect(within(popover).getByText("Usage of the server's Claude subscription")).toBeVisible();
    expect(
      within(popover).getByText("Shared by everybody who edits on this server."),
    ).toBeVisible();
    expect(within(popover).getByText("5-hour limit")).toBeVisible();
    expect(within(popover).getByText("21% used")).toBeVisible();
    expect(within(popover).getByText(/^Resets .*, in 3h 1[12]m$/)).toBeVisible();
    expect(within(popover).getByText("Weekly limit (Opus)")).toBeVisible();
    expect(within(popover).getByText(/^Updated /)).toBeVisible();

    const asked = app.backend.world.usage.claude.fetchedAt ?? 0;
    await user.click(within(popover).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(app.store.getState().usage.data?.claude.fetchedAt).toBeGreaterThan(asked);
    });
  });

  it("is shown to a plain user as well: the usage is the server's and shared", async () => {
    await setup(["default"], { user: "user" });
    renderMeters();
    expect(claudeTrigger()).toHaveTextContent("5h21%");
  });

  it("renders nothing at all when the plan has no limits", async () => {
    await setup(["default"], {
      prepare: (backend) => {
        backend.world.usage.claude = {
          available: false,
          limits: [],
          fetchedAt: Date.now(),
          error: null,
        };
      },
    });
    const { container } = renderMeters();
    expect(container).toBeEmptyDOMElement();
  });

  it("holds the meters' place until Claude Code first answers, then shows them", async () => {
    await setup(["default"]);
    const answered = app.backend.world.usage.claude;
    app.backend.world.usage.claude = { available: false, limits: [], fetchedAt: null, error: null };
    await app.store.getState().loadUsage();
    renderMeters();
    const waiting = screen.getByRole("status", { name: "Loading the usage limits" });
    expect(waiting).toHaveTextContent("5h");
    expect(waiting).toHaveTextContent("Week");
    expect(screen.queryByRole("button", { name: /^Usage limits/ })).not.toBeInTheDocument();

    app.backend.world.usage.claude = answered;
    await act(async () => {
      await app.store.getState().loadUsage(true);
    });
    expect(await screen.findByRole("button", { name: /^Usage limits/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows no placeholder once the first answer failed", async () => {
    await setup(["default"]);
    app.backend.world.usage.claude = {
      available: false,
      limits: [],
      fetchedAt: null,
      error: "Claude Code is not logged in.",
    };
    await app.store.getState().loadUsage();
    const { container } = renderMeters();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the last refresh error in the details and keeps the limits", async () => {
    const user = userEvent.setup();
    await setup(["default"], {
      prepare: (backend) => {
        backend.world.usage.claude.error = "Claude Code did not answer.";
      },
    });
    renderMeters();
    await user.click(claudeTrigger());
    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    expect(
      within(popover).getByText("Last refresh failed: Claude Code did not answer."),
    ).toBeVisible();
    expect(within(popover).getByText("5-hour limit")).toBeVisible();
  });

  it("merges usage-updated from the server into the meters (usage drifts while jobs run)", async () => {
    const user = userEvent.setup();
    await setup(["busy"]);
    renderMeters();
    const before = app.store.getState().usage.data?.claude.limits[0]?.usedPercent ?? 0;
    expect(before).toBe(21);
    await app.tick(3);
    const after = app.store.getState().usage.data?.claude.limits[0]?.usedPercent ?? 0;
    expect(after).toBeGreaterThan(before);
    await user.click(claudeTrigger());
    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    expect(within(popover).getByText(/^21\.\d% used$/)).toBeVisible();
  });
});

describe("UsageMeters on OpenCode Go", () => {
  it("shows the OpenCode Go quota of the server, with a console link that opens a new tab", async () => {
    const user = userEvent.setup();
    await setup(["default"], { prepare: runOn("opencodeGo") });
    renderMeters();
    const trigger = await screen.findByRole("button", { name: /^Usage limits/ });
    expect(trigger).toHaveTextContent("5h34%");
    expect(trigger).toHaveTextContent("Month6%");
    await user.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    expect(
      within(popover).getByText("Usage of the server's OpenCode Go subscription"),
    ).toBeVisible();
    const console_ = within(popover).getByRole("link", { name: "Console" });
    expect(console_).toHaveAttribute("href", "https://opencode.ai/console");
    expect(console_).toHaveAttribute("target", "_blank");
    expect(console_).toHaveAttribute("rel", "noreferrer");
  });

  it("refreshes the OpenCode Go quota with Refresh", async () => {
    const user = userEvent.setup();
    await setup(["default"], { prepare: runOn("opencodeGo") });
    renderMeters();
    await user.click(await screen.findByRole("button", { name: /^Usage limits/ }));
    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    const asked = app.backend.world.usage.opencode?.fetchedAt ?? 0;
    await user.click(within(popover).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(app.store.getState().usage.data?.opencode?.fetchedAt).toBeGreaterThan(asked);
    });
  });

  it("says not available, with the server's reason, when OpenCode reports no limits", async () => {
    const user = userEvent.setup();
    await setup(["default"], {
      prepare: (backend) => {
        runOn("opencodeGo")(backend);
        backend.world.usage.opencode = {
          limits: [],
          unavailable:
            "OpenCode does not report usage to this API key. A key may need the Usage: Read permission.",
          fetchedAt: Date.now(),
          error: null,
        };
      },
    });
    renderMeters();
    expect(screen.queryByRole("button", { name: /^Usage limits/ })).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "OpenCode Go usage: not available" }),
    );
    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    expect(within(popover).getByText("Not available")).toBeVisible();
    expect(within(popover).getByText(/Usage: Read permission/)).toBeVisible();
    expect(within(popover).getByRole("link", { name: "Console" })).toBeVisible();
  });

  it("holds the place until OpenCode first answers", async () => {
    await setup(["default"], {
      prepare: (backend) => {
        runOn("opencodeGo")(backend);
        backend.world.usage.opencode = {
          limits: [],
          unavailable: null,
          fetchedAt: null,
          error: null,
        };
      },
    });
    renderMeters();
    expect(screen.getByRole("status", { name: "Loading the usage limits" })).toBeVisible();
  });

  it("never shows the Claude limits while edits run on OpenCode Go", async () => {
    await setup(["default"], { prepare: runOn("opencodeGo") });
    renderMeters();
    await screen.findByRole("button", { name: /^Usage limits/ });
    expect(screen.queryByText("Week33%")).not.toBeInTheDocument();
  });
});

describe("UsageMeters on a compatible API", () => {
  it.each(["anthropicApi", "openaiApi"] as const)(
    "shows nothing on %s: the plan behind it is not known",
    async (api) => {
      await setup(["default"], { prepare: runOn(api) });
      const { container } = renderMeters();
      expect(container).toBeEmptyDOMElement();
    },
  );
});

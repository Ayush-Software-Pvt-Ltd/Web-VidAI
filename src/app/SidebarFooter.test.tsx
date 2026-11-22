import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import type { MockBackend, ScenarioName } from "@/lib/mock";
import { PROBLEM_TITLES, problemFix } from "@/lib/readiness";
import type { ReadinessProblem } from "@/lib/types";
import { setupApp, type TestApp } from "@/test/app";
import { findMainPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";
import { SidebarFooter } from "./SidebarFooter";

async function renderFooter(
  scenarios: ScenarioName[] = ["default"],
  options: Parameters<typeof setupApp>[1] = {},
): Promise<TestApp> {
  const app = await setupApp(scenarios, options);
  app.render(<SidebarFooter />);
  return app;
}

const status = () => screen.getByRole("status");

/** What the server answers each audience while `problem` blocks new edits (its own wording). */
function blockedBy(problem: ReadinessProblem) {
  return (backend: MockBackend) => {
    backend.world.readinessAdmin = {
      problem,
      message: `Admin sentence for ${problem}. Fix it in Admin.`,
    };
    backend.world.readinessUser = { problem, message: `User sentence for ${problem}.` };
  };
}

describe("SidebarFooter status", () => {
  it("is ready to edit when the server says so", async () => {
    const user = userEvent.setup();
    await renderFooter();
    expect(status()).toHaveTextContent("Ready to edit");
    expect(screen.queryByRole("button", { name: "Check Again" })).not.toBeInTheDocument();
    await user.hover(status());
    expect((await screen.findAllByText("This server can start new edits.")).length).toBeGreaterThan(
      0,
    );
  });

  it("checks the server while the readiness is not known yet", async () => {
    await renderFooter(["default"], { load: false });
    // The usage meters wait with a status of their own, below the server's.
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Checking the server");
  });

  it("says the status is unavailable when the check itself failed", async () => {
    const app = await renderFooter();
    act(() => {
      app.store.setState({
        readiness: { data: null, status: "error", error: new ApiError("io", "No answer.") },
      });
    });
    expect(status()).toHaveTextContent("Status unavailable");
    expect(screen.getByRole("button", { name: "Check Again" })).toBeInTheDocument();
  });

  it.each(Object.keys(PROBLEM_TITLES) as ReadinessProblem[])(
    "tells an admin about %s with the server's sentence and a link to Admin",
    async (problem) => {
      const user = userEvent.setup();
      const app = await renderFooter(["default"], { prepare: blockedBy(problem) });
      expect(status()).toHaveTextContent(PROBLEM_TITLES[problem]);
      await user.hover(status());
      expect(
        (await screen.findAllByText(`Admin sentence for ${problem}. Fix it in Admin.`)).length,
      ).toBeGreaterThan(0);
      expect(screen.queryByText("Ask your admin.")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Open Admin" }));
      expect(app.store.getState().view).toBe("admin");
      expect(app.store.getState().adminSection).toBe(
        problemFix(problem) === "settings" ? "harness" : "system",
      );
    },
  );

  it.each(Object.keys(PROBLEM_TITLES) as ReadinessProblem[])(
    "tells a user about %s and to ask the admin, with no link",
    async (problem) => {
      const user = userEvent.setup();
      await renderFooter(["default"], { user: "user", prepare: blockedBy(problem) });
      expect(status()).toHaveTextContent(PROBLEM_TITLES[problem]);
      expect(screen.getByText("Ask your admin.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Open Admin" })).not.toBeInTheDocument();
      await user.hover(status());
      expect((await screen.findAllByText(`User sentence for ${problem}.`)).length).toBeGreaterThan(
        0,
      );
    },
  );

  it("shows the scenario not-ready to an admin and to a user", async () => {
    await renderFooter(["not-ready"]);
    expect(status()).toHaveTextContent("Claude Code not logged in");
    expect(screen.getByRole("button", { name: "Open Admin" })).toBeVisible();
  });

  it("checks again and turns ready after the admin fixed it", async () => {
    const user = userEvent.setup();
    const app = await renderFooter(["not-ready"], { user: "user" });
    expect(status()).toHaveTextContent("Claude Code not logged in");
    app.backend.world.readinessUser = { problem: null, message: null };
    await user.click(screen.getByRole("button", { name: "Check Again" }));
    await waitFor(() => {
      expect(status()).toHaveTextContent("Ready to edit");
    });
    expect(screen.queryByText("Ask your admin.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Again" })).not.toBeInTheDocument();
  });
});

describe("SidebarFooter counts", () => {
  it("shows nothing about counts while nothing runs or waits", async () => {
    await renderFooter();
    expect(screen.queryByText(/editing|waiting/)).not.toBeInTheDocument();
  });

  it("shows the admin's own jobs and, quietly, everybody's", async () => {
    await renderFooter(["busy"]);
    // Own: Serum A and B run, C is pausing (holds its slot), E and F wait, D is paused.
    expect(screen.getByText("3 editing, 2 waiting")).toBeVisible();
    expect(screen.getByText("Everybody: 3 editing, 3 waiting")).toBeVisible();
  });

  it("shows a user only their own jobs", async () => {
    await renderFooter(["busy"], { user: "user" });
    expect(screen.getByText("1 waiting")).toBeVisible();
    expect(screen.queryByText(/Everybody/)).not.toBeInTheDocument();
    expect(screen.queryByText(/editing/)).not.toBeInTheDocument();
  });

  it("leaves the second figure out for an admin when it would repeat the first", async () => {
    await renderFooter(["default"], {
      prepare: (backend) => {
        backend.world.jobs = [];
      },
    });
    expect(screen.queryByText(/Everybody/)).not.toBeInTheDocument();
  });

  it("does not load any admin data", async () => {
    const app = await renderFooter(["busy"]);
    expect(app.store.getState().adminQueue.status).toBe("idle");
    expect(app.store.getState().adminSystem.status).toBe("idle");
  });

  it("follows the queue as jobs finish", async () => {
    const app = await renderFooter(["busy"]);
    expect(screen.getByText("3 editing, 2 waiting")).toBeVisible();
    await app.tick(40);
    await waitFor(() => {
      expect(screen.queryByText("3 editing, 2 waiting")).not.toBeInTheDocument();
    });
  });
});

describe("SidebarFooter entries", () => {
  const entries = () =>
    within(screen.getByRole("navigation"))
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("offers Archive, Edit Log, Disk Cleanup, Settings and Admin to an admin", async () => {
    await renderFooter();
    expect(entries()).toEqual(["Archive", "Edit Log", "Disk Cleanup", "Settings", "Admin"]);
  });

  it("leaves Admin out for a user", async () => {
    await renderFooter(["default"], { user: "user" });
    expect(entries()).toEqual(["Archive", "Edit Log", "Disk Cleanup", "Settings"]);
  });

  it.each([
    ["Archive", "archive"],
    ["Edit Log", "editLog"],
    ["Disk Cleanup", "diskCleanup"],
    ["Settings", "settings"],
    ["Admin", "admin"],
  ] as const)("%s opens its page and is marked as the current page", async (label, view) => {
    const user = userEvent.setup();
    const app = await renderFooter();
    const entry = () => screen.getByRole("button", { name: new RegExp(`^${label}`) });
    expect(entry()).not.toHaveAttribute("aria-current");
    await user.click(entry());
    expect(app.store.getState().view).toBe(view);
    expect(entry()).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("button", { current: "page" })).toHaveLength(1);
  });

  it.each([
    ["Archive", "archive"],
    ["Edit Log", "editLog"],
    ["Disk Cleanup", "diskCleanup"],
  ] as const)("a second click on %s goes back to the video list", async (label, view) => {
    const user = userEvent.setup();
    const app = await renderFooter();
    await user.click(screen.getByRole("button", { name: label }));
    expect(app.store.getState().view).toBe(view);
    await user.click(screen.getByRole("button", { name: label }));
    expect(app.store.getState().view).toBe("main");
  });

  it("marks the page the store shows, whoever opened it", async () => {
    const app = await renderFooter();
    act(() => {
      app.store.getState().goTo({ view: "admin", section: "queue" });
    });
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-current", "page");
    act(() => {
      app.store.getState().goTo({ view: "main" });
    });
    expect(screen.queryByRole("button", { current: "page" })).not.toBeInTheDocument();
  });

  it("hints the Settings shortcut only where the browser leaves the key free", async () => {
    await renderFooter();
    // jsdom reads as a Mac: the browser keeps Cmd+, for its own settings.
    expect(screen.getByRole("button", { name: "Settings" }).querySelector("kbd")).toBeNull();

    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    await renderFooter();
    const settings = screen.getAllByRole("button", { name: /^Settings/ })[1];
    expect(settings?.querySelector("kbd")).toHaveTextContent("Ctrl,");
  });
});

describe("SidebarFooter parts", () => {
  it("shows the usage meters of the server", async () => {
    await renderFooter();
    expect(screen.getByRole("button", { name: /^Usage limits/ })).toBeVisible();
  });

  it("ends with the account menu, below the entries", async () => {
    await renderFooter(["default"], { user: "user" });
    const account = screen.getByRole("button", { name: "Account of user@example.com" });
    const nav = screen.getByRole("navigation");
    expect(nav.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no No Sleep checkbox, no install or login state and no program version", async () => {
    await renderFooter();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/No Sleep|installed|logged in|version/i)).not.toBeInTheDocument();
  });
});

const entry = (label: string) =>
  within(screen.getByRole("navigation", { name: /^Archive, Edit Log/ })).getByRole("button", {
    name: new RegExp(`^${label}`),
  });

describe("SidebarFooter focus", () => {
  it.each([
    ["Settings", "settings"],
    ["Admin", "admin"],
    ["Disk Cleanup", "diskCleanup"],
  ] as const)("gives focus back to %s when its page closes", async (label, view) => {
    const user = userEvent.setup();
    const app = await renderFooter();
    await user.click(entry(label));
    expect(app.store.getState().view).toBe(view);
    act(() => {
      entry("Archive").focus();
      app.store.getState().setView("main");
    });
    expect(entry(label)).toHaveFocus();
  });

  it("leaves focus alone when the page was not opened from an entry", async () => {
    const app = await renderFooter();
    act(() => {
      app.store.getState().goTo({ view: "admin", section: "queue" });
      entry("Archive").focus();
      app.store.getState().setView("main");
    });
    expect(entry("Archive")).toHaveFocus();
  });
});

describe("SidebarFooter focus in the whole app", () => {
  resetAddress();

  it.each(["Settings", "Admin", "Disk Cleanup"])(
    "%s closes with Esc and with Done, back to its entry",
    async (label) => {
      const { user } = await openApp();
      await findMainPage();
      for (const close of ["Escape", "Done"]) {
        await user.click(entry(label));
        expect(await screen.findByRole("button", { name: "Done" })).toBeInTheDocument();
        if (close === "Escape") await user.keyboard("{Escape}");
        else await user.click(screen.getByRole("button", { name: "Done" }));
        await findMainPage();
        await waitFor(() => {
          expect(entry(label)).toHaveFocus();
        });
      }
    },
  );
});

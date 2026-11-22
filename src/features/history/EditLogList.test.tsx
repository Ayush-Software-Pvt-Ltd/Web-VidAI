import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ADMIN_ID, USER_EMAIL, USER_ID } from "@/lib/mock/seed/session";
import { setupApp, type TestApp } from "@/test/app";
import { EditLogList } from "./EditLogList";

async function open(user: "admin" | "user" = "admin", prepare?: Parameters<typeof setupApp>[1]) {
  const app = await setupApp(["default"], { user, ...prepare });
  app.render(<EditLogList />);
  return app;
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Whose edits" }));
  await user.click(await screen.findByRole("option", { name }));
}

const rowsOf = () =>
  within(screen.getByRole("list", { name: "Edit log entries" })).getAllByRole("listitem");

function addEntries(app: TestApp, count: number) {
  const world = app.backend.world;
  const base = world.editLog.at(-1)?.id ?? 0;
  const first = world.editLog[0];
  if (!first) throw new Error("The seed has no edit log lines.");
  for (let n = 1; n <= count; n += 1) {
    world.editLog.push({
      id: base + n,
      at: Date.now() - n,
      userId: first.userId,
      userEmail: first.userEmail,
      videoLabel: `Channel / Bulk ${n}`,
      event: "started",
      message: `Bulk line ${n}`,
    });
  }
}

describe("EditLogList", () => {
  it("lists the entries newest first with the video, kind and message", async () => {
    await open();
    await screen.findByRole("list", { name: "Edit log entries" });
    const rows = rowsOf();
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]).toHaveTextContent("Tech Reviews / Laptop Teardown");
    expect(rows[0]).toHaveTextContent("Disk Cleanup");
    expect(rows[0]).toHaveTextContent("Disk Cleanup freed 4.2 GB");
    expect(rows.at(-1)).toHaveTextContent("Edit started (Claude Code, Opus)");
  });

  it("lists an admin's own lines first, with no email column", async () => {
    const app = await open("admin");
    await screen.findByRole("list", { name: "Edit log entries" });
    const mine = app.backend.world.editLog.filter((e) => e.userId === ADMIN_ID);
    expect(rowsOf()).toHaveLength(mine.length);
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Whose edits" })).toHaveTextContent("My edits");
  });

  it("shows everybody's lines with the email after choosing Everybody", async () => {
    const user = userEvent.setup();
    const app = await open("admin");
    await screen.findByRole("list", { name: "Edit log entries" });
    await choose(user, "Everybody");
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(app.backend.world.editLog.length);
    });
    const emails = rowsOf().filter((row) => /@example\.com/.test(row.textContent));
    expect(emails).toHaveLength(rowsOf().length);
    expect(app.store.getState().editLogFilter).toEqual({ kind: "all" });
  });

  it("offers the other users and lists only the chosen user's lines, with the email", async () => {
    const user = userEvent.setup();
    const app = await open("admin");
    await screen.findByRole("list", { name: "Edit log entries" });
    await user.click(screen.getByRole("combobox", { name: "Whose edits" }));
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(names).toEqual(["My edits", "Everybody", USER_EMAIL]);
    await user.click(screen.getByRole("option", { name: USER_EMAIL }));
    await waitFor(() => {
      expect(app.store.getState().editLogFilter).toEqual({ kind: "user", userId: USER_ID });
    });
    const theirs = app.backend.world.editLog.filter((e) => e.userId === USER_ID);
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(theirs.length);
    });
    for (const row of rowsOf()) expect(row).toHaveTextContent(USER_EMAIL);
    expect(screen.getByRole("combobox", { name: "Whose edits" })).toHaveTextContent(USER_EMAIL);
  });

  it("keeps the choice for Refresh and for older entries", async () => {
    const user = userEvent.setup();
    const app = await open("admin");
    await screen.findByRole("list", { name: "Edit log entries" });
    await choose(user, "Everybody");
    await act(async () => {
      addEntries(app, 130);
      await app.store.getState().loadEditLog();
    });
    await user.click(await screen.findByRole("button", { name: "Show older entries" }));
    await waitFor(() => {
      expect(app.store.getState().editLog.data?.entries.length).toBe(
        app.backend.world.editLog.length,
      );
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(app.store.getState().editLog.data?.entries).toHaveLength(100);
    });
    expect(app.store.getState().editLogFilter).toEqual({ kind: "all" });
  });

  it("shows a plain user no choice of whose lines and no email column", async () => {
    await open("user");
    await screen.findByRole("list", { name: "Edit log entries" });
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Whose edits" })).not.toBeInTheDocument();
  });

  it("says so when nothing is logged yet", async () => {
    await open("admin", {
      prepare: (backend) => {
        backend.world.editLog.length = 0;
      },
    });
    expect(await screen.findByText("Nothing logged yet")).toBeInTheDocument();
  });

  it("has no action for a text file", async () => {
    await open();
    await screen.findByRole("list", { name: "Edit log entries" });
    expect(screen.queryByText(/VidAI-edit-log|text file/i)).not.toBeInTheDocument();
  });

  it("pages: shows older entries on request and hides the button at the end", async () => {
    const user = userEvent.setup();
    const app = await open("admin");
    await screen.findByRole("list", { name: "Edit log entries" });
    await act(async () => {
      addEntries(app, 130);
      await app.store.getState().loadEditLog();
    });
    const more = await screen.findByRole("button", { name: "Show older entries" });
    expect(app.store.getState().editLog.data?.entries).toHaveLength(100);
    await user.click(more);
    await waitFor(() => {
      expect(app.store.getState().editLog.data?.entries.length).toBeGreaterThan(100);
    });
    expect(screen.queryByRole("button", { name: "Show older entries" })).not.toBeInTheDocument();
  });

  it("keeps the list virtual: a long log renders only a window of rows", async () => {
    const app = await open();
    await screen.findByRole("list", { name: "Edit log entries" });
    await act(async () => {
      addEntries(app, 400);
      await app.store.getState().loadEditLog();
    });
    await screen.findByRole("button", { name: "Show older entries" });
    expect(rowsOf().length).toBeLessThan(100);
  });

  it("reads the log again with Refresh", async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole("list", { name: "Edit log entries" });
    const before = rowsOf().length;
    addEntries(app, 2);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(rowsOf().length).toBe(before + 2);
    });
  });
});

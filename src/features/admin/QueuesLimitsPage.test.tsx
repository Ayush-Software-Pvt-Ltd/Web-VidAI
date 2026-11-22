import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ADMIN_ID } from "@/lib/mock/seed/session";
import { renderApp } from "@/test/app";
import { QueuesLimitsPage } from "./QueuesLimitsPage";

/** Opens a Select of the page by its label and picks an option. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function open(scenarios: Parameters<typeof renderApp>[1] = ["default"]) {
  const app = await renderApp(<QueuesLimitsPage />, scenarios);
  await screen.findByText("Pacing");
  return app;
}

describe("QueuesLimitsPage", () => {
  it("shows the saved values and says that saving applies at once", async () => {
    const app = await open();
    const s = app.backend.world.adminSettings;
    expect(screen.getByText(/Saving applies at once/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Edits" })).toHaveTextContent(String(s.maxEdits));
    expect(screen.getByLabelText("Delay between edit starts")).toHaveValue(
      String(s.startDelayMinutes),
    );
    expect(screen.getByLabelText("Retries after a model error")).toHaveValue(
      String(s.maxModelRetries),
    );
    expect(screen.getByRole("combobox", { name: "Processor, in total" })).toHaveTextContent(
      `${String(s.cpuTotalPercent)}%`,
    );
    // Nothing changed yet: no Save bar.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("offers 5 to 100 percent in steps of 5 and calls the graphics card numbers approximate", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("combobox", { name: "Processor, per edit" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(
      Array.from({ length: 20 }, (_, i) => `${String((i + 1) * 5)}%`),
    );
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("combobox", { name: "Graphics card, per edit (approximate)" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/graphics card numbers are approximate/)).toBeInTheDocument();
  });

  it("offers the ranges of the queues, with 0 meaning no limit per user", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("combobox", { name: "Renders" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: "Edits per user" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "No limit",
      ...Array.from({ length: 8 }, (_, i) => String(i + 1)),
    ]);
  });

  it("keeps a change as a draft until Save, then sends only what changed", async () => {
    const user = userEvent.setup();
    const app = await open();
    const before = { ...app.backend.world.adminSettings };
    await choose(user, "Renders", "2");
    const delay = screen.getByLabelText("Delay between edit starts");
    await user.clear(delay);
    await user.type(delay, "7");
    expect(app.backend.world.adminSettings).toEqual(before);
    expect(screen.getByRole("status")).toHaveTextContent("unsaved changes");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings).toEqual({
        ...before,
        maxRenders: 2,
        startDelayMinutes: 7,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    });
    expect(app.store.getState().adminSettings.data?.maxRenders).toBe(2);
    expect(screen.getByLabelText("Delay between edit starts")).toHaveValue("7");
  });

  it("puts the saved values back with Revert", async () => {
    const user = userEvent.setup();
    const app = await open();
    const saved = app.backend.world.adminSettings.maxModelRetries;
    const retries = screen.getByLabelText("Retries after a model error");
    await user.clear(retries);
    await user.type(retries, "3");
    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.getByLabelText("Retries after a model error")).toHaveValue(String(saved));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("says what is wrong with a number out of range and does not offer Save", async () => {
    const user = userEvent.setup();
    const app = await open();
    const before = app.backend.world.adminSettings.startDelayMinutes;
    const delay = screen.getByLabelText("Delay between edit starts");
    await user.clear(delay);
    await user.type(delay, "500");
    expect(await screen.findByText("Enter a whole number from 0 to 120.")).toBeInTheDocument();
    expect(delay).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(delay);
    await user.type(delay, "12.5");
    expect(screen.getByText("Enter a whole number from 0 to 120.")).toBeInTheDocument();
    await user.clear(delay);
    await user.type(delay, "30");
    expect(screen.queryByText("Enter a whole number from 0 to 120.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(app.backend.world.adminSettings.startDelayMinutes).toBe(before);
  });

  it("steps a number with the arrow keys and puts the saved value back with Esc", async () => {
    const user = userEvent.setup();
    const app = await open();
    const saved = app.backend.world.adminSettings.maxModelRetries;
    const retries = screen.getByLabelText("Retries after a model error");
    retries.focus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(retries).toHaveValue(String(saved + 2));
    await user.keyboard("{Escape}");
    expect(retries).toHaveValue(String(saved));
  });

  it.each([
    ["Processor, per edit", "Processor, in total", "cpuPerEditPercent", "cpuTotalPercent"],
    [
      "Graphics card, per edit (approximate)",
      "Graphics card, in total (approximate)",
      "gpuPerEditPercent",
      "gpuTotalPercent",
    ],
  ] as const)(
    "shows '%s' above its total as limited by the total, and saves it as typed",
    async (perEditLabel, totalLabel, perEditKey, totalKey) => {
      const user = userEvent.setup();
      const app = await open();
      const hint = () => screen.queryByText(/Limited by the total/);
      expect(hint()).not.toBeInTheDocument();
      await choose(user, totalLabel, "40%");
      await choose(user, perEditLabel, "80%");
      const note = await screen.findByText("Limited by the total: an edit gets at most 40%.");
      // It sits with the per-edit field (the label's column), not with the total.
      const row = screen.getByRole("combobox", { name: perEditLabel }).closest("div.flex-col");
      expect(row).toContainElement(note);
      // Raising the total to the value takes it away again.
      await choose(user, totalLabel, "80%");
      expect(hint()).not.toBeInTheDocument();
      await choose(user, totalLabel, "40%");
      expect(hint()).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(app.backend.world.adminSettings[totalKey]).toBe(40);
      });
      expect(app.backend.world.adminSettings[perEditKey]).toBe(80);
      expect(screen.queryByText("The changes were not saved")).not.toBeInTheDocument();
      expect(hint()).toBeInTheDocument();
    },
  );

  it("applies at once: more slots start the edits that wait", async () => {
    const user = userEvent.setup();
    const app = await open(["queue-full"]);
    const queued = () => app.backend.world.jobs.filter((j) => j.view.state === "queued").length;
    const running = () => app.backend.world.jobs.filter((j) => j.view.state === "running").length;
    const queuedBefore = queued();
    const runningBefore = running();
    expect(queuedBefore).toBeGreaterThan(0);
    // The per-user limit would keep some waiting; lift it, then add a slot.
    await choose(user, "Edits per user", "No limit");
    await choose(user, "Edits", String(app.backend.world.adminSettings.maxEdits + 2));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(running()).toBeGreaterThan(runningBefore);
    });
    expect(queued()).toBeLessThan(queuedBefore);
  });

  it("shows the server's refusal and keeps the draft", async () => {
    const user = userEvent.setup();
    const app = await open();
    const retries = screen.getByLabelText("Retries after a model error");
    await user.clear(retries);
    await user.type(retries, "9");
    // Another admin made this account a user meanwhile: the server refuses the save.
    const me = app.backend.world.users.find((u) => u.id === ADMIN_ID);
    if (me) me.role = "user";
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The changes were not saved")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("You are not allowed to do that.");
    expect(retries).toHaveValue("9");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows another admin's saved change without a reload and keeps what is being typed", async () => {
    const user = userEvent.setup();
    const app = await open();
    const delayBefore = app.backend.world.adminSettings.startDelayMinutes;
    const retries = screen.getByLabelText("Retries after a model error");
    const delay = screen.getByLabelText("Delay between edit starts");
    await user.clear(retries);
    await user.type(retries, "7");
    // A second admin saves two settings: the one being typed in and one that is not.
    await act(async () => {
      await app.backend.adminUpdateSettings({
        maxModelRetries: 12,
        startDelayMinutes: delayBefore + 3,
        maxEdits: 5,
      });
    });
    await waitFor(() => {
      expect(app.store.getState().adminSettings.data?.maxEdits).toBe(5);
    });
    // The field that was not touched follows the saved value at once.
    expect(delay).toHaveValue(String(delayBefore + 3));
    expect(screen.getByRole("combobox", { name: "Edits" })).toHaveTextContent("5");
    // The typed field keeps the draft; it still counts as a change and can be saved.
    expect(retries).toHaveValue("7");
    expect(screen.getByRole("status")).toHaveTextContent("You have unsaved changes.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings.maxModelRetries).toBe(7);
    });
    // Only the changed field was sent: the other admin's values stay.
    expect(app.backend.world.adminSettings.maxEdits).toBe(5);
    expect(app.backend.world.adminSettings.startDelayMinutes).toBe(delayBefore + 3);
  });
});

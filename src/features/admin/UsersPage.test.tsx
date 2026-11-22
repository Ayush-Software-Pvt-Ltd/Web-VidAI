import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui";
import { addUser } from "@/lib/mock/seed/admin";
import { ADMIN_EMAIL, ADMIN_ID, USER_EMAIL, USER_ID } from "@/lib/mock/seed/session";
import { renderApp, setupApp } from "@/test/app";
import { UsersPage } from "./UsersPage";

afterEach(() => {
  // A modal dialog that was still open when its test ended leaves this on <body>.
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

async function open(
  options: Parameters<typeof renderApp>[2] = {},
  scenarios: Parameters<typeof renderApp>[1] = ["default"],
) {
  const app = await renderApp(
    <>
      <UsersPage />
      <Toaster />
    </>,
    scenarios,
    options,
  );
  await screen.findByText(ADMIN_EMAIL);
  return app;
}

const row = (email: string) => {
  const found = screen.getAllByTestId("user-row").find((r) => r.textContent.includes(email));
  if (!found) throw new Error(`No row for ${email}`);
  return found;
};

describe("UsersPage: the list", () => {
  it("lists every account with its role, state and active edits", async () => {
    await open({
      prepare: (backend) => {
        addUser(backend.world, { email: "off@example.com", disabled: true });
      },
    });
    const me = row(ADMIN_EMAIL);
    expect(within(me).getByText("You")).toBeInTheDocument();
    expect(within(me).getByText("Admin")).toBeInTheDocument();
    const other = row(USER_EMAIL);
    expect(within(other).queryByText("You")).not.toBeInTheDocument();
    expect(within(other).queryByText("Admin")).not.toBeInTheDocument();
    expect(within(other).getByText(/active edit|no active edits/)).toBeInTheDocument();
    expect(within(row("off@example.com")).getByText("Disabled")).toBeInTheDocument();
    expect(within(row("off@example.com")).getByText(/Never signed in/)).toBeInTheDocument();
  });
});

describe("UsersPage: create", () => {
  it("creates an account (email cleaned up) and shows it in the list", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "New User" }));
    const dialog = await screen.findByRole("dialog", { name: "New user" });
    await user.type(within(dialog).getByLabelText("Email"), "  Maya@Example.com ");
    await user.type(within(dialog).getByLabelText("Password"), "a-long-password");
    await user.click(within(dialog).getByRole("button", { name: "Create User" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("maya@example.com")).toBeInTheDocument();
    const created = app.backend.world.users.find((u) => u.email === "maya@example.com");
    expect(created).toMatchObject({ role: "user", disabled: false, mayMarkUrgent: true });
  });

  it("creates an admin that may not mark edits urgent", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "New User" }));
    const dialog = await screen.findByRole("dialog", { name: "New user" });
    await user.type(within(dialog).getByLabelText("Email"), "boss@example.com");
    await user.type(within(dialog).getByLabelText("Password"), "a-long-password");
    await user.click(within(dialog).getByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "May mark edits as urgent" }));
    await user.click(within(dialog).getByRole("button", { name: "Create User" }));
    await screen.findByText("boss@example.com");
    expect(app.backend.world.users.find((u) => u.email === "boss@example.com")).toMatchObject({
      role: "admin",
      mayMarkUrgent: false,
    });
  });

  it("shows the password rule and the server's refusals at their fields", async () => {
    const user = userEvent.setup();
    const app = await open();
    const before = app.backend.world.users.length;
    await user.click(screen.getByRole("button", { name: "New User" }));
    const dialog = await screen.findByRole("dialog", { name: "New user" });
    expect(
      within(dialog).getByText("The password must have 8 to 200 characters."),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Email"), USER_EMAIL);
    await user.type(within(dialog).getByLabelText("Password"), "a-long-password");
    await user.click(within(dialog).getByRole("button", { name: "Create User" }));
    const emailError = await within(dialog).findByText(
      "An account with this email already exists.",
    );
    expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(emailError).toHaveAttribute("role", "alert");
    expect(emailError.id).toBe(
      within(dialog).getByLabelText("Email").getAttribute("aria-describedby"),
    );
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Email")).toHaveFocus();
    });
    expect(screen.getByRole("dialog", { name: "New user" })).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText("Email"));
    await user.type(within(dialog).getByLabelText("Email"), "new@example.com");
    await user.clear(within(dialog).getByLabelText("Password"));
    await user.type(within(dialog).getByLabelText("Password"), "short");
    await user.click(within(dialog).getByRole("button", { name: "Create User" }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    });
    expect(within(dialog).queryByText(/already exists/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Password")).toHaveFocus();
    });
    expect(within(dialog).getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
    expect(app.backend.world.users).toHaveLength(before);

    await user.clear(within(dialog).getByLabelText("Email"));
    await user.type(within(dialog).getByLabelText("Email"), "not-an-email");
    await user.click(within(dialog).getByRole("button", { name: "Create User" }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    });
  });

  it("never keeps a typed password after the dialog closed", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "New User" }));
    let dialog = await screen.findByRole("dialog", { name: "New user" });
    await user.type(within(dialog).getByLabelText("Password"), "secret-password");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "New User" }));
    dialog = await screen.findByRole("dialog", { name: "New user" });
    expect(within(dialog).getByLabelText("Password")).toHaveValue("");
    expect(document.body.textContent).not.toContain("secret-password");
    expect(within(dialog).getByLabelText("Password")).toHaveAttribute("type", "password");
  });
});

describe("UsersPage: edit", () => {
  it("changes the role and nothing else", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: `Edit ${USER_EMAIL}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit user" });
    expect(within(dialog).getByLabelText("Email")).toHaveValue(USER_EMAIL);
    expect(within(dialog).getByLabelText("New password")).toHaveValue("");
    await user.click(within(dialog).getByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(app.backend.world.users.find((u) => u.id === USER_ID)).toMatchObject({
      email: USER_EMAIL,
      role: "admin",
    });
    expect(within(row(USER_EMAIL)).getByText("Admin")).toBeInTheDocument();
  });

  it("signs the account out of its other browsers when its password is changed", async () => {
    const user = userEvent.setup();
    const admin = await open();
    const theirs = await setupApp(["default"], { user: "user", world: admin.backend.world });
    await user.click(screen.getByRole("button", { name: `Edit ${USER_EMAIL}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit user" });
    await user.type(within(dialog).getByLabelText("New password"), "another-password");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(theirs.store.getState().session.data?.user ?? null).toBeNull();
    });
    expect(admin.backend.world.users.find((u) => u.id === USER_ID)?.password).toBe(
      "another-password",
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("disables an account", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: `Edit ${USER_EMAIL}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit user" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Disabled" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(within(row(USER_EMAIL)).getByText("Disabled")).toBeInTheDocument();
    });
    expect(app.backend.world.users.find((u) => u.id === USER_ID)?.disabled).toBe(true);
  });

  it("refuses to make the last admin a user, at the role field", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: `Edit ${ADMIN_EMAIL}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit user" });
    await user.click(within(dialog).getByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "User" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const refusal = await within(dialog).findByText(/The last admin cannot be made a user/);
    expect(refusal).toHaveAttribute("role", "alert");
    await waitFor(() => {
      expect(within(dialog).getByRole("combobox", { name: "Role" })).toHaveFocus();
    });
    // The refusal is linked to the control, which says it is invalid.
    const role = within(dialog).getByRole("combobox", { name: "Role" });
    expect(role).toHaveAccessibleDescription(/The last admin cannot be made a user/);
    expect(role).toBeInvalid();
    expect(app.backend.world.users.find((u) => u.id === ADMIN_ID)?.role).toBe("admin");
  });

  it("refuses to disable the last admin, at the disabled field", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: `Edit ${ADMIN_EMAIL}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit user" });
    await user.click(within(dialog).getByRole("checkbox", { name: /Disabled/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/The last admin cannot be disabled/)).toHaveAttribute(
      "role",
      "alert",
    );
    await waitFor(() => {
      expect(within(dialog).getByRole("checkbox", { name: /Disabled/ })).toHaveFocus();
    });
    // The refusal is linked to the checkbox, which says it is invalid.
    const box = within(dialog).getByRole("checkbox", { name: /Disabled/ });
    expect(box).toHaveAccessibleDescription(/The last admin cannot be disabled/);
    expect(box).toBeInvalid();
  });
});

describe("UsersPage: delete", () => {
  it("says what deleting does, then removes the account", async () => {
    const user = userEvent.setup();
    const app = await open({}, ["busy"]);
    const jobsOfUser = app.backend.world.jobs.filter((j) => j.view.userId === USER_ID).length;
    expect(jobsOfUser).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: `Delete ${USER_EMAIL}` }));
    const dialog = await screen.findByRole("dialog", { name: `Delete ${USER_EMAIL}?` });
    expect(dialog).toHaveTextContent("signed out of every browser");
    expect(dialog).toHaveTextContent("running edits are stopped and waiting ones are removed");
    expect(dialog).toHaveTextContent("Its channels and its history are removed from VidAI");
    expect(dialog).toHaveTextContent("The folders and files on this computer are not deleted.");
    await user.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    await waitFor(() => {
      expect(screen.queryByText(USER_EMAIL)).not.toBeInTheDocument();
    });
    expect(app.backend.world.users.some((u) => u.id === USER_ID)).toBe(false);
    expect(app.backend.world.jobs.some((j) => j.view.userId === USER_ID)).toBe(false);
  });

  it("says when the account has no active edits and changes nothing on Cancel", async () => {
    const user = userEvent.setup();
    const app = await open({
      prepare: (backend) => {
        backend.world.jobs = [];
      },
    });
    await user.click(screen.getByRole("button", { name: `Delete ${USER_EMAIL}` }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This account has no active edits.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(app.backend.world.users.some((u) => u.id === USER_ID)).toBe(true);
  });

  it("shows the refusal of the last admin inside the dialog, which stays open", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: `Delete ${ADMIN_EMAIL}` }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This is your own account");
    await user.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The last admin cannot be deleted.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(app.backend.world.users.some((u) => u.id === ADMIN_ID)).toBe(true);
  });

  it("signs the deleted person out of their other browser", async () => {
    const user = userEvent.setup();
    const admin = await open();
    const theirs = await setupApp(["default"], { user: "user", world: admin.backend.world });
    expect(theirs.store.getState().session.data?.user?.id).toBe(USER_ID);
    await user.click(screen.getByRole("button", { name: `Delete ${USER_EMAIL}` }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    await waitFor(() => {
      expect(theirs.store.getState().session.data?.user ?? null).toBeNull();
    });
    await act(async () => {});
    expect(admin.store.getState().session.data?.user?.id).toBe(ADMIN_ID);
  });
});

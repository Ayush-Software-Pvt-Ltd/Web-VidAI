import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui";
import { renderApp, setupApp } from "@/test/app";
import { AccountMenu } from "./AccountMenu";
import { SetupPage } from "./SetupPage";
import { SignInPage } from "./SignInPage";

afterEach(() => {
  // A modal dialog that was still open when its test ended leaves this on <body>.
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  window.history.replaceState(null, "", "/");
});

describe("SignInPage", () => {
  it("is a real form for the password manager and signs in with Enter", async () => {
    const user = userEvent.setup();
    const app = await renderApp(<SignInPage />, ["signed-out"], { user: null });
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(email).toHaveAttribute("type", "email");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");
    expect(email.closest("form")).not.toBeNull();
    expect(email).toHaveFocus();
    expect(screen.getByText("Accounts are created by an administrator.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await user.type(email, " Admin@Example.com ");
    await user.type(password, "admin-password{Enter}");
    await waitFor(() => {
      expect(app.store.getState().session.data?.user?.email).toBe("admin@example.com");
    });
  });

  it("shows the server's sentence, keeps the email and focuses the password", async () => {
    const user = userEvent.setup();
    await renderApp(<SignInPage />, ["signed-out"], { user: null });
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is wrong.");
    expect(screen.getByLabelText("Email")).toHaveValue("admin@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("does not ask the server for an empty form", async () => {
    const user = userEvent.setup();
    const app = await renderApp(<SignInPage />, ["signed-out"], { user: null });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your email");
    expect(app.store.getState().session.data?.user).toBeNull();
  });

  it("is busy while it asks", async () => {
    const user = userEvent.setup();
    const app = await renderApp(<SignInPage />, ["signed-out"], { user: null });
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "admin-password");
    // The answer comes after this synchronous check, so the form is still waiting for it.
    fireEvent.submit(screen.getByLabelText("Email").closest("form") as HTMLFormElement);
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Email")).toBeDisabled();
    await waitFor(() => {
      expect(app.store.getState().session.data?.user).not.toBeNull();
    });
  });

  it("says why the session ended, above the form", async () => {
    const app = await setupApp(["default"]);
    app.store.getState().sessionEnded("disabled");
    app.render(<SignInPage />);
    const reason = screen.getByRole("status");
    expect(reason).toHaveTextContent("turned off");
    expect(reason.compareDocumentPosition(screen.getByLabelText("Email"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("SetupPage", () => {
  it("explains where the link is printed when the address has no token", async () => {
    await renderApp(<SetupPage />, ["needs-setup"], { user: null });
    expect(screen.getByRole("heading", { name: "Open the setup link" })).toBeInTheDocument();
    expect(screen.getByText(/printed in the window where VidAI was started/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("explains it too when the server refuses the token", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup#wrong-token");
    await renderApp(<SetupPage />, ["needs-setup"], { user: null });
    await user.type(screen.getByLabelText("Email"), "boss@example.com");
    await user.type(screen.getByLabelText("Password"), "long-enough-pw");
    await user.type(screen.getByLabelText("Password again"), "long-enough-pw{Enter}");
    expect(
      await screen.findByRole("heading", { name: "This setup link does not work" }),
    ).toBeInTheDocument();
  });

  it("shows the password rule, checks both entries and the server's rule at the field", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup#setup-token-for-tests");
    await renderApp(<SetupPage />, ["needs-setup"], { user: null });
    expect(screen.getByText("The password must have 8 to 200 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");

    await user.type(screen.getByLabelText("Email"), "boss@example.com");
    await user.type(screen.getByLabelText("Password"), "long-enough-pw");
    await user.type(screen.getByLabelText("Password again"), "different-pw{Enter}");
    expect(await screen.findByText("The two passwords are not the same.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Password"));
    await user.clear(screen.getByLabelText("Password again"));
    await user.type(screen.getByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Password again"), "short{Enter}");
    const refusal = await screen.findByText(/at least|must have 8 to 200/, { selector: "p[role]" });
    expect(refusal).toHaveTextContent("The password must have 8 to 200 characters.");
    // The server named the field: the sentence sits under it, described and focused.
    expect(refusal.id).toBe(screen.getByLabelText("Password").getAttribute("aria-describedby"));
    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toHaveFocus();
    });

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.clear(screen.getByLabelText("Password"));
    await user.clear(screen.getByLabelText("Password again"));
    await user.type(screen.getByLabelText("Password"), "long-enough-pw");
    await user.type(screen.getByLabelText("Password again"), "long-enough-pw{Enter}");
    const emailRefusal = await screen.findByText(/Enter a valid email address/);
    expect(emailRefusal.id).toBe(screen.getByLabelText("Email").getAttribute("aria-describedby"));
    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toHaveFocus();
    });
  });

  it("creates the admin, signs in and takes the token out of the address", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup#setup-token-for-tests");
    const app = await renderApp(<SetupPage />, ["needs-setup"], { user: null });
    await user.type(screen.getByLabelText("Email"), "boss@example.com");
    await user.type(screen.getByLabelText("Password"), "long-enough-pw");
    await user.type(screen.getByLabelText("Password again"), "long-enough-pw{Enter}");
    await waitFor(() => {
      expect(app.store.getState().session.data?.user?.role).toBe("admin");
    });
    expect(window.location.hash).toBe("");
  });
});

describe("AccountMenu", () => {
  it("shows the email and the admin role, and nothing when signed out", async () => {
    const user = userEvent.setup();
    const app = await renderApp(<AccountMenu />);
    await user.click(screen.getByRole("button", { name: "Account of admin@example.com" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Administrator")).toBeInTheDocument();
    expect(within(menu).getByText("admin@example.com")).toBeInTheDocument();
    app.unmount();

    const plain = await renderApp(<AccountMenu />, ["as-user"], { user: "user" });
    await user.click(screen.getByRole("button", { name: "Account of user@example.com" }));
    expect(within(await screen.findByRole("menu")).queryByText("Administrator")).toBeNull();
    plain.unmount();

    const out = await renderApp(<AccountMenu />, ["signed-out"], { user: null });
    expect(out.container).toBeEmptyDOMElement();
  });

  it("signs out", async () => {
    const user = userEvent.setup();
    const app = await renderApp(<AccountMenu />);
    await user.click(screen.getByRole("button", { name: /^Account of/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => {
      expect(app.store.getState().session.data?.user).toBeNull();
    });
    expect(app.store.getState().signedOutReason).toBeNull();
  });

  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /^Account of/ }));
    await user.click(await screen.findByRole("menuitem", { name: /^Change password/ }));
    return screen.findByRole("dialog", { name: "Change password" });
  }

  it("changes the password and says so", async () => {
    const user = userEvent.setup();
    const app = await renderApp(
      <>
        <AccountMenu />
        <Toaster />
      </>,
    );
    const dialog = await openDialog(user);
    expect(within(dialog).getByText("The password must have 8 to 200 characters.")).toBeVisible();
    await user.type(within(dialog).getByLabelText("Current password"), "admin-password");
    await user.type(within(dialog).getByLabelText("New password"), "another-password");
    await user.type(within(dialog).getByLabelText("New password again"), "another-password{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("Password changed")).toBeInTheDocument();
    expect(app.backend.world.users.find((u) => u.role === "admin")?.password).toBe(
      "another-password",
    );
  });

  it("shows a wrong current password at its field and a refused new one at its own", async () => {
    const user = userEvent.setup();
    await renderApp(<AccountMenu />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Current password"), "nope-nope-nope");
    await user.type(within(dialog).getByLabelText("New password"), "another-password");
    await user.type(within(dialog).getByLabelText("New password again"), "another-password{Enter}");
    const wrong = await within(dialog).findByText("The current password is wrong.");
    expect(wrong.id).toBe(
      within(dialog).getByLabelText("Current password").getAttribute("aria-describedby"),
    );
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Current password")).toHaveFocus();
    });

    await user.clear(within(dialog).getByLabelText("Current password"));
    await user.type(within(dialog).getByLabelText("Current password"), "admin-password");
    await user.clear(within(dialog).getByLabelText("New password"));
    await user.clear(within(dialog).getByLabelText("New password again"));
    await user.type(within(dialog).getByLabelText("New password"), "short");
    await user.type(within(dialog).getByLabelText("New password again"), "short{Enter}");
    const refused = await within(dialog).findByText("The password must have 8 to 200 characters.", {
      selector: "p[role]",
    });
    expect(refused.id).toBe(
      within(dialog).getByLabelText("New password").getAttribute("aria-describedby"),
    );
    await waitFor(() => {
      expect(within(dialog).getByLabelText("New password")).toHaveFocus();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("checks that the new password was typed twice, and starts empty each time", async () => {
    const user = userEvent.setup();
    await renderApp(<AccountMenu />);
    let dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Current password"), "admin-password");
    await user.type(within(dialog).getByLabelText("New password"), "another-password");
    await user.type(within(dialog).getByLabelText("New password again"), "other-password{Enter}");
    expect(await within(dialog).findByText("The two passwords are not the same.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    // Closing the dialog gives the focus back to the menu button a moment later; a menu opened
    // before that would be closed by it.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Account of/ })).toHaveFocus();
    });
    dialog = await openDialog(user);
    expect(within(dialog).getByLabelText("Current password")).toHaveValue("");
    expect(within(dialog).queryByText("The two passwords are not the same.")).toBeNull();
  });
});
